const CONTROL_PLANE_BASE_URL = "https://api.openai.com";
const EXTERNAL_URLS = Object.freeze({
  tunnels: "https://platform.openai.com/settings/organization/tunnels",
  apiKeys: "https://platform.openai.com/settings/organization/api-keys",
  chatgpt: "https://chatgpt.com/plugins",
  chatgptNewChat: "https://chatgpt.com/",
  chatgptSettings: "https://chatgpt.com/#settings/Connectors"
});
const DEFAULTS = {
  tunnelId: "",
  runtimeApiKey: "",
  onboardingCompleted: false,
  lastConnectionTest: null,
  agentPort: 17843,
  youtubeSearchCooldownUntil: 0,
  youtubeSearchCooldownLevel: 0
};
const EXTENSION_VERSION = "1.8.7";
const REQUIRED_AGENT_INTERFACE_VERSION = 6;
const AGENT_HEALTH_TIMEOUT_MS = 5_000;
const AGENT_TASK_TIMEOUT_MS = 10_000;
const AGENT_FORMAT_PROBE_TIMEOUT_MS = 55_000;
const POLL_RETRY_DELAY_MS = 250;
const SEARCH_MIN_START_INTERVAL_MS = 500;
const SEARCH_CACHE_TTL_MS = 5 * 60_000;
const SEARCH_COOLDOWN_STEPS_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000];
const SEARCH_DIAGNOSTIC_MAX_ENTRIES = 250;
const SEARCH_DIAGNOSTIC_MAX_QUERY_LENGTH = 360;
const COMMAND_DIAGNOSTIC_MAX_ENTRIES = 300;

let polling = false;
let currentPollPromise = null;
let pollLoopScheduled = false;
let pollLoopTimer = null;
let lastSearchStartedAt = 0;
let searchQueue = Promise.resolve();
let searchQueueDepth = 0;
let searchRequestSequence = 0;
let searchDiagnosticWrite = Promise.resolve();
let commandDiagnosticWrite = Promise.resolve();
const searchCache = new Map();

const nullableString = { type: ["string", "null"] };
const nullableInteger = { type: ["integer", "null"] };
const nullableNumber = { type: ["number", "null"] };

// A normalized, non-sensitive description of one stream currently advertised
// by YouTube for the selected video.  In particular, never expose the media
// URL, signatureCipher, expiry, or other short-lived playback credentials.
const downloadFormatSchema = {
  type: "object", additionalProperties: false,
  properties: {
    formatId: { type: "string", description: "YouTube stream identifier (itag) for this exact format snapshot. Pass it unchanged only when explicitly selecting this stream for download." },
    kind: { type: "string", enum: ["combined", "video", "audio"], description: "combined contains video and audio; video and audio are separate tracks." },
    container: { ...nullableString, description: "Media container announced by YouTube, for example mp4, webm, or m4a; null only if absent." },
    videoCodec: { ...nullableString, description: "Video codec identifier announced by YouTube, for example avc1, vp9, or av01; null for audio-only tracks." },
    audioCodec: { ...nullableString, description: "Audio codec identifier announced by YouTube, for example mp4a or opus; null for video-only tracks." },
    width: { ...nullableInteger, minimum: 0, description: "Encoded video width in pixels; null for audio-only tracks or when YouTube omits it." },
    height: { ...nullableInteger, minimum: 0, description: "Encoded video height in pixels; null for audio-only tracks or when YouTube omits it." },
    fps: { ...nullableNumber, minimum: 0, description: "Encoded video frames per second; null for audio-only tracks or when YouTube omits it." },
    bitrateBps: { ...nullableInteger, minimum: 0, description: "Advertised average or nominal stream bitrate in bits per second; null when YouTube omits it." },
    audioSampleRateHz: { ...nullableInteger, minimum: 0, description: "Audio sample rate in hertz; null when YouTube omits it or the track has no audio." },
    audioChannels: { ...nullableInteger, minimum: 0, description: "Number of audio channels; null when YouTube omits it or the track has no audio." },
    qualityLabel: { ...nullableString, description: "YouTube's human-readable quality label, for example 1080p; null when unavailable." },
    sizeBytes: { ...nullableInteger, minimum: 0, description: "Exact byte length of this individual source track when YouTube provides contentLength; otherwise null. For two manually selected tracks, their sum is a near-final output-size estimate before container overhead." }
  },
  required: ["formatId", "kind", "container", "videoCodec", "audioCodec", "width", "height", "fps", "bitrateBps", "audioSampleRateHz", "audioChannels", "qualityLabel", "sizeBytes"]
};

const downloadFormatsSchema = {
  type: "object", additionalProperties: false,
  properties: {
    available: { type: "boolean", description: "True when the current public YouTube player response exposed at least one usable media stream." },
    source: { type: "string", enum: ["youtube", "unavailable"], description: "youtube means the list came directly from the YouTube player response used for this video card. unavailable means YouTube did not expose a usable stream list." },
    message: { ...nullableString, description: "Why formats are unavailable, if known. It never contains media URLs, credentials, or local paths." },
    combined: { type: "array", items: downloadFormatSchema, description: "YouTube streams that already contain both video and audio and therefore do not need merging." },
    video: { type: "array", items: downloadFormatSchema, description: "YouTube video-only tracks. Pair one with an audio track to download and merge through ffmpeg." },
    audio: { type: "array", items: downloadFormatSchema, description: "YouTube audio-only tracks. They can be downloaded alone or paired with one video track." }
  },
  required: ["available", "source", "message", "combined", "video", "audio"]
};

// This is intentionally a separate schema from the browser-owned snapshot.
// The diagnostic tool has the same URL-free per-track shape, but its source is
// the current local yt-dlp invocation and it never replaces downloadFormats
// returned by youtube_get_video.
const ytDlpDownloadFormatsSchema = {
  ...downloadFormatsSchema,
  properties: {
    ...downloadFormatsSchema.properties,
    source: { type: "string", const: "ytDlp", description: "This diagnostic list was resolved by the currently configured local yt-dlp with the same Deno runtime and automatic YouTube client selection used by downloads." },
    message: { ...nullableString, description: "Explanation when yt-dlp could not return a comparable format list. It never exposes media URLs, credentials, command lines, or local paths." }
  }
};
const ytDlpFormatProbeDebugSchema = {
  type: "object", additionalProperties: false,
  properties: {
    command: { type: "array", items: { type: "string" }, description: "Exact local argv passed to yt-dlp. In debug mode it may include local executable paths." },
    exitCode: { type: ["integer", "null"], description: "yt-dlp process exit code; null only when the process could not start." },
    stdout: { type: "string", description: "Complete unmodified yt-dlp standard output for this one probe. It may include temporary media URLs and other local diagnostic data." },
    stderr: { type: "string", description: "Complete unmodified yt-dlp standard error for this one probe. It may include temporary media URLs and other local diagnostic data." }
  },
  required: ["command", "exitCode", "stdout", "stderr"]
};
const videoSearchItemSchema = {
  type: "object", additionalProperties: false,
  properties: {
    videoId: { type: "string" }, title: { type: "string" }, channel: { type: "string" },
    durationText: nullableString, publishedText: nullableString, views: nullableInteger, viewsText: nullableString, snippet: nullableString
  },
  required: ["videoId", "title", "channel", "durationText", "publishedText", "views", "viewsText", "snippet"]
};
const channelIdentitySchema = {
  type: "object", additionalProperties: false,
  properties: { id: nullableString, name: nullableString, handle: nullableString },
  required: ["id", "name", "handle"]
};
const channelVideoItemSchema = {
  type: "object", additionalProperties: false,
  properties: {
    videoId: { type: "string", description: "YouTube video ID for youtube_get_video, youtube_get_transcript, or youtube_get_comments." },
    title: { type: "string", description: "Public video title as displayed by YouTube." },
    channel: { ...nullableString, description: "Video owner name when present on the card; otherwise the known parent channel or playlist owner; null only if YouTube supplied neither." },
    position: { ...nullableInteger, minimum: 0, description: "Zero-based playlist item index supplied by YouTube; null for channel catalogues or when YouTube does not expose an index." },
    durationSeconds: { ...nullableInteger, minimum: 0, description: "Normalized duration derived from durationText; null for live, upcoming, or undisclosed-duration items." },
    durationText: { ...nullableString, description: "YouTube's displayed duration, normally H:MM:SS or M:SS; null when absent." },
    publishedAt: { ...nullableString, format: "date-time", description: "Absolute publication timestamp only when YouTube provides one in the catalogue; otherwise null. Do not infer it from publishedText." },
    publishedText: { ...nullableString, description: "YouTube's relative publication label, for example '3 days ago'; null when absent." },
    views: { ...nullableInteger, minimum: 0, description: "Integer view count parsed from viewsText; null when the catalogue does not display a count." },
    viewsText: { ...nullableString, description: "Original displayed view-count label from YouTube; retained alongside views." },
    isShort: { type: "boolean", description: "True only when the card is identified as a YouTube Short." },
    isLive: { type: "boolean", description: "True for live, upcoming, streamed, or premiered items indicated by YouTube." }
  },
  required: ["videoId", "title", "channel", "position", "durationSeconds", "durationText", "publishedAt", "publishedText", "views", "viewsText", "isShort", "isLive"]
};
const playlistItemSchema = {
  type: "object", additionalProperties: false,
  properties: {
    playlistId: { type: "string", description: "Public playlist ID accepted by youtube_get_playlist_videos." },
    title: { type: "string", description: "Public playlist title as displayed by YouTube." },
    videoCount: { ...nullableInteger, minimum: 0, description: "Integer playlist size parsed from videoCountText; null when YouTube does not display it." },
    videoCountText: { ...nullableString, description: "Original YouTube playlist-size label; retained alongside videoCount." },
    thumbnailUrl: { ...nullableString, format: "uri", description: "Public thumbnail URL when supplied by YouTube." }
  },
  required: ["playlistId", "title", "videoCount", "videoCountText", "thumbnailUrl"]
};
const playlistIdentitySchema = {
  type: "object", additionalProperties: false,
  properties: { id: { type: "string" }, title: nullableString, channelId: nullableString, channelName: nullableString },
  required: ["id", "title", "channelId", "channelName"]
};
const captionTrackSchema = {
  type: "object", additionalProperties: false,
  properties: { trackIndex: { type: "integer", minimum: 0 }, languageCode: nullableString, name: nullableString, isAutoGenerated: { type: "boolean" } },
  required: ["trackIndex", "languageCode", "name", "isAutoGenerated"]
};
const commentAuthorSchema = {
  type: "object", additionalProperties: false,
  properties: { name: nullableString, channelId: nullableString },
  required: ["name", "channelId"]
};
const commentSchema = {
  type: "object", additionalProperties: false,
  properties: {
    rank: { type: "integer", minimum: 1 }, commentId: { type: "string" }, author: commentAuthorSchema, text: { type: "string" },
    publishedAt: nullableString, publishedText: nullableString, likes: nullableInteger, likesText: nullableString,
    replyCount: nullableInteger, replyCountText: nullableString,
    isPinned: { type: "boolean" }, isHearted: { type: "boolean" }, hasReplies: { type: "boolean" },
    authorIsCreator: { type: "boolean" }, creatorReplied: { type: ["boolean", "null"] }
  },
  required: ["rank", "commentId", "author", "text", "publishedAt", "publishedText", "likes", "likesText", "replyCount", "replyCountText", "isPinned", "isHearted", "hasReplies", "authorIsCreator", "creatorReplied"]
};
const replySchema = {
  type: "object", additionalProperties: false,
  properties: {
    rank: { type: "integer", minimum: 1 }, commentId: { type: "string" }, author: commentAuthorSchema, text: { type: "string" },
    publishedAt: nullableString, publishedText: nullableString, likes: nullableInteger, likesText: nullableString,
    authorIsCreator: { type: "boolean" }, isHearted: { type: "boolean" }
  },
  required: ["rank", "commentId", "author", "text", "publishedAt", "publishedText", "likes", "likesText", "authorIsCreator", "isHearted"]
};
const commentParentSchema = {
  type: "object", additionalProperties: false,
  properties: {
    commentId: { type: "string" }, text: { type: "string" }, likes: nullableInteger, likesText: nullableString,
    replyCount: nullableInteger, replyCountText: nullableString
  },
  required: ["commentId", "text", "likes", "likesText", "replyCount", "replyCountText"]
};
const agentWorkspaceSchema = {
  type: "object", additionalProperties: false,
  properties: { status: { type: "string", enum: ["available", "error"] } },
  required: ["status"]
};
const agentComponentSchema = {
  type: "object", additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["available", "missing", "error"] },
    version: nullableString,
    source: { anyOf: [{ type: "string", enum: ["local", "path"] }, { type: "null" }] },
    message: nullableString
  },
  required: ["status", "version", "source", "message"]
};
const agentStatusSchema = {
  type: "object", additionalProperties: false,
  properties: {
    available: { type: "boolean", description: "Whether the optional Local Agent responded on the configured loopback port." },
    error: nullableString,
    message: { type: "string" },
    status: nullableString,
    extensionVersion: { type: "string", description: "ResearchTube Chrome Extension implementation version that is serving this MCP response." },
    extensionInterfaceVersion: { type: "integer", minimum: 1, description: "Extension ↔ Agent interface version required by this Extension." },
    agentVersion: nullableString,
    interfaceVersion: { ...nullableInteger, minimum: 1, description: "Local Agent interface version. null means the response did not contain a readable positive integer, so the Agent is not accepted for Agent tools." },
    workspace: { anyOf: [agentWorkspaceSchema, { type: "null" }] },
    components: {
      anyOf: [{
        type: "object", additionalProperties: false,
        properties: { ytDlp: agentComponentSchema, deno: agentComponentSchema, ffmpeg: agentComponentSchema, ffprobe: agentComponentSchema },
        required: ["ytDlp", "deno", "ffmpeg", "ffprobe"]
      }, { type: "null" }]
    }
  },
  required: ["available", "error", "message", "status", "extensionVersion", "extensionInterfaceVersion", "agentVersion", "interfaceVersion", "workspace", "components"]
};
const youtubeDownloadResultSchema = {
  type: "object", additionalProperties: false,
  properties: {
    videoId: { type: "string", description: "YouTube video ID requested for download." },
    filePath: { type: "string", description: "Path relative to the Local Agent workspace; it never exposes an arbitrary system path." },
    fileName: { type: "string", description: "Sanitized downloaded filename, including [yt_<videoId>] and the task ID." },
    outputDir: { type: "string", description: "Workspace-relative output directory used for this download." }
  },
  required: ["videoId", "filePath", "fileName", "outputDir"]
};
const downloadSelectionValueSchema = {
  anyOf: [
    { type: "string", enum: ["best"] },
    { type: "string", pattern: "^[0-9]+$" },
    { type: "null" }
  ]
};
const downloadSelectionSchema = {
  type: "object", additionalProperties: false,
  properties: {
    combined: { ...downloadSelectionValueSchema, description: "One ready-made audio+video track: 'best' or a numeric formatId from downloadFormats.combined. Do not set video or audio at the same time." },
    video: { ...downloadSelectionValueSchema, description: "One video-only track: 'best' or a numeric formatId from downloadFormats.video." },
    audio: { ...downloadSelectionValueSchema, description: "One audio-only track: 'best' or a numeric formatId from downloadFormats.audio." }
  },
  description: "Select exactly one mode: combined alone; video alone; audio alone; or video plus audio. With video plus audio the Agent merges the exact tracks into MP4 without re-encoding."
};
const downloadPhaseSchema = {
  type: "string",
  enum: ["preparing", "downloadingCombined", "downloadingVideo", "downloadingAudio", "merging", "completed", "failed", "cancelled"]
};
const downloadTaskErrorSchema = {
  type: "object", additionalProperties: false,
  properties: { code: { type: "string" }, message: { type: "string" }, detail: nullableString },
  required: ["code", "message", "detail"]
};
const youtubeDownloadStartSchema = {
  type: "object", additionalProperties: false,
  properties: {
    taskId: { type: "string", description: "Opaque Local Agent download task ID. Pass it unchanged to youtube_get_download_task or youtube_cancel_download_task." },
    status: { type: "string", enum: ["working"], description: "The download has been created and is running asynchronously." },
    statusMessage: { type: "string" },
    phase: { ...downloadPhaseSchema, description: "Current yt-dlp operation phase. A new task begins in preparing." },
    createdAt: { type: "string", format: "date-time" },
    lastUpdatedAt: { type: "string", format: "date-time", description: "The time of the most recent progress, lifecycle, or liveness-heartbeat update." },
    pollIntervalMs: { type: "integer", minimum: 100, description: "Suggested minimum interval before calling youtube_get_download_task again." },
    progressPercent: { type: ["number", "null"], minimum: 0, maximum: 100, description: "Percent of the current phase; null while preparing. It is 100 once the task is completed." }
  },
  required: ["taskId", "status", "statusMessage", "phase", "createdAt", "lastUpdatedAt", "pollIntervalMs", "progressPercent"]
};
const youtubeDownloadTaskSchema = {
  type: "object", additionalProperties: false,
  properties: {
    taskId: { type: "string" },
    status: { type: "string", enum: ["working", "completed", "failed", "cancelled"] },
    statusMessage: { type: "string" },
    phase: { ...downloadPhaseSchema, description: "Current task operation. A video+audio download normally advances downloadingVideo → downloadingAudio → merging → completed." },
    createdAt: { type: "string", format: "date-time" },
    lastUpdatedAt: { type: "string", format: "date-time", description: "Updated on a yt-dlp progress event, a lifecycle transition, or at least every few seconds while the child process is alive." },
    pollIntervalMs: { type: "integer", minimum: 100 },
    progressPercent: { type: ["number", "null"], minimum: 0, maximum: 100, description: "yt-dlp percentage for the current phase, not an invented whole-task percentage. It resets when a selected video+audio task advances from video to audio, is null while merging, and is 100 only after completed." },
    result: { anyOf: [youtubeDownloadResultSchema, { type: "null" }] },
    error: { anyOf: [downloadTaskErrorSchema, { type: "null" }] }
  },
  required: ["taskId", "status", "statusMessage", "phase", "createdAt", "lastUpdatedAt", "pollIntervalMs", "progressPercent", "result", "error"]
};
const cancelDownloadTaskSchema = {
  type: "object", additionalProperties: false,
  properties: { taskId: { type: "string" }, accepted: { type: "boolean" }, message: { type: "string" } },
  required: ["taskId", "accepted", "message"]
};
const pureReadAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
// The Local Agent is fixed to loopback, so this status read has no open-world
// effect. Keeping that annotation precise avoids presenting it as a web action.
const localAgentReadAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// These tools may create one inactive YouTube tab when none exists. That is a
// real local browser-state change, so readOnlyHint is deliberately false.
const pageReadAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
// This creates a file only inside the user's explicitly installed Local Agent
// workspace. It is intentionally not described as an open-web action.
const localDownloadAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const localDownloadReadAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function toolDefinitions() {
  return [
    {
      name: "researchtube_agent_status",
      title: "Get ResearchTube Local Agent status",
      description: "Check the optional ResearchTube Local Agent on the configured localhost port. Returns the serving Chrome Extension implementation version and its required Extension ↔ Agent interface version, plus the Agent implementation version, Agent interface version, workspace health, and status, version, discovery source, and diagnostic message for yt-dlp, Deno, ffmpeg, and ffprobe. Deno is an optional local JavaScript runtime passed explicitly to yt-dlp when available. Physical host paths are intentionally never exposed through MCP. A missing or mismatched Agent interfaceVersion prevents the Extension from using Agent tools, but does not affect ordinary YouTube research tools.",
      annotations: localAgentReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: agentStatusSchema
    },
    {
      name: "youtube_download",
      title: "Download a public YouTube video",
      description: "Start an asynchronous download of one public YouTube video through the optional ResearchTube Local Agent and its locally resolved yt-dlp, Deno, and ffmpeg executables. First call youtube_get_video(videoId) and choose exact numeric formatId values from its direct YouTube downloadFormats snapshot, or use 'best' for a component. selection must be either combined alone, video alone, audio alone, or video plus audio; never mix combined with video/audio. The Agent passes the exact selected IDs to yt-dlp with its local Deno runtime and lets yt-dlp select its working YouTube client automatically. A video+audio pair is remuxed into MP4 without re-encoding and therefore requires ffmpeg. The Agent accepts no arbitrary yt-dlp selector or arguments, no credentials, and no playlist. Returns a start handle only. Poll youtube_get_download_task no faster than pollIntervalMs; phase identifies the real yt-dlp operation and progressPercent is the percent within that phase, not a fabricated whole-task percentage. outputDir, when supplied, must be a safe workspace-relative directory.",
      annotations: localDownloadAnnotations,
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: {
          videoId: { type: "string", pattern: "^[A-Za-z0-9_-]{6,}$", description: "Public YouTube video ID returned by youtube_search, a channel or playlist catalogue, or youtube_get_video." },
          selection: downloadSelectionSchema,
          outputDir: { type: "string", minLength: 1, description: "Optional directory relative to the Local Agent workspace. Defaults to downloads. Do not use an absolute path or .. segments." }
        },
        required: ["videoId", "selection"]
      },
      outputSchema: youtubeDownloadStartSchema
    },
    {
      name: "youtube_get_download_task",
      title: "Get YouTube download status",
      description: "Read the current status of an asynchronous youtube_download task. Pass taskId unchanged and poll no faster than pollIntervalMs while status is working. phase identifies the actual yt-dlp operation. progressPercent is the native 0–100 percent for that phase: selected video and audio tracks each have their own percentage, merging has null, and completed has 100. lastUpdatedAt advances on progress, lifecycle changes, and liveness heartbeats. The terminal result contains only a workspace-relative filePath; its extension reflects the selected track or remuxed pair.",
      annotations: localDownloadReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { taskId: { type: "string", minLength: 1, description: "Opaque taskId returned by youtube_download." } }, required: ["taskId"] },
      outputSchema: youtubeDownloadTaskSchema
    },
    {
      name: "youtube_cancel_download_task",
      title: "Cancel YouTube download",
      description: "Request cancellation of a currently running youtube_download task. Pass taskId unchanged. Cancellation is cooperative: after an accepted request, call youtube_get_download_task to observe the terminal state.",
      annotations: localDownloadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { taskId: { type: "string", minLength: 1, description: "Opaque taskId returned by youtube_download." } }, required: ["taskId"] },
      outputSchema: cancelDownloadTaskSchema
    },
    {
      name: "youtube_search",
      title: "Search public YouTube videos",
      description: "Discovery tool for public YouTube videos. Search by keywords and return a compact list of matching videos with video ID, title, channel, duration, publication text, normalized view counts plus YouTube display text, and a short snippet when available. Use this first to find video IDs. The search request runs anonymously through an existing YouTube page context and never changes that page's URL or playback. It does not return canonical or media URLs, transcripts, comments, channel pages, playlists, or personalised results.",
      // Search may create one inactive YouTube tab if the browser has none,
      // just like the other page-context reads.
      annotations: pageReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string", minLength: 1, description: "Keywords, a topic, a channel name, or a natural-language YouTube search query." }, limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Maximum number of video results to return. Use a small limit unless broader discovery is needed." } }, required: ["query"] },
      outputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" }, results: { type: "array", items: videoSearchItemSchema }, returned: { type: "integer" }, requested: { type: "integer" }, hasMore: { type: "boolean" } }, required: ["query", "results", "returned", "requested", "hasMore"] }
    },
    {
      name: "youtube_get_video",
      title: "Get public YouTube video details",
      description: "Inspect one public YouTube video by video ID. Returns research metadata including title, description, channel, duration, absolute publication date when available, normalized views, likes, and comment count plus YouTube display text, category, tags, thumbnail, all public caption tracks, and a downloadFormats snapshot extracted directly from this video's YouTube player response. The snapshot separates ready-made combined files from video-only and audio-only tracks and contains no media URLs or credentials. Each caption track has a trackIndex for youtube_get_transcript. It does not return canonical video URLs, caption text, comment text, replies, account-only, private, member-only, or age-restricted content.",
      annotations: pureReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { videoId: { type: "string", minLength: 6, description: "YouTube video ID obtained from youtube_search, a channel or playlist catalogue, or a prior youtube_get_video response." } }, required: ["videoId"] },
      outputSchema: { type: "object", additionalProperties: false, properties: { videoId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, channel: commentAuthorSchema, publishedAt: nullableString, durationSeconds: { type: ["number", "null"] }, views: nullableInteger, viewsText: nullableString, likes: nullableInteger, likesText: nullableString, commentCount: nullableInteger, commentCountText: nullableString, category: nullableString, tags: { type: "array", items: { type: "string" } }, thumbnailUrl: nullableString, captions: { type: "object", additionalProperties: false, properties: { available: { type: "boolean" }, tracks: { type: "array", items: captionTrackSchema } }, required: ["available", "tracks"] }, downloadFormats: downloadFormatsSchema }, required: ["videoId", "title", "description", "channel", "publishedAt", "durationSeconds", "views", "viewsText", "likes", "likesText", "commentCount", "commentCountText", "category", "tags", "thumbnailUrl", "captions", "downloadFormats"] }
    },
    {
      name: "youtube_get_yt_dlp_formats",
      title: "Diagnose formats available to local yt-dlp",
      description: "Diagnostic read for resolving a download-format mismatch. For one public YouTube video ID, asks the configured ResearchTube Local Agent to run yt-dlp in metadata-only mode with the same local Deno runtime and automatic YouTube client selection used by youtube_download. It returns a separate, normalized yt-dlp format snapshot; compare its numeric formatId values with youtube_get_video(videoId).downloadFormats. It never downloads media, changes youtube_get_video, accepts a URL, or accepts arbitrary yt-dlp arguments. By default debug is false and the response is URL-free. Set debug to true only for troubleshooting a local installation: the response then deliberately includes the complete local command, stdout, and stderr, which can contain host paths and temporary media URLs.",
      annotations: localAgentReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { videoId: { type: "string", pattern: "^[A-Za-z0-9_-]{6,}$", description: "Public YouTube video ID to inspect with the local yt-dlp diagnostic." }, debug: { type: "boolean", default: false, description: "False by default. Set true only when diagnosing this local installation; it returns raw command, stdout, and stderr to the LLM." } }, required: ["videoId"] },
      outputSchema: { type: "object", additionalProperties: false, properties: { videoId: { type: "string" }, downloadFormats: ytDlpDownloadFormatsSchema, debug: { anyOf: [ytDlpFormatProbeDebugSchema, { type: "null" }], description: "Null unless the request explicitly set debug=true." } }, required: ["videoId", "downloadFormats", "debug"] }
    },
    {
      name: "youtube_get_channel_videos",
      title: "List public videos from a YouTube channel",
      description: "List the public video catalogue for one YouTube channel. Accepts an @handle, channel URL, or UC channel ID and returns compact video records with duration, publication display text, views, Shorts/live flags, and an opaque continuation when more results are available. Use this to select video IDs for youtube_get_video, youtube_get_transcript, or youtube_get_comments. Catalogue pages do not reliably expose likes, comment counts, or absolute publication dates, so those fields are deliberately absent or null. The request runs anonymously through a YouTube page context and never changes that page's URL or playback.",
      annotations: pageReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { channel: { type: "string", minLength: 2, description: "YouTube @handle, full channel URL, or UC channel ID." }, limit: { type: "integer", minimum: 1, maximum: 100, default: 30, description: "Maximum public video records to return. Results may be fewer at YouTube's page boundary; use continuation when supplied." }, continuation: { type: ["string", "null"], description: "Opaque token from this same tool and channel. Pass it back unchanged; never construct, edit, reuse for another channel, or log it." }, includeShorts: { type: "boolean", default: true, description: "Whether to include items YouTube marks as Shorts." }, includeStreams: { type: "boolean", default: true, description: "Whether to include live, upcoming, or streamed items." } }, required: ["channel"] },
      outputSchema: { type: "object", additionalProperties: false, properties: { channel: channelIdentitySchema, videos: { type: "array", items: channelVideoItemSchema }, returned: { type: "integer" }, requested: { type: "integer" }, continuation: nullableString }, required: ["channel", "videos", "returned", "requested", "continuation"] }
    },
    {
      name: "youtube_get_channel_playlists",
      title: "List public playlists from a YouTube channel",
      description: "List public playlists shown by one YouTube channel. Accepts an @handle, channel URL, or UC channel ID and returns playlist IDs, titles, displayed video counts, thumbnails, and an opaque continuation when more playlists are available. Use a returned playlistId with youtube_get_playlist_videos. It reads only public catalogue data and never changes the YouTube page being used as the request context.",
      annotations: pageReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { channel: { type: "string", minLength: 2, description: "YouTube @handle, full channel URL, or UC channel ID." }, limit: { type: "integer", minimum: 1, maximum: 100, default: 30, description: "Maximum public playlist records to return. Results may be fewer at YouTube's page boundary; use continuation when supplied." }, continuation: { type: ["string", "null"], description: "Opaque token from this same tool and channel. Pass it back unchanged; never construct, edit, reuse for another channel, or log it." } }, required: ["channel"] },
      outputSchema: { type: "object", additionalProperties: false, properties: { channel: channelIdentitySchema, playlists: { type: "array", items: playlistItemSchema }, returned: { type: "integer" }, requested: { type: "integer" }, continuation: nullableString }, required: ["channel", "playlists", "returned", "requested", "continuation"] }
    },
    {
      name: "youtube_get_playlist_videos",
      title: "List public videos in a YouTube playlist",
      description: "List the public videos in one YouTube playlist. Accepts a PL playlist ID or full playlist URL and returns its metadata, ordered video records, and an opaque continuation when more items are available. position is YouTube's zero-based playlist item index, not a display ordinal. Use this catalogue to choose video IDs for transcript or comment research; it does not retrieve those texts itself and does not navigate the YouTube page used for network context.",
      annotations: pageReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { playlist: { type: "string", minLength: 3, description: "YouTube playlist ID beginning with PL or a full playlist URL containing list=." }, limit: { type: "integer", minimum: 1, maximum: 100, default: 30, description: "Maximum public playlist video records to return. Results may be fewer at YouTube's page boundary; use continuation when supplied." }, continuation: { type: ["string", "null"], description: "Opaque token from this same tool and playlist. Pass it back unchanged; never construct, edit, reuse for another playlist, or log it." } }, required: ["playlist"] },
      outputSchema: { type: "object", additionalProperties: false, properties: { playlist: playlistIdentitySchema, videos: { type: "array", items: channelVideoItemSchema }, returned: { type: "integer" }, requested: { type: "integer" }, continuation: nullableString }, required: ["playlist", "videos", "returned", "requested", "continuation"] }
    },
    {
      name: "youtube_get_transcript",
      title: "Get public YouTube transcript",
      description: "Retrieve timestamped text from one public caption track for a video. By default, trackIndex 0 returns YouTube's primary track. Call youtube_get_video first when a different language or track is needed, then pass its trackIndex here. Returns ordered segments with start time, duration, and text. Public data only: no YouTube cookies, account actions, or authenticated user interaction are used.",
      annotations: pageReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { videoId: { type: "string", minLength: 6, description: "YouTube video ID whose public transcript is required." }, trackIndex: { type: "integer", minimum: 0, default: 0, description: "Caption track index returned by youtube_get_video. Defaults to 0, YouTube's primary track." }, limit: { type: "integer", minimum: 1, maximum: 5000, default: 800, description: "Maximum number of timestamped caption segments to return, in chronological order." } }, required: ["videoId"] },
      outputSchema: { type: "object", additionalProperties: false, properties: { videoId: { type: "string" }, selectedTrack: captionTrackSchema, segments: { type: "array", items: { type: "object", additionalProperties: false, properties: { start: { type: "number" }, duration: { type: "number" }, text: { type: "string" } }, required: ["start", "duration", "text"] } }, returned: { type: "integer" }, requested: { type: "integer" } }, required: ["videoId", "selectedTrack", "segments", "returned", "requested"] }
    },
    {
      name: "youtube_get_comments",
      title: "Get public YouTube comment threads",
      description: "Retrieve public top-level comment threads for one video, sorted by popularity or newest first. Each item includes its explicit YouTube rank, author, text, display and normalized like/reply counts, publication text, and pinned or hearted flags. Use top comments to identify strong audience resonance; use newest comments to see current discussion. It does not include reply text: call youtube_get_comment_replies with a returned commentId for that. Public comments only; no posting, reacting, subscribing, cookies, or account actions occur.",
      annotations: pageReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { videoId: { type: "string", minLength: 6, description: "YouTube video ID whose public comments are required." }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Maximum number of top-level comment threads to return." }, sort: { type: "string", enum: ["top", "newest"], default: "top", description: "top ranks by YouTube popularity; newest requests chronological newest-first order." } }, required: ["videoId"] },
      outputSchema: { type: "object", additionalProperties: false, properties: { videoId: { type: "string" }, sortRequested: { enum: ["top", "newest"] }, comments: { type: "array", items: commentSchema }, returned: { type: "integer" }, requested: { type: "integer" } }, required: ["videoId", "sortRequested", "comments", "returned", "requested"] }
    },
    {
      name: "youtube_get_comment_replies",
      title: "Get replies to one YouTube comment",
      description: "Retrieve public replies beneath one top-level YouTube comment. First call youtube_get_comments, then pass its commentId here with the same videoId. Returns the parent summary, reply rank, author, text, publication text, and normalized plus display like counts. totalReplies distinguishes the size of the whole thread from this returned sample. This tool is for one selected conversation branch; it does not search for comments, return other top-level threads, or perform any account action.",
      annotations: pageReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { videoId: { type: "string", minLength: 6, description: "Video ID used in the preceding youtube_get_comments call." }, commentId: { type: "string", minLength: 1, description: "Top-level comment ID returned by youtube_get_comments." }, limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Maximum number of replies to return for this one comment thread." } }, required: ["videoId", "commentId"] },
      outputSchema: { type: "object", additionalProperties: false, properties: { videoId: { type: "string" }, parentCommentId: { type: "string" }, parent: commentParentSchema, replies: { type: "array", items: replySchema }, returned: { type: "integer" }, requested: { type: "integer" }, totalReplies: nullableInteger }, required: ["videoId", "parentCommentId", "parent", "replies", "returned", "requested", "totalReplies"] }
    }
  ];
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // Do not overwrite chrome.storage.local here. Reloading or updating an
  // unpacked extension fires onInstalled and previously erased the tunnel
  // settings, which made development unnecessarily repetitive.
  void bootstrapTunnel();
  if (reason === "install") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html"), active: true });
  }
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrapTunnel();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tunnel-poll") void startPolling();
});

async function bootstrapTunnel() {
  // These were experimental controls in older builds. The transport is now
  // permanently anonymous WEB page-context, so retaining stale values would
  // be misleading and serves no purpose.
  await chrome.storage.local.remove([
    "controlPlaneBaseUrl",
    "onboardingStep",
    "enabled",
    "usePersonalYouTubeSession",
    "commentsClientType",
    "transcriptClientType",
    "commentsProfileDefaultVersion"
  ]);
  await chrome.alarms.create("tunnel-poll", { periodInMinutes: 0.5 });
  await refreshActionBadge();
  return startPolling();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "poll-now") {
    startPolling();
    pollOnce().then((result) => sendResponse(result));
    return true;
  }
  if (message?.type === "status") {
    getPublicConnectionState().then(sendResponse);
    return true;
  }
  if (message?.type === "save-connection") {
    saveConnection(message.payload).then(sendResponse).catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }
  if (message?.type === "clear-api-key") {
    chrome.storage.local.remove(["runtimeApiKey"]).then(async () => {
      await chrome.storage.local.set({ lastConnectionTest: null });
      await refreshActionBadge();
      sendResponse({ ok: true });
    }).catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }
  if (message?.type === "test-connection") {
    testConnection().then(sendResponse).catch((error) => sendResponse(connectionFailure("UNKNOWN_ERROR", "Connection test failed.", error)));
    return true;
  }
  if (message?.type === "save-agent-port") {
    saveAgentPort(message.payload).then(sendResponse).catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }
  if (message?.type === "test-agent-connection") {
    testAgentConnection(message.payload).then(sendResponse).catch(() => sendResponse(agentUnavailableStatus(DEFAULTS.agentPort)));
    return true;
  }
  if (message?.type === "get-diagnostics") {
    getDiagnosticsExport().then(sendResponse).catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }
  if (message?.type === "clear-diagnostics") {
    clearDiagnostics().then(sendResponse).catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }
  if (message?.type === "open-external") {
    const url = EXTERNAL_URLS[message.target];
    if (!url) {
      sendResponse({ ok: false, error: "Unknown destination" });
      return false;
    }
    chrome.tabs.create({ url, active: true }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }
  return false;
});

async function getConfig() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get({ ...DEFAULTS, lastStatus: "" })) };
}

async function getPublicConnectionState() {
  const config = await getConfig();
  const agentPort = normalizeAgentPort(config.agentPort);
  const agent = await getAgentStatus(agentPort);
  const remainingMs = Math.max(0, Number(config.youtubeSearchCooldownUntil || 0) - Date.now());
  return {
    configured: Boolean(config.tunnelId && config.runtimeApiKey),
    tunnelId: config.tunnelId,
    apiKeyPresent: Boolean(config.runtimeApiKey),
    polling,
    lastStatus: config.lastStatus || "",
    lastConnectionTest: config.lastConnectionTest || null,
    agentPort,
    agent,
    requiredAgentInterfaceVersion: REQUIRED_AGENT_INTERFACE_VERSION,
    onboardingCompleted: Boolean(config.onboardingCompleted),
    youtubeSearch: {
      rateLimited: remainingMs > 0,
      retryAfterSeconds: Math.ceil(remainingMs / 1_000),
      cooldownUntil: remainingMs > 0 ? new Date(Number(config.youtubeSearchCooldownUntil)).toISOString() : null
    }
  };
}

function normalizeAgentPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : DEFAULTS.agentPort;
}

async function saveAgentPort(payload = {}) {
  const supplied = Number(payload.port);
  if (!Number.isInteger(supplied) || supplied < 1 || supplied > 65_535) {
    return { ok: false, errorCode: "AGENT_PORT_INVALID", message: "Enter a port from 1 to 65535." };
  }
  await chrome.storage.local.set({ agentPort: supplied });
  return { ok: true, port: supplied };
}

function agentUnavailableStatus(port) {
  return {
    available: false,
    error: "AGENT_UNAVAILABLE",
    message: `ResearchTube Local Agent is not available on port ${port}.`,
    status: null,
    extensionVersion: EXTENSION_VERSION,
    extensionInterfaceVersion: REQUIRED_AGENT_INTERFACE_VERSION,
    agentVersion: null,
    interfaceVersion: null,
    workspace: null,
    components: null
  };
}

function normalizeAgentInterfaceVersion(value) {
  return Number.isInteger(value) && value >= 1 ? value : null;
}

function agentInterfaceIsCompatible(status) {
  return Boolean(status?.available) && status.interfaceVersion === REQUIRED_AGENT_INTERFACE_VERSION;
}

function normalizeAgentWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object") return null;
  const status = workspace.status === "available" || workspace.status === "error" ? workspace.status : "error";
  return { status };
}

function normalizeAgentComponent(value) {
  const status = value?.status;
  return {
    status: status === "available" || status === "missing" || status === "error" ? status : "error",
    version: typeof value?.version === "string" ? value.version : null,
    source: value?.source === "local" || value?.source === "path" ? value.source : null,
    message: typeof value?.message === "string" ? value.message : null
  };
}

function normalizeAgentComponents(components) {
  if (!components || typeof components !== "object") return null;
  return {
    ytDlp: normalizeAgentComponent(components.ytDlp ?? components["yt-dlp"]),
    deno: normalizeAgentComponent(components.deno),
    ffmpeg: normalizeAgentComponent(components.ffmpeg),
    ffprobe: normalizeAgentComponent(components.ffprobe)
  };
}

async function getAgentStatus(port = null) {
  const config = await getConfig();
  const resolvedPort = normalizeAgentPort(port ?? config.agentPort);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${resolvedPort}/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) return agentUnavailableStatus(resolvedPort);
    const health = await response.json();
    if (!health || typeof health !== "object") return agentUnavailableStatus(resolvedPort);
    const interfaceVersion = normalizeAgentInterfaceVersion(health.interfaceVersion);
    const interfaceCompatible = interfaceVersion === REQUIRED_AGENT_INTERFACE_VERSION;
    return {
      available: true,
      error: interfaceCompatible ? null : "AGENT_INTERFACE_INCOMPATIBLE",
      message: interfaceCompatible ? "ResearchTube Local Agent is available." : "ResearchTube Local Agent interface is incompatible.",
      status: typeof health.status === "string" ? health.status : "ok",
      extensionVersion: EXTENSION_VERSION,
      extensionInterfaceVersion: REQUIRED_AGENT_INTERFACE_VERSION,
      agentVersion: typeof health.agentVersion === "string" ? health.agentVersion : null,
      interfaceVersion,
      workspace: normalizeAgentWorkspace(health.workspace),
      components: normalizeAgentComponents(health.components)
    };
  } catch (_error) {
    return agentUnavailableStatus(resolvedPort);
  } finally {
    clearTimeout(timeout);
  }
}

async function testAgentConnection(payload = {}) {
  const saved = await saveAgentPort(payload);
  if (!saved.ok) return saved;
  const status = await getAgentStatus(saved.port);
  return { ok: agentInterfaceIsCompatible(status), ...status };
}

function localAgentError(code, message, detail = null) {
  const error = new Error(message);
  error.code = code;
  error.detail = detail;
  return error;
}

async function requireCompatibleAgent(port) {
  const status = await getAgentStatus(port);
  if (!status.available) {
    throw localAgentError("AGENT_UNAVAILABLE", status.message);
  }
  if (!agentInterfaceIsCompatible(status)) {
    throw localAgentError("AGENT_INTERFACE_INCOMPATIBLE", "ResearchTube Local Agent interface is incompatible.");
  }
}

async function agentJsonRequest(path, { method = "GET", body = null, port = null, timeoutMs = AGENT_TASK_TIMEOUT_MS } = {}) {
  const config = await getConfig();
  const resolvedPort = normalizeAgentPort(port ?? config.agentPort);
  await requireCompatibleAgent(resolvedPort);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${resolvedPort}${path}`, {
      method,
      headers: { Accept: "application/json", ...(body === null ? {} : { "Content-Type": "application/json" }) },
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    let document = null;
    try { document = await response.json(); } catch (_error) { /* normalized below */ }
    if (!response.ok) {
      const remote = document?.error;
      throw localAgentError(
        typeof remote?.code === "string" ? remote.code : "AGENT_REQUEST_FAILED",
        typeof remote?.message === "string" ? remote.message : `Local Agent request failed (${response.status}).`,
        typeof remote?.detail === "string" ? remote.detail : null
      );
    }
    if (!document || typeof document !== "object") throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid JSON.");
    return document;
  } catch (error) {
    if (error?.code) throw error;
    throw localAgentError("AGENT_UNAVAILABLE", `ResearchTube Local Agent is not available on port ${resolvedPort}.`);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeAgentTask(value) {
  const status = value?.status;
  const phase = value?.phase;
  if (!value || typeof value !== "object" || typeof value.taskId !== "string" || !["working", "completed", "failed", "cancelled"].includes(status)
    || !["preparing", "downloadingCombined", "downloadingVideo", "downloadingAudio", "merging", "completed", "failed", "cancelled"].includes(phase)
    || typeof value.statusMessage !== "string" || typeof value.createdAt !== "string" || typeof value.lastUpdatedAt !== "string") {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid task record.");
  }
  return value;
}

function publicDownloadTask(task) {
  const result = task.result && typeof task.result === "object" ? task.result : null;
  const failure = task.error && typeof task.error === "object" ? task.error : null;
  return {
    taskId: task.taskId,
    status: task.status,
    statusMessage: task.statusMessage,
    phase: task.phase,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    pollIntervalMs: Number.isInteger(task.pollIntervalMs) && task.pollIntervalMs > 0 ? task.pollIntervalMs : 1_000,
    progressPercent: typeof task.progressPercent === "number" && task.progressPercent >= 0 && task.progressPercent <= 100 ? task.progressPercent : null,
    result,
    error: failure ? {
      code: typeof failure.code === "string" ? failure.code : "DOWNLOAD_FAILED",
      message: typeof failure.message === "string" ? failure.message : "The download task failed.",
      detail: typeof failure.detail === "string" ? failure.detail : null
    } : null
  };
}

function publicDownloadStartTask(task) {
  return {
    taskId: task.taskId,
    status: task.status,
    statusMessage: task.statusMessage,
    phase: task.phase,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    pollIntervalMs: Number.isInteger(task.pollIntervalMs) && task.pollIntervalMs > 0 ? task.pollIntervalMs : 1_000,
    progressPercent: typeof task.progressPercent === "number" && task.progressPercent >= 0 && task.progressPercent <= 100 ? task.progressPercent : null
  };
}

function normalizeDownloadSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw localAgentError("FORMAT_SELECTION_INVALID", "selection is required.");
  }
  const allowed = new Set(["combined", "video", "audio"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw localAgentError("FORMAT_SELECTION_INVALID", "selection contains an unsupported field.");
  }
  const selection = {};
  for (const key of allowed) {
    if (!(key in value) || value[key] === null) continue;
    if (typeof value[key] !== "string" || !/^(?:best|[0-9]+)$/.test(value[key])) {
      throw localAgentError("FORMAT_SELECTION_INVALID", `selection.${key} must be 'best' or a numeric formatId.`);
    }
    selection[key] = value[key];
  }
  if (selection.combined && (selection.video || selection.audio)) {
    throw localAgentError("FORMAT_SELECTION_INVALID", "Select either combined or video/audio tracks, not both.");
  }
  if (!selection.combined && !selection.video && !selection.audio) {
    throw localAgentError("FORMAT_SELECTION_INVALID", "Select a combined, video, or audio track.");
  }
  return selection;
}

async function startYouTubeDownload(args = {}) {
  const videoId = typeof args.videoId === "string" ? args.videoId.trim() : "";
  if (!/^[A-Za-z0-9_-]{6,}$/.test(videoId)) throw localAgentError("INVALID_VIDEO_ID", "videoId is required.");
  const selection = normalizeDownloadSelection(args.selection);
  const outputDir = args.outputDir;
  if (outputDir !== undefined && (typeof outputDir !== "string" || !outputDir.trim())) {
    throw localAgentError("OUTPUT_DIR_INVALID", "outputDir must be a non-empty workspace-relative directory string.");
  }
  return publicDownloadStartTask(normalizeAgentTask(await agentJsonRequest("/tasks/youtube-download", { method: "POST", body: { videoId, selection, ...(outputDir === undefined ? {} : { outputDir: outputDir.trim() }) } })));
}

function nullableAgentString(value) {
  return typeof value === "string" ? value : null;
}

function nullableAgentNumber(value, integer = false) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && (!integer || Number.isInteger(value)) ? value : null;
}

function normalizeYtDlpFormat(value, expectedKind) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.formatId !== "string" || !/^\d+$/.test(value.formatId)
    || value.kind !== expectedKind) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid yt-dlp format record.");
  }
  // This explicit allowlist is a second privacy boundary. Even if a future
  // Agent accidentally sends a raw yt-dlp -J object, URLs and credentials can
  // never cross the Extension's MCP boundary.
  return {
    formatId: value.formatId,
    kind: expectedKind,
    container: nullableAgentString(value.container),
    videoCodec: nullableAgentString(value.videoCodec),
    audioCodec: nullableAgentString(value.audioCodec),
    width: nullableAgentNumber(value.width, true),
    height: nullableAgentNumber(value.height, true),
    fps: nullableAgentNumber(value.fps),
    bitrateBps: nullableAgentNumber(value.bitrateBps, true),
    audioSampleRateHz: nullableAgentNumber(value.audioSampleRateHz, true),
    audioChannels: nullableAgentNumber(value.audioChannels, true),
    qualityLabel: nullableAgentString(value.qualityLabel),
    sizeBytes: nullableAgentNumber(value.sizeBytes, true)
  };
}

function normalizeYtDlpFormats(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.source !== "ytDlp" || typeof value.available !== "boolean") {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid yt-dlp format diagnostic.");
  }
  const output = {
    available: value.available,
    source: "ytDlp",
    message: nullableAgentString(value.message),
    combined: [], video: [], audio: []
  };
  for (const kind of ["combined", "video", "audio"]) {
    if (!Array.isArray(value[kind]) || value[kind].length > 100) {
      throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid yt-dlp format diagnostic.");
    }
    output[kind] = value[kind].map((item) => normalizeYtDlpFormat(item, kind));
  }
  return output;
}

function normalizeYtDlpProbeDebug(value, enabled) {
  if (!enabled) {
    if (value !== null && value !== undefined) {
      throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned debug output without an explicit debug request.");
    }
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Array.isArray(value.command) || value.command.some((item) => typeof item !== "string")
    || !(value.exitCode === null || Number.isInteger(value.exitCode))
    || typeof value.stdout !== "string" || typeof value.stderr !== "string") {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid raw yt-dlp diagnostic.");
  }
  // Raw output is an explicit, local troubleshooting opt-in. Do not redact or
  // transform it: that would defeat its purpose when debugging yt-dlp.
  return { command: value.command, exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr };
}

async function getYtDlpFormats(videoId, debug = false) {
  if (!/^[A-Za-z0-9_-]{6,}$/.test(videoId)) throw localAgentError("INVALID_VIDEO_ID", "videoId is required.");
  const document = await agentJsonRequest("/diagnostics/yt-dlp-formats", {
    method: "POST", body: { videoId, debug }, timeoutMs: AGENT_FORMAT_PROBE_TIMEOUT_MS
  });
  if (document.videoId !== videoId) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned a format diagnostic for another video.");
  return { videoId, downloadFormats: normalizeYtDlpFormats(document.downloadFormats), debug: normalizeYtDlpProbeDebug(document.debug, debug) };
}

async function getYouTubeDownloadTask(taskId) {
  if (typeof taskId !== "string" || !taskId) throw localAgentError("TASK_NOT_FOUND", "taskId is required.");
  return publicDownloadTask(normalizeAgentTask(await agentJsonRequest(`/tasks/${encodeURIComponent(taskId)}`)));
}

async function cancelYouTubeDownloadTask(taskId) {
  if (typeof taskId !== "string" || !taskId) throw localAgentError("TASK_NOT_FOUND", "taskId is required.");
  await agentJsonRequest(`/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", body: {} });
  return { taskId, accepted: true, message: "Cancellation request accepted. Poll youtube_get_download_task for the terminal status." };
}

async function saveConnection(payload = {}) {
  const tunnelId = String(payload.tunnelId ?? "").trim();
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
  if (!tunnelId) return { ok: false, errorCode: "TUNNEL_ID_MISSING", message: "Enter your Tunnel ID." };

  const changes = { tunnelId, lastConnectionTest: null };
  if (apiKey) changes.runtimeApiKey = apiKey;
  if (payload.onboardingCompleted === true) changes.onboardingCompleted = true;
  await chrome.storage.local.set(changes);
  await refreshActionBadge();
  void startPolling();
  return { ok: true, apiKeyPresent: Boolean(apiKey || (await getConfig()).runtimeApiKey) };
}

function startPolling() {
  // All callers share one scheduled loop. The former implementation allowed
  // concurrent callers to attach their own successor timer after the same
  // poll, which could multiply timers even though the poll itself was shared.
  schedulePollLoop(0);
  return currentPollPromise ?? Promise.resolve({ ok: true, scheduled: true });
}

function schedulePollLoop(delayMs) {
  if (pollLoopScheduled) return;
  pollLoopScheduled = true;
  pollLoopTimer = setTimeout(async () => {
    pollLoopScheduled = false;
    pollLoopTimer = null;
    const result = await pollOnce();
    const config = await getConfig();
    if (config.tunnelId && config.runtimeApiKey) {
      schedulePollLoop(POLL_RETRY_DELAY_MS);
    } else {
      await refreshActionBadge();
    }
    return result;
  }, delayMs);
}

async function pollOnce() {
  if (currentPollPromise) return currentPollPromise;
  currentPollPromise = pollOnceInternal();
  try {
    return await currentPollPromise;
  } finally {
    currentPollPromise = null;
  }
}

async function pollOnceInternal() {
  const config = await getConfig();
  if (!config.tunnelId || !config.runtimeApiKey) {
    return { ok: false, reason: "not-configured" };
  }

  polling = true;
  try {
    const url = `${CONTROL_PLANE_BASE_URL}/v1/tunnels/${encodeURIComponent(config.tunnelId)}/poll?limit=1&timeout_ms=15000`;
    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${config.runtimeApiKey}`,
        "Accept": "application/json",
        "X-Tunnel-Client-Name": "researchtube-extension",
        "X-Tunnel-Client-Version": EXTENSION_VERSION,
        "X-Tunnel-Client-Wire-Protocol-Version": "2026-08-25",
        "X-Tunnel-MCP-Server-Info": JSON.stringify({ version: 1, channels: [{ name: "main" }] })
      }
    });
    if (response.status === 204) {
      await chrome.storage.local.set({ lastStatus: "poll: 204 (no command)" });
      await refreshActionBadge();
      return { ok: true, empty: true };
    }
    if (!response.ok) throw createTunnelHttpError(response.status);

    const envelope = await response.json();
    const commands = Array.isArray(envelope?.commands) ? envelope.commands : [];
    if (!commands.length) {
      await chrome.storage.local.set({ lastStatus: "poll: 200 (no command)" });
      await refreshActionBadge();
      return { ok: true, empty: true };
    }
    for (const command of commands) {
      if (command.command_type !== "jsonrpc") continue;
      const result = await handleMcpRequest(command.jsonrpc);
      await postResponse(config, command, result);
    }
    await chrome.storage.local.set({ lastStatus: `handled ${commands.length} command(s)` });
    await refreshActionBadge();
    return { ok: true, handled: commands.length };
  } catch (error) {
    console.warn("ResearchTube:", error);
    await chrome.storage.local.set({ lastStatus: `error: ${String(error)}` });
    await setActionBadge("connection-error");
    return { ok: false, error: String(error) };
  } finally {
    polling = false;
  }
}

async function postResponse(config, command, result) {
  const url = `${CONTROL_PLANE_BASE_URL}/v1/tunnels/${encodeURIComponent(config.tunnelId)}/response`;
  const payload = {
    request_id: command.request_id,
    channel: command.channel || "main",
    resp_headers: { "Content-Type": ["application/json"] },
    resp_code: 200,
    resp_type: result === null ? "notify_ack" : "jsonrpc_response"
  };
  if (result !== null) payload.resp_json = result;
  const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.runtimeApiKey}`,
        "Content-Type": "application/json",
        "X-Tunnel-Shard-Token": command.shard_token
      },
      body: JSON.stringify(payload)
    });
  if (!response.ok) throw createTunnelHttpError(response.status, "response");
}

async function setActionBadge(state) {
  const appearance = {
    ready: { text: "", color: "#6e7781", title: "ResearchTube: ready" },
    setup: { text: "", color: "#6e7781", title: "ResearchTube: setup required" },
    working: { text: "…", color: "#0969da", title: "ResearchTube: working" },
    "youtube-rate-limited": { text: "!", color: "#b7791f", title: "ResearchTube: YouTube search is temporarily limited" },
    "connection-error": { text: "×", color: "#cf222e", title: "ResearchTube: connection needs attention" }
  }[state] ?? { text: "", color: "#6e7781", title: "ResearchTube" };
  try {
    await chrome.action.setBadgeBackgroundColor({ color: appearance.color });
    await chrome.action.setBadgeText({ text: appearance.text });
    await chrome.action.setTitle({ title: appearance.title });
  } catch (error) {
    // The extension remains functional even if Chrome is restarting or the
    // toolbar action is temporarily unavailable.
    console.debug("ResearchTube badge update failed:", error);
  }
}

async function refreshActionBadge() {
  const config = await getConfig();
  if (Number(config.youtubeSearchCooldownUntil || 0) > Date.now()) {
    return setActionBadge("youtube-rate-limited");
  }
  return setActionBadge(config.tunnelId && config.runtimeApiKey ? "ready" : "setup");
}

async function testConnection() {
  await setActionBadge("working");
  const config = await getConfig();
  let result;
  if (!config.tunnelId) {
    result = connectionFailure("TUNNEL_ID_MISSING", "Enter your Tunnel ID.");
  } else if (!config.runtimeApiKey) {
    result = connectionFailure("API_KEY_MISSING", "Enter your OpenAI API key.");
  } else {
    const pollResult = await pollOnce();
    result = pollResult.ok
      ? { ok: true, stages: { apiKey: true, tunnel: true }, message: "Connection successful." }
      : connectionFailureFromPoll(pollResult);
  }
  await chrome.storage.local.set({
    lastConnectionTest: {
      success: result.ok,
      timestamp: new Date().toISOString(),
      stage: result.ok ? "tunnel" : result.errorCode,
      errorCode: result.errorCode || null,
      message: result.message || null
    }
  });
  if (result.ok) await refreshActionBadge();
  else await setActionBadge("connection-error");
  return result;
}

function createTunnelHttpError(status, operation = "poll") {
  const error = new Error(`${operation} HTTP ${status}`);
  error.httpStatus = status;
  return error;
}

function connectionFailureFromPoll(result) {
  const error = String(result?.error || "");
  if (/HTTP 401/i.test(error)) return connectionFailure("API_KEY_INVALID", "The OpenAI API key was rejected.");
  if (/HTTP 403/i.test(error)) return connectionFailure("TUNNEL_PERMISSION_DENIED", "The API key is valid, but it cannot access this tunnel.");
  if (/HTTP 404/i.test(error)) return connectionFailure("TUNNEL_NOT_FOUND", "The tunnel could not be found.");
  if (/Failed to fetch|NetworkError|network/i.test(error)) return connectionFailure("NETWORK_ERROR", "ResearchTube could not reach OpenAI.");
  if (result?.reason === "not-configured") return connectionFailure("NOT_CONFIGURED", "Enter your Tunnel ID and OpenAI API key.");
  return connectionFailure("OPENAI_ERROR", "Connection test failed.", error);
}

function connectionFailure(errorCode, message, detail = null) {
  return { ok: false, errorCode, message, detail: detail ? safeErrorMessage(detail) : null };
}

function safeErrorMessage(error) {
  return String(error?.message || error || "Unknown error").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
}

async function handleMcpRequest(request) {
  if (request?.method === "initialize") {
    return {
      jsonrpc: "2.0", id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "researchtube", version: EXTENSION_VERSION }
      }
    };
  }
  if (request?.method === "notifications/initialized") return null;
  if (request?.method === "tools/list") {
    return { jsonrpc: "2.0", id: request.id, result: { tools: toolDefinitions() } };
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_download") {
    const input = request.params.arguments ?? {};
    return executeToolCall(request.id, "youtube_download", input, () => startYouTubeDownload(input));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_get_download_task") {
    const taskId = String(request.params.arguments?.taskId ?? "").trim();
    if (!taskId) return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "taskId is required" } };
    return executeToolCall(request.id, "youtube_get_download_task", { taskId }, () => getYouTubeDownloadTask(taskId));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_cancel_download_task") {
    const taskId = String(request.params.arguments?.taskId ?? "").trim();
    if (!taskId) return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "taskId is required" } };
    return executeToolCall(request.id, "youtube_cancel_download_task", { taskId }, () => cancelYouTubeDownloadTask(taskId));
  }
  if (request?.method === "tools/call" && request.params?.name === "researchtube_agent_status") {
    return executeToolCall(request.id, "researchtube_agent_status", {}, () => getAgentStatus());
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_search") {
    const query = String(request.params.arguments?.query ?? "").trim();
    const limit = boundedInt(request.params.arguments?.limit, 10, 1, 50);
    if (!query) {
      return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "query is required" } };
    }
    return executeToolCall(request.id, "youtube_search", { query, limit }, () => youtubeSearch(query, limit), "YouTube search failed");
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_get_video") {
    const videoId = requireVideoId(request.params.arguments);
    return executeToolCall(request.id, "youtube_get_video", { videoId }, () => youtubeGetVideo(videoId));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_get_yt_dlp_formats") {
    const args = request.params.arguments ?? {};
    const videoId = requireVideoId(args);
    if (args.debug !== undefined && typeof args.debug !== "boolean") {
      return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "debug must be a boolean" } };
    }
    const debug = args.debug === true;
    return executeToolCall(request.id, "youtube_get_yt_dlp_formats", { videoId, debug }, () => getYtDlpFormats(videoId, debug));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_get_channel_videos") {
    const args = request.params.arguments ?? {};
    const channel = requireCatalogueIdentifier(args.channel, "channel");
    const limit = boundedInt(args.limit, 30, 1, 100);
    const continuation = optionalContinuation(args.continuation);
    const includeShorts = args.includeShorts !== false;
    const includeStreams = args.includeStreams !== false;
    return executeToolCall(request.id, "youtube_get_channel_videos", { channel, limit, continuation, includeShorts, includeStreams }, () => youtubeGetChannelVideos({ channel, limit, continuation, includeShorts, includeStreams }));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_get_channel_playlists") {
    const args = request.params.arguments ?? {};
    const channel = requireCatalogueIdentifier(args.channel, "channel");
    const limit = boundedInt(args.limit, 30, 1, 100);
    const continuation = optionalContinuation(args.continuation);
    return executeToolCall(request.id, "youtube_get_channel_playlists", { channel, limit, continuation }, () => youtubeGetChannelPlaylists({ channel, limit, continuation }));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_get_playlist_videos") {
    const args = request.params.arguments ?? {};
    const playlist = requireCatalogueIdentifier(args.playlist, "playlist");
    const limit = boundedInt(args.limit, 30, 1, 100);
    const continuation = optionalContinuation(args.continuation);
    return executeToolCall(request.id, "youtube_get_playlist_videos", { playlist, limit, continuation }, () => youtubeGetPlaylistVideos({ playlist, limit, continuation }));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_get_transcript") {
    const args = request.params.arguments ?? {};
    const videoId = requireVideoId(args);
    const limit = boundedInt(args.limit, 800, 1, 5000);
    const trackIndex = boundedInt(args.trackIndex, 0, 0, 100);
    return executeToolCall(request.id, "youtube_get_transcript", { videoId, limit, trackIndex }, () => youtubeGetTranscript(videoId, limit, trackIndex));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_get_comments") {
    const args = request.params.arguments ?? {};
    const videoId = requireVideoId(args);
    const limit = boundedInt(args.limit, 20, 1, 100);
    const sort = args.sort === "newest" ? "newest" : "top";
    return executeToolCall(request.id, "youtube_get_comments", { videoId, limit, sort }, () => youtubeGetComments(videoId, limit, sort));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_get_comment_replies") {
    const args = request.params.arguments ?? {};
    const videoId = requireVideoId(args);
    const commentId = String(args.commentId ?? "").trim();
    if (!commentId) return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "commentId is required" } };
    const limit = boundedInt(args.limit, 20, 1, 100);
    return executeToolCall(request.id, "youtube_get_comment_replies", { videoId, commentId, limit }, () => youtubeGetCommentReplies(videoId, commentId, limit));
  }
  return { jsonrpc: "2.0", id: request?.id, error: { code: -32601, message: "Method or tool is not implemented" } };
}

function jsonToolResult(id, value) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false } };
}

async function executeToolCall(id, tool, input, work, operation = null) {
  const startedAt = Date.now();
  void recordCommandDiagnostic("started", { tool, input: summarizeCommandInput(tool, input) });
  await setActionBadge("working");
  try {
    const value = await work();
    await refreshActionBadge();
    void recordCommandDiagnostic("succeeded", {
      tool,
      elapsed_ms: Date.now() - startedAt,
      output: summarizeCommandOutput(value)
    });
    return jsonToolResult(id, value);
  } catch (error) {
    await refreshActionBadge();
    const contextualError = operation && !error?.code
      ? new Error(`${operation}: ${String(error?.message || error)}`, { cause: error })
      : error;
    void recordCommandDiagnostic("failed", {
      tool,
      elapsed_ms: Date.now() - startedAt,
      error_code: contextualError?.code || null,
      error: searchDiagnosticMessage(contextualError)
    });
    return toolError(id, contextualError);
  }
}

function summarizeCommandInput(tool, input) {
  if (tool === "youtube_download") return { videoId: typeof input.videoId === "string" ? input.videoId : null, selection: input.selection ?? null, outputDir: typeof input.outputDir === "string" ? input.outputDir.slice(0, 300) : null };
  if (tool === "youtube_search") return { query: searchDiagnosticQuery(input.query), limit: input.limit };
  if (tool === "youtube_get_comment_replies") return { videoId: input.videoId, commentId: input.commentId, limit: input.limit };
  if (tool === "youtube_get_channel_videos") return { channel: input.channel, limit: input.limit, includeShorts: input.includeShorts, includeStreams: input.includeStreams, continuationProvided: Boolean(input.continuation) };
  if (tool === "youtube_get_channel_playlists") return { channel: input.channel, limit: input.limit, continuationProvided: Boolean(input.continuation) };
  if (tool === "youtube_get_playlist_videos") return { playlist: input.playlist, limit: input.limit, continuationProvided: Boolean(input.continuation) };
  return { ...input };
}

function summarizeCommandOutput(value) {
  if (!value || typeof value !== "object") return null;
  const summary = {};
  for (const key of ["videoId", "query", "returned", "requested", "hasMore", "totalReplies", "continuation"]) {
    if (Object.hasOwn(value, key)) summary[key] = value[key];
  }
  return summary;
}

function toolError(id, error) {
  const code = error?.code;
  const message = String(error?.message ?? error);
  const text = typeof code === "string" ? `[${code}] ${message}` : message;
  const structuredError = { error: { code: typeof code === "string" ? code : "TOOL_ERROR", message, ...(typeof error?.detail === "string" ? { detail: error.detail } : {}) } };
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], structuredContent: structuredError, isError: true } };
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? Math.floor(parsed) : fallback));
}

function requireVideoId(args) {
  const id = String(args?.videoId ?? "").trim();
  if (!/^[A-Za-z0-9_-]{6,}$/.test(id)) throw new Error("videoId is required");
  return id;
}

class YouTubeSearchRateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super(`YouTube search is temporarily limited. Retry after ${retryAfterSeconds} seconds; do not retry sooner.`);
    this.name = "YouTubeSearchRateLimitError";
    this.code = "YOUTUBE_SEARCH_RATE_LIMITED";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function searchDiagnosticQuery(query) {
  return String(query ?? "").replace(/\s+/g, " ").trim().slice(0, SEARCH_DIAGNOSTIC_MAX_QUERY_LENGTH);
}

function recordCommandDiagnostic(event, fields = {}) {
  const entry = { event, timestamp: new Date().toISOString(), ...fields };
  commandDiagnosticWrite = commandDiagnosticWrite
    .catch(() => undefined)
    .then(async () => {
      const { commandDiagnostics = [] } = await chrome.storage.local.get({ commandDiagnostics: [] });
      const next = Array.isArray(commandDiagnostics) ? [...commandDiagnostics, entry] : [entry];
      if (next.length > COMMAND_DIAGNOSTIC_MAX_ENTRIES) next.splice(0, next.length - COMMAND_DIAGNOSTIC_MAX_ENTRIES);
      await chrome.storage.local.set({ commandDiagnostics: next });
    });
  return commandDiagnosticWrite;
}

function searchDiagnosticMessage(value) {
  return String(value?.message ?? value ?? "Unknown error")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/https?:\/\/[^\s]+/g, "[url]")
    .replace(/\s+/g, " ")
    .slice(0, 280);
}

function recordSearchDiagnostic(event, fields = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...fields };
  searchDiagnosticWrite = searchDiagnosticWrite
    .catch(() => undefined)
    .then(async () => {
      const { searchDiagnostics = [] } = await chrome.storage.local.get({ searchDiagnostics: [] });
      const entries = Array.isArray(searchDiagnostics) ? searchDiagnostics : [];
      entries.push(entry);
      await chrome.storage.local.set({ searchDiagnostics: entries.slice(-SEARCH_DIAGNOSTIC_MAX_ENTRIES) });
    })
    .catch((error) => console.debug("ResearchTube search diagnostics write failed:", error));
  return searchDiagnosticWrite;
}

async function getDiagnosticsExport() {
  await Promise.all([searchDiagnosticWrite, commandDiagnosticWrite]);
  const { searchDiagnostics = [], commandDiagnostics = [] } = await chrome.storage.local.get({ searchDiagnostics: [], commandDiagnostics: [] });
  const searchEntries = Array.isArray(searchDiagnostics) ? searchDiagnostics : [];
  const commandEntries = Array.isArray(commandDiagnostics) ? commandDiagnostics : [];
  const text = [
    "ResearchTube Diagnostics",
    `Exported: ${new Date().toISOString()}`,
    "Contains concise local tool timing, safe request summaries, errors, search queue state, and YouTube HTTP status. It never includes OpenAI API keys, Tunnel IDs, YouTube cookies, request headers, response bodies, transcript text, or comment text.",
    "",
    "Tool events:",
    ...commandEntries.map((entry) => JSON.stringify(entry)),
    "",
    "Search events:",
    ...searchEntries.map((entry) => JSON.stringify(entry))
  ].join("\n");
  return { ok: true, commandEntryCount: commandEntries.length, searchEntryCount: searchEntries.length, text };
}

async function clearDiagnostics() {
  await Promise.all([searchDiagnosticWrite, commandDiagnosticWrite]);
  await chrome.storage.local.set({ searchDiagnostics: [], commandDiagnostics: [] });
  return { ok: true };
}

function searchCacheKey(query, limit) {
  return `${String(query).trim().toLocaleLowerCase()}\u0000${limit}`;
}

function pruneSearchCache(now = Date.now()) {
  for (const [key, entry] of searchCache.entries()) {
    if (entry.expiresAt <= now) searchCache.delete(key);
  }
}

async function youtubeSearch(query, limit) {
  const now = Date.now();
  pruneSearchCache(now);
  const key = searchCacheKey(query, limit);
  const cached = searchCache.get(key);
  if (cached) {
    void recordSearchDiagnostic("cache_reused", {
      query: searchDiagnosticQuery(query), limit,
      cache_age_ms: Math.max(0, SEARCH_CACHE_TTL_MS - (cached.expiresAt - now))
    });
    return cached.promise;
  }

  const context = {
    request_id: `search-${Date.now().toString(36)}-${++searchRequestSequence}`,
    queued_at: now,
    query: searchDiagnosticQuery(query),
    limit,
    http_requests: 0
  };
  searchQueueDepth += 1;
  void recordSearchDiagnostic("queued", {
    request_id: context.request_id, query: context.query, limit,
    queue_depth: searchQueueDepth
  });

  const task = searchQueue.then(() => runQueuedYouTubeSearch(query, limit, context));
  // Keep the queue alive after a rejected request, while allowing the caller
  // to receive that original rejection.
  searchQueue = task.catch(() => undefined);
  searchCache.set(key, { expiresAt: now + SEARCH_CACHE_TTL_MS, promise: task });
  task.catch(() => searchCache.delete(key));
  task.then(
    () => finishQueuedSearch(context, "completed"),
    (error) => finishQueuedSearch(context, "failed", error)
  );
  return task;
}

function finishQueuedSearch(context, outcome, error = null) {
  searchQueueDepth = Math.max(0, searchQueueDepth - 1);
  void recordSearchDiagnostic("queue_finished", {
    request_id: context.request_id, outcome, queue_depth: searchQueueDepth,
    ...(error ? { error: searchDiagnosticMessage(error) } : {})
  });
}

async function runQueuedYouTubeSearch(query, limit, context) {
  await throwIfSearchCooldown(context);
  const spacing = Math.max(0, (lastSearchStartedAt + SEARCH_MIN_START_INTERVAL_MS) - Date.now());
  if (spacing) await delay(spacing);
  await throwIfSearchCooldown(context);
  lastSearchStartedAt = Date.now();
  void recordSearchDiagnostic("started", {
    request_id: context.request_id, query: context.query, limit,
    queue_wait_ms: lastSearchStartedAt - context.queued_at,
    interval_wait_ms: spacing,
    queue_depth: searchQueueDepth
  });

  try {
    const result = await youtubeSearchViaPageContext(query, limit, context);
    await chrome.storage.local.set({
      youtubeSearchCooldownUntil: 0,
      youtubeSearchCooldownLevel: 0
    });
    void recordSearchDiagnostic("succeeded", {
      request_id: context.request_id, returned: result.returned,
      requested: result.requested, has_more: result.hasMore,
      http_requests: context.http_requests,
      elapsed_ms: Date.now() - lastSearchStartedAt
    });
    return result;
  } catch (error) {
    if (error?.code === "YOUTUBE_SEARCH_VERIFICATION") {
      void recordSearchDiagnostic("verification_rejected", {
        request_id: context.request_id, http_requests: context.http_requests,
        elapsed_ms: Date.now() - lastSearchStartedAt,
        ...(error.search_diagnostic ?? {})
      });
      const retryAfterSeconds = await applySearchCooldown(context);
      throw new YouTubeSearchRateLimitError(retryAfterSeconds);
    }
    void recordSearchDiagnostic("failed", {
      request_id: context.request_id, http_requests: context.http_requests,
      elapsed_ms: Date.now() - lastSearchStartedAt,
      error: searchDiagnosticMessage(error)
    });
    throw error;
  }
}

async function throwIfSearchCooldown(context = null) {
  const config = await getConfig();
  const now = Date.now();
  const cooldownUntil = Number(config.youtubeSearchCooldownUntil || 0);
  const remainingMs = Math.max(0, cooldownUntil - now);
  if (!remainingMs) {
    // The previous build kept the ladder level indefinitely after the delay
    // had elapsed. A later, unrelated rejection could therefore start at
    // 60 seconds. An expired cooldown is a clean slate.
    if (cooldownUntil && Number(config.youtubeSearchCooldownLevel || 0)) {
      await chrome.storage.local.set({
        youtubeSearchCooldownUntil: 0,
        youtubeSearchCooldownLevel: 0
      });
      void recordSearchDiagnostic("cooldown_expired", {
        ...(context ? { request_id: context.request_id } : {}),
        previous_cooldown_level: Number(config.youtubeSearchCooldownLevel || 0)
      });
    }
    return;
  }
  await setActionBadge("youtube-rate-limited");
  void recordSearchDiagnostic("blocked_by_cooldown", {
    ...(context ? { request_id: context.request_id } : {}),
    retry_after_ms: remainingMs,
    cooldown_level: Number(config.youtubeSearchCooldownLevel || 0)
  });
  throw new YouTubeSearchRateLimitError(Math.ceil(remainingMs / 1_000));
}

async function applySearchCooldown(context = null) {
  const config = await getConfig();
  const now = Date.now();
  const priorCooldownActive = Number(config.youtubeSearchCooldownUntil || 0) > now;
  const priorLevel = priorCooldownActive ? Number(config.youtubeSearchCooldownLevel || 0) : 0;
  const nextLevel = Math.min(priorLevel + 1, SEARCH_COOLDOWN_STEPS_MS.length);
  const duration = SEARCH_COOLDOWN_STEPS_MS[nextLevel - 1];
  const retryAfterSeconds = Math.ceil(duration / 1_000);
  await chrome.storage.local.set({
    youtubeSearchCooldownUntil: now + duration,
    youtubeSearchCooldownLevel: nextLevel,
    lastStatus: `YouTube search temporarily limited; retry after ${retryAfterSeconds} seconds`
  });
  await setActionBadge("youtube-rate-limited");
  void recordSearchDiagnostic("cooldown_applied", {
    ...(context ? { request_id: context.request_id } : {}),
    retry_after_ms: duration,
    cooldown_level: nextLevel
  });
  return retryAfterSeconds;
}

function createSearchVerificationError(searchDiagnostic = {}) {
  const error = new Error("YouTube redirected or rejected this anonymous search request");
  error.code = "YOUTUBE_SEARCH_VERIFICATION";
  error.search_diagnostic = searchDiagnostic;
  return error;
}

async function youtubeSearchViaPageContext(query, limit, context) {
  const pageResult = await runYouTubePageTool("search", null, { query, limit });
  for (const item of pageResult.diagnostics || []) {
    context.http_requests = Math.max(context.http_requests, Number(item.request_number || 0));
    void recordSearchDiagnostic(item.event, {
      request_id: context.request_id,
      transport: "youtube-page-context",
      endpoint: item.endpoint,
      request_number: item.request_number,
      ...(item.method ? { method: item.method } : {}),
      ...(Number.isInteger(item.status) ? { status: item.status } : {}),
      ...(item.response_type ? { response_type: item.response_type } : {}),
      ...(typeof item.redirected === "boolean" ? { redirected: item.redirected } : {})
    });
  }
  if (pageResult.verification_rejected) {
    throw createSearchVerificationError({
      endpoint: pageResult.rejected_endpoint || "/results",
      request_number: context.http_requests,
      status: pageResult.rejected_status ?? null,
      response_type: pageResult.rejected_response_type ?? null,
      transport: "youtube-page-context"
    });
  }
  if (!Array.isArray(pageResult.results)) {
    throw new Error("The YouTube page bridge returned an invalid search result");
  }
  void recordSearchDiagnostic("results_page_parsed", {
    request_id: context.request_id,
    transport: "youtube-page-context",
    initial_results: Number(pageResult.initial_results || 0),
    continuation_available: Boolean(pageResult.continuation_available),
    api_key_available: Boolean(pageResult.api_key_available)
  });
  if (pageResult.continuation_rejected) {
    void recordSearchDiagnostic("continuation_rejected_partial", {
      request_id: context.request_id,
      transport: "youtube-page-context",
      returned: Number(pageResult.returned || 0),
      requested: Number(pageResult.requested || limit)
    });
  }
  return {
    query,
    results: pageResult.results,
    returned: Number(pageResult.returned || 0),
    requested: Number(pageResult.requested || limit),
    hasMore: Boolean(pageResult.hasMore)
  };
}

function appendVideoRenderers(data, target) {
  walk(data, (node) => {
    const renderer = node?.videoRenderer;
    if (!renderer?.videoId || target.some((item) => item.videoId === renderer.videoId)) return;
    target.push(normalizeVideoRenderer(renderer));
  });
}

function normalizeVideoRenderer(renderer) {
  const viewsText = textOf(renderer.viewCountText) || null;
  return {
    videoId: renderer.videoId,
    title: textOf(renderer.title),
    channel: textOf(renderer.ownerText) || textOf(renderer.longBylineText),
    durationText: textOf(renderer.lengthText) || null,
    publishedText: textOf(renderer.publishedTimeText) || null,
    views: parseYouTubeCount(viewsText),
    viewsText,
    snippet: textOf(renderer.detailedMetadataSnippets?.[0]?.snippetText) || textOf(renderer.snippet) || null
  };
}

async function youtubeGetVideo(videoId) {
  const { player, initial } = await fetchVideoPage(videoId);
  const details = player?.videoDetails;
  if (!details?.videoId) throw new Error("YouTube video metadata was not found");
  const microformat = player?.microformat?.playerMicroformatRenderer ?? {};
  const tracks = captionTracks(player).map(normalizeCaptionTrack);
  const viewsText = findViewText(initial) || (details.viewCount ? `${details.viewCount} views` : null);
  const likesText = findLikeText(initial);
  const commentCountText = findCommentCountText(initial);
  return {
    videoId,
    title: details.title, description: details.shortDescription || "",
    channel: { name: details.author || null, channelId: details.channelId || null },
    publishedAt: microformat.publishDate || microformat.uploadDate || null,
    durationSeconds: Number(details.lengthSeconds || 0) || null,
    views: Number.isFinite(Number(details.viewCount)) ? Number(details.viewCount) : parseYouTubeCount(viewsText),
    viewsText,
    likes: parseYouTubeCount(likesText),
    likesText,
    commentCount: parseYouTubeCount(commentCountText),
    commentCountText,
    category: microformat.category || null, tags: microformat.tags || [], thumbnailUrl: details.thumbnail?.thumbnails?.at(-1)?.url || null,
    captions: { available: tracks.length > 0, tracks },
    downloadFormats: normalizeDownloadFormats(player?.streamingData)
  };
}

function normalizeDownloadFormats(streamingData) {
  const grouped = { available: false, source: "unavailable", message: "YouTube did not expose downloadable media formats for this video.", combined: [], video: [], audio: [] };
  const seen = new Set();
  const candidates = [
    ...(Array.isArray(streamingData?.formats) ? streamingData.formats : []),
    ...(Array.isArray(streamingData?.adaptiveFormats) ? streamingData.adaptiveFormats : [])
  ];

  for (const format of candidates) {
    const item = normalizeDownloadFormat(format);
    if (!item || seen.has(item.formatId)) continue;
    seen.add(item.formatId);
    grouped[item.kind].push(item);
  }

  for (const group of [grouped.combined, grouped.video, grouped.audio]) {
    group.sort(compareDownloadFormats);
  }
  grouped.available = candidates.length > 0 && seen.size > 0;
  if (grouped.available) {
    grouped.source = "youtube";
    grouped.message = null;
  }
  return grouped;
}

function normalizeDownloadFormat(format) {
  const formatId = String(format?.itag ?? "").trim();
  const mime = parseYouTubeMimeType(format?.mimeType);
  if (!formatId || !mime.mediaType || (mime.mediaType !== "video" && mime.mediaType !== "audio")) return null;

  const videoCodec = mime.codecs.find((codec) => !isAudioCodec(codec)) || null;
  const audioCodec = mime.codecs.find(isAudioCodec) || null;
  const kind = mime.mediaType === "audio" ? "audio" : (audioCodec ? "combined" : "video");
  return {
    formatId,
    kind,
    container: mime.container,
    videoCodec,
    audioCodec,
    width: finiteNonNegativeInteger(format?.width),
    height: finiteNonNegativeInteger(format?.height),
    fps: finiteNonNegativeNumber(format?.fps),
    bitrateBps: finiteNonNegativeInteger(format?.averageBitrate ?? format?.bitrate),
    audioSampleRateHz: finiteNonNegativeInteger(format?.audioSampleRate),
    audioChannels: finiteNonNegativeInteger(format?.audioChannels),
    qualityLabel: typeof format?.qualityLabel === "string" && format.qualityLabel.trim() ? format.qualityLabel.trim() : null,
    sizeBytes: finiteSafeInteger(format?.contentLength)
  };
}

function parseYouTubeMimeType(value) {
  const source = typeof value === "string" ? value : "";
  const match = source.match(/^\s*(video|audio)\/([^;\s]+)(?:\s*;\s*codecs="([^"]*)")?/i);
  return {
    mediaType: match?.[1]?.toLowerCase() || null,
    container: match?.[2]?.toLowerCase() || null,
    codecs: match?.[3] ? match[3].split(",").map((codec) => codec.trim()).filter(Boolean) : []
  };
}

function isAudioCodec(codec) {
  return /^(mp4a|aac|opus|vorbis|ac-3|ec-3|flac)/i.test(codec);
}

function finiteNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function finiteNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function finiteSafeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function compareDownloadFormats(left, right) {
  const leftPixels = (left.width || 0) * (left.height || 0);
  const rightPixels = (right.width || 0) * (right.height || 0);
  return rightPixels - leftPixels
    || (right.fps || 0) - (left.fps || 0)
    || (right.bitrateBps || 0) - (left.bitrateBps || 0)
    || left.formatId.localeCompare(right.formatId, undefined, { numeric: true });
}

async function youtubeGetTranscript(videoId, limit, trackIndex) {
  return runYouTubePageTool("transcript", videoId, { limit, trackIndex });
}

async function youtubeGetComments(videoId, limit, sort) {
  return runYouTubePageTool("comments", videoId, { limit, sort });
}

async function youtubeGetCommentReplies(videoId, commentId, limit) {
  return runYouTubePageTool("replies", videoId, { commentId, limit });
}

async function youtubeGetChannelVideos(args) {
  return runYouTubePageTool("channel-videos", null, args);
}

async function youtubeGetChannelPlaylists(args) {
  return runYouTubePageTool("channel-playlists", null, args);
}

async function youtubeGetPlaylistVideos(args) {
  return runYouTubePageTool("playlist-videos", null, args);
}

function requireCatalogueIdentifier(value, label) {
  const identifier = String(value ?? "").trim();
  if (identifier.length < 2 || identifier.length > 2_000) throw new Error(`${label} is required`);
  return identifier;
}

function optionalContinuation(value) {
  if (value === undefined || value === null || value === "") return null;
  const continuation = String(value);
  if (continuation.length > 20_000) throw new Error("continuation is too long");
  return continuation;
}

async function runYouTubePageTool(action, videoId, args) {
  try {
    return await runYouTubePageToolAttempt(action, videoId, args);
  } catch (error) {
    if (!isRecoverablePageContextError(error)) throw error;

    // A user can close a tab after it was selected but before the page-world
    // bridge replies. Recover once, but never create another tab while any
    // YouTube tab is already open.
    try {
      return await runYouTubePageToolAttempt(action, videoId, args);
    } catch (retryError) {
      if (isRecoverablePageContextError(retryError)) {
        throw new Error("ResearchTube could not restore its YouTube page context after one automatic retry. Please repeat the request.");
      }
      throw retryError;
    }
  }
}

async function runYouTubePageToolAttempt(action, videoId, args) {
  const { tab } = await getOrCreateYouTubeTab();
  const startedAt = Date.now();
  const response = await sendYouTubePageTool(tab.id, {
    type: "youtube-ui-tool",
    action,
    videoId,
    args
  });
  // Capture only HTTP metadata generated during this command. The MAIN-world
  // bridge itself never returns bodies, captions, comments, headers, or
  // credentials through this diagnostic path.
  try {
    const trace = await sendYouTubePageTool(tab.id, {
      type: "youtube-ui-tool",
      action: "network-after",
      args: { after: startedAt }
    });
    for (const item of trace?.data?.responses || []) {
      const url = new URL(item.url);
      void recordCommandDiagnostic("youtube_http_response", {
        action,
        ...(videoId ? { videoId } : {}),
        endpoint: url.pathname.replace("/youtubei/v1/", "youtubei/"),
        method: item.method || "GET",
        status: Number(item.status || 0),
        response_type: item.responseType || null,
        redirected: Boolean(item.redirected)
      });
    }
  } catch (error) {
    void recordCommandDiagnostic("page_diagnostics_unavailable", {
      action,
      ...(videoId ? { videoId } : {}),
      error: searchDiagnosticMessage(error)
    });
  }
  if (!response) throw createPageContextError("The YouTube page bridge did not return a result");
  if (!response.ok) throw new Error(response.error || "The YouTube page bridge did not return a result");
  return response.data;
}

function createPageContextError(message, cause) {
  const error = new Error(message);
  error.code = "RESEARCHTUBE_PAGE_CONTEXT_UNAVAILABLE";
  if (cause) error.cause = cause;
  return error;
}

function isRecoverablePageContextError(error) {
  if (error?.code === "RESEARCHTUBE_PAGE_CONTEXT_UNAVAILABLE") return true;
  const message = String(error?.message || error || "");
  return /No tab with id|tab was closed|Receiving end does not exist|Could not establish connection|message port closed|frame with ID .* was removed|Cannot access contents of url|MAIN-world bridge timed out/i.test(message);
}

async function getOrCreateYouTubeTab() {
  const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/*"] });
  if (tabs[0]?.id) return { tab: tabs[0], created: false };

  return { tab: await createYouTubeTab(), created: true };
}

async function createYouTubeTab() {
  const createdTab = await chrome.tabs.create({
    url: "https://www.youtube.com/",
    active: false
  });
  if (!createdTab?.id) {
    throw new Error("Chrome could not create a YouTube tab for the request");
  }
  return waitForYouTubeTab(createdTab.id);
}

async function waitForYouTubeTab(tabId, timeoutMs = 45_000) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete" && /^https:\/\/www\.youtube\.com\//.test(current.url || "")) return current;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(() => reject(new Error("The newly created YouTube tab did not finish loading within 45 seconds"))), timeoutMs);
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      if (!/^https:\/\/www\.youtube\.com\//.test(tab.url || "")) {
        finish(() => reject(new Error("The newly created tab did not load youtube.com")));
        return;
      }
      finish(() => resolve(tab));
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) finish(() => reject(new Error("The newly created YouTube tab was closed before it loaded")));
    };
    const finish = (callback) => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      callback();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function sendYouTubePageTool(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(String(error?.message || error))) {
      if (isRecoverablePageContextError(error)) {
        throw createPageContextError("The selected YouTube tab is no longer available", error);
      }
      throw error;
    }
  }

  // A tab opened before the extension was installed does not yet contain the
  // declarative content scripts. Inject both bridge layers once on demand.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["youtube-page-bridge.js"],
      world: "MAIN",
      injectImmediately: true
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["youtube-content.js"],
      world: "ISOLATED",
      injectImmediately: true
    });
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (isRecoverablePageContextError(error)) {
      throw createPageContextError("The selected YouTube tab became unavailable while preparing the page bridge", error);
    }
    throw error;
  }
}

function normalizeCommentThread(thread, rank) {
  const comment = thread.comment ?? {};
  const likesText = normalizeText(comment.like_count);
  const replyCountText = normalizeText(comment.reply_count_a11y) || normalizeText(comment.reply_count);
  return {
    rank,
    commentId: comment.comment_id,
    text: String(comment.content?.toString?.() ?? ""),
    author: { name: comment.author?.name ?? null, channelId: comment.author?.id ?? null },
    publishedAt: null,
    publishedText: normalizeText(comment.published_time),
    likes: parseYouTubeCount(comment.like_count_a11y ?? likesText),
    likesText,
    replyCount: parseYouTubeCount(comment.reply_count_a11y ?? comment.reply_count),
    replyCountText,
    isPinned: Boolean(comment.is_pinned),
    isHearted: Boolean(comment.is_hearted),
    hasReplies: Boolean(thread.has_replies),
    authorIsCreator: Boolean(comment.author_is_channel_owner),
    creatorReplied: null
  };
}

async function fetchVideoPage(videoId) {
  const response = await fetchStandardWatchPage(videoId);
  if (!response.ok) throw new Error(`YouTube HTTP ${response.status}`);
  const html = await response.text();
  const player = extractAnyJson(html, ["var ytInitialPlayerResponse =", "ytInitialPlayerResponse ="]);
  if (!player) throw new Error("ytInitialPlayerResponse was not found (consent or changed YouTube page)");
  return { player, initial: extractAnyJson(html, ["var ytInitialData =", "ytInitialData ="]) };
}

async function fetchStandardWatchPage(videoId) {
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
      credentials: "omit",
      headers: { Accept: "text/html" }
    });
    void recordCommandDiagnostic("youtube_http_response", {
      action: "youtube_get_video", videoId, endpoint: "/watch", method: "GET",
      status: response.status, response_type: response.type, redirected: response.redirected
    });
    return response;
  } catch (error) {
    void recordCommandDiagnostic("youtube_http_network_error", {
      action: "youtube_get_video", videoId, endpoint: "/watch", method: "GET",
      error: searchDiagnosticMessage(error)
    });
    throw error;
  }
}

function captionTracks(player) {
  return player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
}

function normalizeCaptionTrack(track, trackIndex) {
  return { trackIndex, languageCode: track.languageCode || null, name: textOf(track.name) || null, isAutoGenerated: track.kind === "asr" };
}

function textOf(value) { return value?.simpleText ?? value?.runs?.map((run) => run.text ?? "").join("") ?? ""; }

function findContinuationToken(value) {
  let token = null;
  walk(value, (node) => { if (!token && node?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token) token = node.continuationItemRenderer.continuationEndpoint.continuationCommand.token; });
  return token;
}

function findLikeText(value) {
  let likes = null;
  walk(value, (node) => {
    if (likes || !node || typeof node !== "object") return;
    // Older watch pages expose defaultText here. Current pages increasingly
    // use buttonViewModel and put the actual number in accessibilityText.
    // Check both representations and accept only a numeric "likes" label,
    // never a generic prompt such as "Like this video".
    const oldRenderer = node?.segmentedLikeDislikeButtonRenderer?.likeButton?.toggleButtonRenderer;
    const candidates = [
      oldRenderer?.defaultText,
      oldRenderer?.accessibility?.accessibilityData?.label,
      node.accessibilityText,
      node.accessibility?.accessibilityData?.label,
      node.buttonViewModel?.accessibilityText,
      node.defaultButtonViewModel?.buttonViewModel?.accessibilityText,
      node.toggleButtonViewModel?.defaultButtonViewModel?.buttonViewModel?.accessibilityText,
      node.likeButtonViewModel?.toggleButtonViewModel?.defaultButtonViewModel?.buttonViewModel?.accessibilityText
    ];
    for (const candidate of candidates) {
      const text = textOf(candidate) || (typeof candidate === "string" ? candidate : "");
      if (isLikeCountText(text)) {
        likes = text;
        break;
      }
    }
  });
  return likes;
}

function isLikeCountText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  // YouTube's browser accessibility label is localised, but it always couples
  // a number with the equivalent of "like". Keep this conservative so a
  // descriptive prompt cannot be misreported as a count.
  return /\d/.test(text) && /\b(?:likes?|thumbs up)\b|нравится|отмет(?:ок|ки)?\s+[«\"]?нравится/i.test(text);
}

function findViewText(value) {
  let views = null;
  walk(value, (node) => {
    if (!views && node?.videoPrimaryInfoRenderer?.viewCount?.videoViewCountRenderer?.viewCount) {
      views = textOf(node.videoPrimaryInfoRenderer.viewCount.videoViewCountRenderer.viewCount);
    }
  });
  return views;
}

function findCommentCountText(value) {
  let count = null;
  walk(value, (node) => {
    if (!count && node?.commentsEntryPointHeaderRenderer?.commentCount) {
      count = textOf(node.commentsEntryPointHeaderRenderer.commentCount);
    }
  });
  return count;
}

function normalizeText(value) {
  const text = String(value?.toString?.() ?? value ?? "").trim();
  return text || null;
}

function parseYouTubeCount(value) {
  const text = normalizeText(value);
  if (!text) return null;
  const compact = text.replace(/[\u00A0\u202F\s]/g, "");
  // Spaces were removed above: "1.2M views" is now "1.2Mviews". The
  // compact abbreviations used by YouTube are uppercase, which avoids
  // mistaking ordinary words such as "minutes" for a multiplier.
  const suffix = compact.match(/(\d+(?:[.,]\d+)?)\s*([KMBT])/);
  if (suffix) {
    const amount = Number(suffix[1].replace(",", "."));
    const multiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000, T: 1_000_000_000_000 }[suffix[2].toUpperCase()];
    return Number.isFinite(amount) && multiplier ? Math.round(amount * multiplier) : null;
  }
  const digits = compact.replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

function extractConfigString(html, key) {
  const match = html.match(new RegExp(`"${key}":"([^"\\\\]+)"`));
  return match?.[1] ?? null;
}

function walk(value, visitor) {
  visitor(value);
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) walk(child, visitor);
}

function extractAnyJson(text, markers) {
  for (const marker of markers) {
    const result = extractJsonAfterMarker(text, marker);
    if (result) return result;
  }
  return null;
}

function extractJsonAfterMarker(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const objectStart = text.indexOf("{", start + marker.length);
  if (objectStart < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = objectStart; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(objectStart, i + 1)); } catch { return null; }
    }
  }
  return null;
}
