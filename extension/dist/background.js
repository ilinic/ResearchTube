// background.js
var CONTROL_PLANE_BASE_URL = "https://api.openai.com";
var EXTERNAL_URLS = Object.freeze({
  tunnels: "https://platform.openai.com/settings/organization/tunnels",
  apiKeys: "https://platform.openai.com/settings/organization/api-keys",
  chatgpt: "https://chatgpt.com/plugins",
  chatgptNewChat: "https://chatgpt.com/",
  chatgptSettings: "https://chatgpt.com/#settings/Connectors"
});
var DEFAULTS = {
  tunnelId: "",
  runtimeApiKey: "",
  onboardingCompleted: false,
  lastConnectionTest: null,
  agentPort: 17843,
  youtubeSearchCooldownUntil: 0,
  youtubeSearchCooldownLevel: 0
};
var EXTENSION_VERSION = "1.13.12";
var REQUIRED_AGENT_INTERFACE_VERSION = 12;
var CAPTURE_FRAME_WIDGET_URI = "ui://researchtube/capture-frame-v12.html";
var CAPTURE_FRAME_OFFSCREEN_DOCUMENT = "capture-frame-offscreen.html";
var AGENT_HEALTH_TIMEOUT_MS = 5e3;
var AGENT_TASK_TIMEOUT_MS = 1e4;
var AGENT_CAPTURE_FRAME_TIMEOUT_MS = 9e4;
var POLL_RETRY_DELAY_MS = 250;
var SEARCH_MIN_START_INTERVAL_MS = 500;
var SEARCH_CACHE_TTL_MS = 5 * 6e4;
var SEARCH_COOLDOWN_STEPS_MS = [2e3, 5e3, 1e4, 2e4, 4e4, 6e4];
var SEARCH_DIAGNOSTIC_MAX_ENTRIES = 250;
var SEARCH_DIAGNOSTIC_MAX_QUERY_LENGTH = 360;
var COMMAND_DIAGNOSTIC_MAX_ENTRIES = 300;
var polling = false;
var currentPollPromise = null;
var pollLoopScheduled = false;
var pollLoopTimer = null;
var lastSearchStartedAt = 0;
var searchQueue = Promise.resolve();
var searchQueueDepth = 0;
var searchRequestSequence = 0;
var searchDiagnosticWrite = Promise.resolve();
var commandDiagnosticWrite = Promise.resolve();
var captureFrameOffscreenPromise = null;
var searchCache = /* @__PURE__ */ new Map();
var nullableString = { type: ["string", "null"] };
var nullableInteger = { type: ["integer", "null"] };
var nullableNumber = { type: ["number", "null"] };
var downloadFormatSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    formatId: { type: "string", description: "Numeric media format identifier in this exact source snapshot. For youtube_download, select a numeric ID only when it was returned by youtube_get_download_formats, not merely by youtubeFormats." },
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
    sizeBytes: { ...nullableInteger, minimum: 0, description: "Source-reported byte length when available. Direct YouTube snapshots use contentLength; yt-dlp may report an exact or estimated size. For two manually selected tracks, their sum is only a near-final output-size estimate before container overhead." }
  },
  required: ["formatId", "kind", "container", "videoCodec", "audioCodec", "width", "height", "fps", "bitrateBps", "audioSampleRateHz", "audioChannels", "qualityLabel", "sizeBytes"]
};
var youtubeFormatsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    available: { type: "boolean", description: "True when the current public YouTube player response exposed at least one usable media stream." },
    source: { type: "string", enum: ["youtube", "unavailable"], description: "youtube means the list came directly from the YouTube player response used for this video card. It is advisory: this list can differ from the formats that local yt-dlp can download." },
    message: { ...nullableString, description: "Why formats are unavailable, if known. It never contains media URLs, credentials, or local paths." },
    combined: { type: "array", items: downloadFormatSchema, description: "YouTube streams that already contain both video and audio and therefore do not need merging." },
    video: { type: "array", items: downloadFormatSchema, description: "YouTube video-only tracks. Pair one with an audio track to download and merge through ffmpeg." },
    audio: { type: "array", items: downloadFormatSchema, description: "YouTube audio-only tracks. They can be downloaded alone or paired with one video track." }
  },
  required: ["available", "source", "message", "combined", "video", "audio"]
};
var ytDlpDownloadFormatsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    available: { type: "boolean", description: "True when this Local Agent's current yt-dlp process successfully exposed at least one selectable media stream." },
    source: { type: "string", enum: ["ytDlp", "unavailable"], description: "ytDlp means the list came from the same local yt-dlp installation that youtube_download will invoke. unavailable means that local discovery did not yield usable formats." },
    message: { ...nullableString, description: "Why the local yt-dlp format list is unavailable, if known. It never contains media URLs, credentials, host paths, or raw process output." },
    combined: { type: "array", items: downloadFormatSchema, description: "Ready-made video+audio formats confirmed by local yt-dlp. Select an exact numeric formatId here as selection.combined." },
    video: { type: "array", items: downloadFormatSchema, description: "Video-only formats confirmed by local yt-dlp. Select one exact numeric formatId here as selection.video." },
    audio: { type: "array", items: downloadFormatSchema, description: "Audio-only formats confirmed by local yt-dlp. Select one exact numeric formatId here as selection.audio." }
  },
  required: ["available", "source", "message", "combined", "video", "audio"]
};
var youtubeDownloadFormatsResultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    videoId: { type: "string", description: "The requested public YouTube video ID." },
    downloadFormats: ytDlpDownloadFormatsSchema
  },
  required: ["videoId", "downloadFormats"]
};
var videoSearchItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    videoId: { type: "string" },
    title: { type: "string" },
    channel: { type: "string" },
    durationText: nullableString,
    publishedText: nullableString,
    views: nullableInteger,
    viewsText: nullableString,
    snippet: nullableString
  },
  required: ["videoId", "title", "channel", "durationText", "publishedText", "views", "viewsText", "snippet"]
};
var channelIdentitySchema = {
  type: "object",
  additionalProperties: false,
  properties: { id: nullableString, name: nullableString, handle: nullableString },
  required: ["id", "name", "handle"]
};
var channelVideoItemSchema = {
  type: "object",
  additionalProperties: false,
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
var playlistItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    playlistId: { type: "string", description: "Public playlist ID accepted by youtube_get_playlist_videos." },
    title: { type: "string", description: "Public playlist title as displayed by YouTube." },
    videoCount: { ...nullableInteger, minimum: 0, description: "Integer playlist size parsed from videoCountText; null when YouTube does not display it." },
    videoCountText: { ...nullableString, description: "Original YouTube playlist-size label; retained alongside videoCount." },
    thumbnailUrl: { ...nullableString, format: "uri", description: "Public thumbnail URL when supplied by YouTube." }
  },
  required: ["playlistId", "title", "videoCount", "videoCountText", "thumbnailUrl"]
};
var playlistIdentitySchema = {
  type: "object",
  additionalProperties: false,
  properties: { id: { type: "string" }, title: nullableString, channelId: nullableString, channelName: nullableString },
  required: ["id", "title", "channelId", "channelName"]
};
var captionTrackSchema = {
  type: "object",
  additionalProperties: false,
  properties: { trackIndex: { type: "integer", minimum: 0 }, languageCode: nullableString, name: nullableString, isAutoGenerated: { type: "boolean" } },
  required: ["trackIndex", "languageCode", "name", "isAutoGenerated"]
};
var commentAuthorSchema = {
  type: "object",
  additionalProperties: false,
  properties: { name: nullableString, channelId: nullableString },
  required: ["name", "channelId"]
};
var commentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    rank: { type: "integer", minimum: 1 },
    commentId: { type: "string" },
    author: commentAuthorSchema,
    text: { type: "string" },
    publishedAt: nullableString,
    publishedText: nullableString,
    likes: nullableInteger,
    likesText: nullableString,
    replyCount: nullableInteger,
    replyCountText: nullableString,
    isPinned: { type: "boolean" },
    isHearted: { type: "boolean" },
    hasReplies: { type: "boolean" },
    authorIsCreator: { type: "boolean" },
    creatorReplied: { type: ["boolean", "null"] }
  },
  required: ["rank", "commentId", "author", "text", "publishedAt", "publishedText", "likes", "likesText", "replyCount", "replyCountText", "isPinned", "isHearted", "hasReplies", "authorIsCreator", "creatorReplied"]
};
var replySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    rank: { type: "integer", minimum: 1 },
    commentId: { type: "string" },
    author: commentAuthorSchema,
    text: { type: "string" },
    publishedAt: nullableString,
    publishedText: nullableString,
    likes: nullableInteger,
    likesText: nullableString,
    authorIsCreator: { type: "boolean" },
    isHearted: { type: "boolean" }
  },
  required: ["rank", "commentId", "author", "text", "publishedAt", "publishedText", "likes", "likesText", "authorIsCreator", "isHearted"]
};
var commentParentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    commentId: { type: "string" },
    text: { type: "string" },
    likes: nullableInteger,
    likesText: nullableString,
    replyCount: nullableInteger,
    replyCountText: nullableString
  },
  required: ["commentId", "text", "likes", "likesText", "replyCount", "replyCountText"]
};
var agentWorkspaceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["available", "error"] },
    availableBytes: { ...nullableInteger, minimum: 0, description: "Free bytes on the filesystem that contains the Local Agent workspace; null when the workspace cannot be inspected." }
  },
  required: ["status", "availableBytes"]
};
var agentComponentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["available", "missing", "error"] },
    version: nullableString,
    source: { anyOf: [{ type: "string", enum: ["local", "path"] }, { type: "null" }] },
    message: nullableString
  },
  required: ["status", "version", "source", "message"]
};
var agentPlatformSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    operatingSystem: { type: "string", description: "Public operating-system family reported by the Local Agent, such as Windows, Linux, or Darwin." },
    release: { type: "string", description: "Public operating-system release reported by the Local Agent." },
    version: { type: "string", description: "Public operating-system version string reported by the Local Agent." },
    architecture: { type: "string", description: "Processor architecture reported by the Local Agent, such as AMD64 or arm64." }
  },
  required: ["operatingSystem", "release", "version", "architecture"]
};
var agentStatusSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    available: { type: "boolean", description: "Whether the optional Local Agent responded on the configured loopback port." },
    error: nullableString,
    message: { type: "string" },
    status: nullableString,
    extensionVersion: { type: "string", description: "ResearchTube Chrome Extension implementation version that is serving this MCP response." },
    extensionInterfaceVersion: { type: "integer", minimum: 1, description: "Extension \u2194 Agent interface version required by this Extension." },
    agentVersion: nullableString,
    interfaceVersion: { ...nullableInteger, minimum: 1, description: "Local Agent interface version. null means the response did not contain a readable positive integer, so the Agent is not accepted for Agent tools." },
    platform: { anyOf: [agentPlatformSchema, { type: "null" }], description: "Public operating-system information for the machine running the Local Agent. It excludes host name, user name, paths, network addresses, and other host identifiers." },
    workspace: { anyOf: [agentWorkspaceSchema, { type: "null" }] },
    components: {
      anyOf: [{
        type: "object",
        additionalProperties: false,
        properties: { ytDlp: agentComponentSchema, deno: agentComponentSchema, ffmpeg: agentComponentSchema, ffprobe: agentComponentSchema },
        required: ["ytDlp", "deno", "ffmpeg", "ffprobe"]
      }, { type: "null" }]
    }
  },
  required: ["available", "error", "message", "status", "extensionVersion", "extensionInterfaceVersion", "agentVersion", "interfaceVersion", "platform", "workspace", "components"]
};
var youtubeDownloadResultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    videoId: { type: "string", description: "YouTube video ID requested for download." },
    filePath: { type: "string", description: "Path relative to the Local Agent workspace; it never exposes an arbitrary system path." },
    fileName: { type: "string", description: "Sanitized downloaded filename, including [yt_<videoId>] and the task ID." },
    outputDir: { type: "string", description: "Workspace-relative output directory used for this download." }
  },
  required: ["videoId", "filePath", "fileName", "outputDir"]
};
var downloadSelectionValueSchema = {
  anyOf: [
    { type: "string", enum: ["best"] },
    { type: "string", pattern: "^[0-9]+$" },
    { type: "null" }
  ]
};
var downloadSelectionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    combined: { ...downloadSelectionValueSchema, description: "One ready-made audio+video track: 'best' or a numeric formatId from youtube_get_download_formats.downloadFormats.combined. Do not set video or audio at the same time." },
    video: { ...downloadSelectionValueSchema, description: "One video-only track: 'best' or a numeric formatId from youtube_get_download_formats.downloadFormats.video." },
    audio: { ...downloadSelectionValueSchema, description: "One audio-only track: 'best' or a numeric formatId from youtube_get_download_formats.downloadFormats.audio." }
  },
  description: "Select exactly one mode: combined alone; video alone; audio alone; or video plus audio. With video plus audio the Agent merges the exact tracks into MP4 without re-encoding."
};
var downloadPhaseSchema = {
  type: "string",
  enum: ["preparing", "downloadingCombined", "downloadingVideo", "downloadingAudio", "merging", "completed", "failed", "cancelled"]
};
var downloadTaskErrorSchema = {
  type: "object",
  additionalProperties: false,
  properties: { code: { type: "string" }, message: { type: "string" }, detail: nullableString },
  required: ["code", "message", "detail"]
};
var youtubeDownloadStartSchema = {
  type: "object",
  additionalProperties: false,
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
var youtubeDownloadTaskSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    taskId: { type: "string" },
    status: { type: "string", enum: ["working", "completed", "failed", "cancelled"] },
    statusMessage: { type: "string" },
    phase: { ...downloadPhaseSchema, description: "Current task operation. A video+audio download normally advances downloadingVideo \u2192 downloadingAudio \u2192 merging \u2192 completed." },
    createdAt: { type: "string", format: "date-time" },
    lastUpdatedAt: { type: "string", format: "date-time", description: "Updated on a yt-dlp progress event, a lifecycle transition, or at least every few seconds while the child process is alive." },
    pollIntervalMs: { type: "integer", minimum: 100 },
    progressPercent: { type: ["number", "null"], minimum: 0, maximum: 100, description: "yt-dlp percentage for the current phase, not an invented whole-task percentage. It resets when a selected video+audio task advances from video to audio, is null while merging, and is 100 only after completed." },
    result: { anyOf: [youtubeDownloadResultSchema, { type: "null" }] },
    error: { anyOf: [downloadTaskErrorSchema, { type: "null" }] }
  },
  required: ["taskId", "status", "statusMessage", "phase", "createdAt", "lastUpdatedAt", "pollIntervalMs", "progressPercent", "result", "error"]
};
var cancelDownloadTaskSchema = {
  type: "object",
  additionalProperties: false,
  properties: { taskId: { type: "string" }, accepted: { type: "boolean" }, message: { type: "string" } },
  required: ["taskId", "accepted", "message"]
};
var downloadTaskEventSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    eventId: { type: "integer", minimum: 1 },
    at: { type: "string", format: "date-time" },
    kind: { type: "string" },
    phase: downloadPhaseSchema,
    message: nullableString,
    process: { type: ["string", "null"], enum: ["ytDlp", null] },
    exitCode: nullableInteger,
    errorCode: nullableString,
    workspacePath: nullableString,
    removedWorkspacePaths: { type: "array", items: { type: "string" } }
  },
  required: ["eventId", "at", "kind", "phase", "message", "process", "exitCode", "errorCode", "workspacePath", "removedWorkspacePaths"]
};
var downloadTaskDiagnosticsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    taskId: { type: "string" },
    status: { type: "string", enum: ["working", "completed", "failed", "cancelled"] },
    phase: downloadPhaseSchema,
    error: { anyOf: [downloadTaskErrorSchema, { type: "null" }] },
    process: { type: "object", additionalProperties: false, properties: {
      ytDlpExitCode: nullableInteger,
      finalOutput: { type: "string", enum: ["notReported", "reportedButMissing", "verified"] },
      cleanupRemovedCount: { type: "integer", minimum: 0 }
    }, required: ["ytDlpExitCode", "finalOutput", "cleanupRemovedCount"] },
    events: { type: "array", maxItems: 100, items: downloadTaskEventSchema },
    returned: { type: "integer", minimum: 0, maximum: 100 },
    nextEventId: { type: "integer", minimum: 0 }
  },
  required: ["taskId", "status", "phase", "error", "process", "events", "returned", "nextEventId"]
};
var workspaceEntrySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "One name within the listed workspace directory, never a host path." },
    path: { type: "string", description: "Logical POSIX-style path relative to the ResearchTube workspace." },
    type: { type: "string", enum: ["file", "directory", "other"] },
    size: { ...nullableInteger, minimum: 0, description: "Byte length for a regular file; null for directories and other objects." }
  },
  required: ["name", "path", "type", "size"]
};
var workspaceListSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", description: "The listed logical workspace directory; an empty string represents the workspace root." },
    entries: { type: "array", maxItems: 500, items: workspaceEntrySchema },
    returned: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 500 }
  },
  required: ["path", "entries", "returned", "limit"]
};
var workspaceStatSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", description: "Logical POSIX-style path relative to the ResearchTube workspace." },
    type: { type: "string", enum: ["file", "directory"] },
    size: { ...nullableInteger, minimum: 0 },
    modifiedAt: { type: "string", format: "date-time" }
  },
  required: ["path", "type", "size", "modifiedAt"]
};
var workspaceMkdirSchema = {
  type: "object",
  additionalProperties: false,
  properties: { path: { type: "string" }, type: { type: "string", const: "directory" }, created: { type: "boolean" } },
  required: ["path", "type", "created"]
};
var workspaceMoveSchema = {
  type: "object",
  additionalProperties: false,
  properties: { source: { type: "string" }, destination: { type: "string" }, type: { type: "string", enum: ["file", "directory"] } },
  required: ["source", "destination", "type"]
};
var workspaceDeleteSchema = {
  type: "object",
  additionalProperties: false,
  properties: { path: { type: "string" }, type: { type: "string", enum: ["file", "directory"] }, deleted: { type: "boolean", const: true } },
  required: ["path", "type", "deleted"]
};
var mediaProbeSectionSchema = { type: "string", enum: ["format", "streams", "chapters", "programs"] };
var ffprobeObjectSchema = { type: "object", additionalProperties: true };
var mediaProbeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", description: "Logical POSIX-style media-file path relative to the ResearchTube workspace." },
    fileSizeBytes: { type: "integer", minimum: 0, description: "Actual byte length of the workspace file, read by the Local Agent from the filesystem." },
    ffprobeFileSizeBytes: { ...nullableInteger, minimum: 0, description: "Byte length reported by ffprobe's native format.size field; null when format was not requested or ffprobe did not report a usable size." },
    sections: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: mediaProbeSectionSchema },
    probe: {
      type: "object",
      additionalProperties: false,
      properties: {
        format: ffprobeObjectSchema,
        streams: { type: "array", items: ffprobeObjectSchema },
        chapters: { type: "array", items: ffprobeObjectSchema },
        programs: { type: "array", items: ffprobeObjectSchema }
      }
    }
  },
  required: ["path", "fileSizeBytes", "ffprobeFileSizeBytes", "sections", "probe"]
};
var captureFrameFormatSchema = { type: "string", enum: ["png", "jpeg", "webp"] };
var captureFrameDeliveryModeSchema = { const: "workspace", description: "Every captured image is saved in the ResearchTube workspace." };
var captureFrameCropSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    x: { type: "integer", minimum: 0 },
    y: { type: "integer", minimum: 0 },
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 }
  },
  required: ["x", "y", "width", "height"]
};
var captureFrameAnchorSchema = {
  type: "object",
  additionalProperties: false,
  properties: { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 } },
  required: ["x", "y"]
};
var captureFrameResizeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
    mode: { type: "string", enum: ["contain", "cover", "stretch"], default: "contain" },
    anchor: captureFrameAnchorSchema,
    padColor: { type: "string", pattern: "^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$", default: "#000000" }
  },
  anyOf: [{ required: ["width"] }, { required: ["height"] }]
};
var captureFrameImageInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    format: { ...captureFrameFormatSchema, default: "png" },
    quality: { type: "integer", minimum: 1, maximum: 100, description: "JPEG/WebP quality. It is invalid for PNG." },
    compressionLevel: { type: "integer", minimum: 0, maximum: 9, description: "PNG compression level. It is invalid for JPEG/WebP." }
  }
};
var captureFrameDeliveryInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    workspacePath: { type: "string", minLength: 1, description: "Optional logical workspace-relative output image path. If omitted, the Agent creates a unique file under captures/. capture_frame never overwrites an existing file." },
    saveToLibrary: { type: "boolean", default: false, description: "When true, the ChatGPT widget uploads the captured workspace image to the user's ChatGPT Library and makes its file ID available to the model on later turns. The local workspace image is always retained." }
  }
};
var captureFrameSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sourcePath: { type: "string", description: "Logical workspace-relative source media-file path." },
    requestedTimestampSeconds: { type: "number", minimum: 0 },
    actualTimestampSeconds: { ...nullableNumber, minimum: 0, description: "Decoded-frame timestamp reported by ffmpeg when available; null only when ffmpeg did not report it." },
    selectedVideoStreamIndex: { type: "integer", minimum: 0, description: "ffprobe streams[].index of the video stream used." },
    seekMode: { type: "string", enum: ["accurate", "fast"] },
    displayRotationApplied: { type: "boolean" },
    image: {
      type: "object",
      additionalProperties: false,
      properties: {
        format: captureFrameFormatSchema,
        mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp"] },
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
        imageSizeBytes: { type: "integer", minimum: 0 },
        delivery: captureFrameDeliveryModeSchema,
        workspacePath: { type: "string", minLength: 1, description: "Logical workspace-relative path of the captured image. capture_frame always creates this file." },
        saveToLibrary: { type: "boolean", description: "Whether the widget should upload this capture to ChatGPT Library after displaying it." }
      },
      required: ["format", "mimeType", "width", "height", "imageSizeBytes", "delivery", "workspacePath", "saveToLibrary"]
    }
  },
  required: ["sourcePath", "requestedTimestampSeconds", "actualTimestampSeconds", "selectedVideoStreamIndex", "seekMode", "displayRotationApplied", "image"]
};
var captureFrameWidgetActionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1, description: "The same logical workspace-relative captured-image path supplied to the widget." },
    action: { type: "string", enum: ["copiedPath", "copiedImage", "downloadStarted"] }
  },
  required: ["path", "action"]
};
var pureReadAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
var localAgentReadAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
var pageReadAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
var localDownloadAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
var localDownloadReadAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
var localWorkspaceWriteAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
var localWorkspaceDeleteAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
function toolDefinitions() {
  return [
    {
      name: "researchtube_agent_status",
      title: "Get ResearchTube Local Agent status",
      description: "Check the optional ResearchTube Local Agent on the configured localhost port. Returns the serving Chrome Extension implementation version and its required Extension \u2194 Agent interface version, plus the Agent implementation version, interface version, public operating-system information, workspace health, and status, version, discovery source, and diagnostic message for yt-dlp, Deno, ffmpeg, and ffprobe. Deno is an optional local JavaScript runtime passed explicitly to yt-dlp when available. Physical host paths and host identity are intentionally never exposed through MCP. A missing or mismatched Agent interfaceVersion prevents the Extension from using Agent tools, but does not affect ordinary YouTube research tools.",
      annotations: localAgentReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: agentStatusSchema
    },
    {
      name: "workspace_list",
      title: "List a ResearchTube workspace directory",
      description: "List one directory inside the Local Agent's ResearchTube workspace. path uses only logical POSIX-style workspace-relative paths; pass an empty string to list the workspace root. Results are bounded by limit and never reveal a host filesystem path. This tool cannot read outside the workspace.",
      annotations: localAgentReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", default: "", description: "Logical workspace directory path. Use an empty string only for the workspace root; otherwise use / separators and no . or .. components." }, limit: { type: "integer", minimum: 1, maximum: 500, default: 100 } }, required: [] },
      outputSchema: workspaceListSchema
    },
    {
      name: "workspace_stat",
      title: "Inspect a ResearchTube workspace file or directory",
      description: "Return bounded metadata for one existing file or directory inside the Local Agent workspace. path is a logical POSIX-style workspace-relative path, never an operating-system path. It returns type, file size when applicable, and modification time; it never reads file contents.",
      annotations: localAgentReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1, description: "Logical workspace-relative POSIX path. Do not use absolute paths, backslashes, . or .. components." } }, required: ["path"] },
      outputSchema: workspaceStatSchema
    },
    {
      name: "workspace_mkdir",
      title: "Create a ResearchTube workspace directory",
      description: "Create a directory inside the Local Agent workspace. Missing parent directories are created. path is a logical POSIX-style workspace-relative path only; the built-in workspace sandbox rejects host paths, traversal, and filesystem redirects.",
      annotations: { ...localWorkspaceWriteAnnotations, idempotentHint: true },
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1, description: "Logical workspace-relative POSIX directory path." } }, required: ["path"] },
      outputSchema: workspaceMkdirSchema
    },
    {
      name: "workspace_move",
      title: "Move or rename a ResearchTube workspace item",
      description: "Move or rename one regular file or directory entirely inside the Local Agent workspace. Both source and destination are independently validated logical POSIX-style workspace-relative paths. The destination parent must already exist and this operation never overwrites an existing item.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { source: { type: "string", minLength: 1 }, destination: { type: "string", minLength: 1 } }, required: ["source", "destination"] },
      outputSchema: workspaceMoveSchema
    },
    {
      name: "workspace_delete",
      title: "Delete a ResearchTube workspace item",
      description: "Delete one regular file or one empty directory inside the Local Agent workspace. path is a logical POSIX-style workspace-relative path. Non-empty directories are refused; this tool never performs recursive deletion or accesses outside the workspace.",
      annotations: localWorkspaceDeleteAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1 } }, required: ["path"] },
      outputSchema: workspaceDeleteSchema
    },
    {
      name: "media_probe",
      title: "Inspect a workspace media file",
      description: "Inspect one existing media file inside the ResearchTube workspace with the Local Agent's ffprobe. sections optionally selects any of format, streams, chapters, and programs; omitting it returns all sections. The probe result preserves ffprobe metadata, including tags such as author, creation time, location/GPS, language, codec, disposition, and chapters. It removes only ffprobe's physical format.filename. fileSizeBytes is the actual workspace-file size; ffprobeFileSizeBytes is the independent size returned by ffprobe.",
      annotations: localAgentReadAnnotations,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1, description: "Logical workspace-relative POSIX path of a media file." },
          sections: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: mediaProbeSectionSchema, description: "Optional ffprobe metadata sections. Omit to return format, streams, chapters, and programs." }
        },
        required: ["path"]
      },
      outputSchema: mediaProbeSchema
    },
    {
      name: "capture_frame",
      title: "Extract one frame from a workspace video",
      description: "Extract one frame from an existing workspace media file with the Local Agent's ffmpeg. timestampSeconds is required. videoStreamIndex, when supplied, is the exact streams[].index returned by media_probe; otherwise the first video stream is used. accurate seek decodes to the requested time; fast seek prioritizes speed. Cropping and resizing are optional; resizing may upscale. contain preserves proportions and pads, cover preserves proportions and crops, and stretch forces exact dimensions. Every capture is saved as a normal workspace image file and returned with its logical workspacePath. The accompanying widget retrieves that same file through the Local Agent for display and can optionally save it to ChatGPT Library. No host paths are exposed.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1, description: "Logical workspace-relative path of the source media file." },
          timestampSeconds: { type: "number", minimum: 0, description: "Required media timestamp, in seconds." },
          videoStreamIndex: { type: "integer", minimum: 0, description: "Optional ffprobe streams[].index of the video stream to capture." },
          seekMode: { type: "string", enum: ["accurate", "fast"], default: "accurate" },
          applyDisplayRotation: { type: "boolean", default: true, description: "Apply display rotation metadata before cropping and resizing." },
          crop: captureFrameCropSchema,
          resize: captureFrameResizeSchema,
          image: captureFrameImageInputSchema,
          delivery: captureFrameDeliveryInputSchema
        },
        required: ["path", "timestampSeconds"]
      },
      outputSchema: captureFrameSchema,
      _meta: {
        ui: { resourceUri: CAPTURE_FRAME_WIDGET_URI },
        "openai/outputTemplate": CAPTURE_FRAME_WIDGET_URI,
        "openai/toolInvocation/invoking": "Capturing frame\u2026",
        "openai/toolInvocation/invoked": "Frame captured."
      }
    },
    {
      name: "researchtube_get_capture_frame_image",
      title: "Load a captured workspace frame for the ResearchTube widget",
      description: "Widget-only support tool. Reads the captured image at the supplied logical workspace path so the capture-frame widget can display or refresh it. It is not available to the model and exposes no host path.",
      annotations: localAgentReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1, description: "Logical workspace-relative path returned by capture_frame.image.workspacePath." } }, required: ["path"] },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" }, mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp"] }, imageSizeBytes: { type: "integer", minimum: 0 } },
        required: ["path", "mimeType", "imageSizeBytes"]
      },
      _meta: {
        ui: { visibility: ["app"] },
        "openai/visibility": "private",
        "openai/widgetAccessible": true
      }
    },
    {
      name: "researchtube_copy_capture_frame_path",
      title: "Copy a captured-frame workspace path",
      description: "Widget-only action. Copies one logical ResearchTube workspace image path to the local system clipboard through the installed Chrome Extension. It is not available to the model.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1 } }, required: ["path"] },
      outputSchema: captureFrameWidgetActionSchema,
      _meta: { ui: { visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true }
    },
    {
      name: "researchtube_copy_capture_frame_image",
      title: "Copy a captured frame",
      description: "Widget-only action. Copies one captured workspace image to the local system clipboard through the installed Chrome Extension. It is not available to the model.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1 } }, required: ["path"] },
      outputSchema: captureFrameWidgetActionSchema,
      _meta: { ui: { visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true }
    },
    {
      name: "researchtube_download_capture_frame",
      title: "Download a captured frame",
      description: "Widget-only action. Opens Chrome's native Save dialog for one captured workspace image. The image stays local: the installed Chrome Extension reads it from the Local Agent and starts the download. It is not available to the model.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1 } }, required: ["path"] },
      outputSchema: captureFrameWidgetActionSchema,
      _meta: { ui: { visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true }
    },
    {
      name: "youtube_get_download_formats",
      title: "Get formats available for download",
      description: "Ask the Local Agent's current yt-dlp installation which exact formats it can download for one public video now. This is the authoritative format source for youtube_download: choose numeric formatId values only from this tool and call it immediately before downloading. youtube_get_video.youtubeFormats is a separate advisory snapshot from the browser's direct YouTube player response; its IDs can legitimately differ from local yt-dlp because the two clients resolve YouTube playback independently. This tool exposes no media URLs, credentials, host paths, or raw yt-dlp output.",
      annotations: localDownloadReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { videoId: { type: "string", pattern: "^[A-Za-z0-9_-]{6,}$", description: "Public YouTube video ID returned by a ResearchTube discovery or video-details tool." } }, required: ["videoId"] },
      outputSchema: youtubeDownloadFormatsResultSchema
    },
    {
      name: "youtube_download",
      title: "Download a public YouTube video",
      description: "Start an asynchronous download of one public YouTube video through the optional ResearchTube Local Agent and its locally resolved yt-dlp, Deno, and ffmpeg executables. First call youtube_get_download_formats(videoId) immediately before this tool and select exact numeric formatId values from that tool's local-yt-dlp downloadFormats response; never select a numeric ID only from youtube_get_video.youtubeFormats because that direct-YouTube snapshot is advisory and can differ. 'best' remains allowed for one requested component. selection must be either combined alone, video alone, audio alone, or video plus audio; never mix combined with video/audio. A video+audio pair is remuxed into MP4 without re-encoding and therefore requires ffmpeg. The Agent accepts no arbitrary yt-dlp selector or arguments, no credentials, and no playlist. Returns a start handle only. Poll youtube_get_download_task no faster than pollIntervalMs; phase identifies the real yt-dlp operation and progressPercent is the percent within that phase, not a fabricated whole-task percentage. If a task fails or its output is unexpected, use youtube_get_download_task_diagnostics to inspect its normalized lifecycle and cleanup record. outputDir, when supplied, must be a safe workspace-relative directory.",
      annotations: localDownloadAnnotations,
      inputSchema: {
        type: "object",
        additionalProperties: false,
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
      description: "Read the current status of an asynchronous youtube_download task. Pass taskId unchanged and poll no faster than pollIntervalMs while status is working. phase identifies the actual yt-dlp operation. progressPercent is the native 0\u2013100 percent for that phase: selected video and audio tracks each have their own percentage, merging has null, and completed has 100. lastUpdatedAt advances on progress, lifecycle changes, and liveness heartbeats. The terminal result contains only a workspace-relative filePath; its extension reflects the selected track or remuxed pair.",
      annotations: localDownloadReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { taskId: { type: "string", minLength: 1, description: "Opaque taskId returned by youtube_download." } }, required: ["taskId"] },
      outputSchema: youtubeDownloadTaskSchema
    },
    {
      name: "youtube_get_download_task_diagnostics",
      title: "Get YouTube download diagnostics",
      description: "Read normalized post-mortem lifecycle events for one youtube_download task, especially after failed, cancelled, or unexpected output states. Events identify yt-dlp start/exit, phase transitions, final-output reporting and verification, structured error code, and cleanup of task-specific workspace artifacts. It intentionally does not return raw yt-dlp stdout/stderr, signed media URLs, credentials, or host paths. Use afterEventId to fetch only newer events.",
      annotations: localDownloadReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { taskId: { type: "string", minLength: 1, description: "Opaque taskId returned by youtube_download." }, afterEventId: { type: "integer", minimum: 0, default: 0, description: "Return events with eventId greater than this value." }, limit: { type: "integer", minimum: 1, maximum: 100, default: 100, description: "Maximum diagnostic events to return." } }, required: ["taskId"] },
      outputSchema: downloadTaskDiagnosticsSchema
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
      description: "Inspect one public YouTube video by video ID. Returns research metadata including title, description, channel, duration, absolute publication date when available, normalized views, likes, and comment count plus YouTube display text, category, tags, thumbnail, all public caption tracks, and youtubeFormats: an advisory format snapshot extracted directly from this video's browser-side YouTube player response. youtubeFormats is useful for media inspection but must not be treated as a guaranteed local download list; before youtube_download, call youtube_get_download_formats for the local yt-dlp-confirmed IDs. Both lists contain no media URLs or credentials. Each caption track has a trackIndex for youtube_get_transcript. It does not return canonical video URLs, caption text, comment text, replies, account-only, private, member-only, or age-restricted content.",
      annotations: pureReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { videoId: { type: "string", minLength: 6, description: "YouTube video ID obtained from youtube_search, a channel or playlist catalogue, or a prior youtube_get_video response." } }, required: ["videoId"] },
      outputSchema: { type: "object", additionalProperties: false, properties: { videoId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, channel: commentAuthorSchema, publishedAt: nullableString, durationSeconds: { type: ["number", "null"] }, views: nullableInteger, viewsText: nullableString, likes: nullableInteger, likesText: nullableString, commentCount: nullableInteger, commentCountText: nullableString, category: nullableString, tags: { type: "array", items: { type: "string" } }, thumbnailUrl: nullableString, captions: { type: "object", additionalProperties: false, properties: { available: { type: "boolean" }, tracks: { type: "array", items: captionTrackSchema } }, required: ["available", "tracks"] }, youtubeFormats: youtubeFormatsSchema }, required: ["videoId", "title", "description", "channel", "publishedAt", "durationSeconds", "views", "viewsText", "likes", "likesText", "commentCount", "commentCountText", "category", "tags", "thumbnailUrl", "captions", "youtubeFormats"] }
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
      inputSchema: { type: "object", additionalProperties: false, properties: { videoId: { type: "string", minLength: 6, description: "YouTube video ID whose public transcript is required." }, trackIndex: { type: "integer", minimum: 0, default: 0, description: "Caption track index returned by youtube_get_video. Defaults to 0, YouTube's primary track." }, limit: { type: "integer", minimum: 1, maximum: 5e3, default: 800, description: "Maximum number of timestamped caption segments to return, in chronological order." } }, required: ["videoId"] },
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
  return { ...DEFAULTS, ...await chrome.storage.local.get({ ...DEFAULTS, lastStatus: "" }) };
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
      retryAfterSeconds: Math.ceil(remainingMs / 1e3),
      cooldownUntil: remainingMs > 0 ? new Date(Number(config.youtubeSearchCooldownUntil)).toISOString() : null
    }
  };
}
function normalizeAgentPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULTS.agentPort;
}
async function saveAgentPort(payload = {}) {
  const supplied = Number(payload.port);
  if (!Number.isInteger(supplied) || supplied < 1 || supplied > 65535) {
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
    platform: null,
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
  const availableBytes = Number.isInteger(workspace.availableBytes) && workspace.availableBytes >= 0 ? workspace.availableBytes : null;
  return { status, availableBytes };
}
function normalizeAgentPlatform(value) {
  if (!value || typeof value !== "object") return null;
  const operatingSystem = typeof value.operatingSystem === "string" && value.operatingSystem.trim() ? value.operatingSystem.trim() : null;
  const release = typeof value.release === "string" && value.release.trim() ? value.release.trim() : null;
  const version = typeof value.version === "string" && value.version.trim() ? value.version.trim() : null;
  const architecture = typeof value.architecture === "string" && value.architecture.trim() ? value.architecture.trim() : null;
  return operatingSystem && release && version && architecture ? { operatingSystem, release, version, architecture } : null;
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
      platform: normalizeAgentPlatform(health.platform),
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
      headers: { Accept: "application/json", ...body === null ? {} : { "Content-Type": "application/json" } },
      body: body === null ? void 0 : JSON.stringify(body),
      signal: controller.signal
    });
    let document = null;
    try {
      document = await response.json();
    } catch (_error) {
    }
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
  if (!value || typeof value !== "object" || typeof value.taskId !== "string" || !["working", "completed", "failed", "cancelled"].includes(status) || !["preparing", "downloadingCombined", "downloadingVideo", "downloadingAudio", "merging", "completed", "failed", "cancelled"].includes(phase) || typeof value.statusMessage !== "string" || typeof value.createdAt !== "string" || typeof value.lastUpdatedAt !== "string") {
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
    pollIntervalMs: Number.isInteger(task.pollIntervalMs) && task.pollIntervalMs > 0 ? task.pollIntervalMs : 1e3,
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
    pollIntervalMs: Number.isInteger(task.pollIntervalMs) && task.pollIntervalMs > 0 ? task.pollIntervalMs : 1e3,
    progressPercent: typeof task.progressPercent === "number" && task.progressPercent >= 0 && task.progressPercent <= 100 ? task.progressPercent : null
  };
}
function normalizeDownloadSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw localAgentError("FORMAT_SELECTION_INVALID", "selection is required.");
  }
  const allowed = /* @__PURE__ */ new Set(["combined", "video", "audio"]);
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
  if (outputDir !== void 0 && (typeof outputDir !== "string" || !outputDir.trim())) {
    throw localAgentError("OUTPUT_DIR_INVALID", "outputDir must be a non-empty workspace-relative directory string.");
  }
  return publicDownloadStartTask(normalizeAgentTask(await agentJsonRequest("/tasks/youtube-download", { method: "POST", body: { videoId, selection, ...outputDir === void 0 ? {} : { outputDir: outputDir.trim() } } })));
}
function normalizeYtDlpDownloadFormats(value) {
  if (!value || typeof value !== "object" || typeof value.available !== "boolean" || !["ytDlp", "unavailable"].includes(value.source) || !Array.isArray(value.combined) || !Array.isArray(value.video) || !Array.isArray(value.audio)) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid download-format record.");
  }
  const normalizeGroup = (group, expectedKind) => group.map((item) => {
    if (!item || typeof item !== "object" || item.kind !== expectedKind || typeof item.formatId !== "string" || !/^\d+$/.test(item.formatId)) {
      throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid download format.");
    }
    return {
      formatId: item.formatId,
      kind: item.kind,
      container: nullableAgentString(item.container),
      videoCodec: nullableAgentString(item.videoCodec),
      audioCodec: nullableAgentString(item.audioCodec),
      width: nullableAgentNumber(item.width, true),
      height: nullableAgentNumber(item.height, true),
      fps: nullableAgentNumber(item.fps),
      bitrateBps: nullableAgentNumber(item.bitrateBps, true),
      audioSampleRateHz: nullableAgentNumber(item.audioSampleRateHz, true),
      audioChannels: nullableAgentNumber(item.audioChannels, true),
      qualityLabel: nullableAgentString(item.qualityLabel),
      sizeBytes: nullableAgentNumber(item.sizeBytes, true)
    };
  });
  return {
    available: value.available,
    source: value.source,
    message: nullableAgentString(value.message),
    combined: normalizeGroup(value.combined, "combined"),
    video: normalizeGroup(value.video, "video"),
    audio: normalizeGroup(value.audio, "audio")
  };
}
async function getYouTubeDownloadFormats(videoId) {
  if (typeof videoId !== "string" || !/^[A-Za-z0-9_-]{6,}$/.test(videoId)) throw localAgentError("INVALID_VIDEO_ID", "videoId is required.");
  const result = await agentJsonRequest("/youtube/download-formats", { method: "POST", body: { videoId } });
  if (!result || typeof result !== "object" || result.videoId !== videoId) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid download-format response.");
  }
  return { videoId, downloadFormats: normalizeYtDlpDownloadFormats(result.downloadFormats) };
}
function nullableAgentString(value) {
  return typeof value === "string" ? value : null;
}
function nullableAgentNumber(value, integer = false) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && (!integer || Number.isInteger(value)) ? value : null;
}
async function getYouTubeDownloadTask(taskId) {
  if (typeof taskId !== "string" || !taskId) throw localAgentError("TASK_NOT_FOUND", "taskId is required.");
  return publicDownloadTask(normalizeAgentTask(await agentJsonRequest(`/tasks/${encodeURIComponent(taskId)}`)));
}
function normalizeDownloadTaskDiagnostics(value) {
  if (!value || typeof value !== "object" || typeof value.taskId !== "string" || !["working", "completed", "failed", "cancelled"].includes(value.status) || !["preparing", "downloadingCombined", "downloadingVideo", "downloadingAudio", "merging", "completed", "failed", "cancelled"].includes(value.phase) || !Array.isArray(value.events) || !value.process || typeof value.process !== "object") {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid download diagnostics record.");
  }
  const event = (item) => {
    if (!item || typeof item !== "object" || !Number.isInteger(item.eventId) || item.eventId < 1 || typeof item.at !== "string" || typeof item.kind !== "string") {
      throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid diagnostic event.");
    }
    return {
      eventId: item.eventId,
      at: item.at,
      kind: item.kind,
      phase: ["preparing", "downloadingCombined", "downloadingVideo", "downloadingAudio", "merging", "completed", "failed", "cancelled"].includes(item.phase) ? item.phase : "failed",
      message: nullableAgentString(item.message),
      process: item.process === "ytDlp" ? "ytDlp" : null,
      exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
      errorCode: nullableAgentString(item.errorCode),
      workspacePath: nullableAgentString(item.workspacePath),
      removedWorkspacePaths: Array.isArray(item.removedWorkspacePaths) ? item.removedWorkspacePaths.filter((path) => typeof path === "string") : []
    };
  };
  const finalOutput = ["notReported", "reportedButMissing", "verified"].includes(value.process.finalOutput) ? value.process.finalOutput : "notReported";
  return {
    taskId: value.taskId,
    status: value.status,
    phase: value.phase,
    error: value.error && typeof value.error === "object" ? { code: typeof value.error.code === "string" ? value.error.code : "DOWNLOAD_FAILED", message: typeof value.error.message === "string" ? value.error.message : "The download task failed.", detail: typeof value.error.detail === "string" ? value.error.detail : null } : null,
    process: { ytDlpExitCode: Number.isInteger(value.process.ytDlpExitCode) ? value.process.ytDlpExitCode : null, finalOutput, cleanupRemovedCount: Number.isInteger(value.process.cleanupRemovedCount) && value.process.cleanupRemovedCount >= 0 ? value.process.cleanupRemovedCount : 0 },
    events: value.events.map(event),
    returned: Number.isInteger(value.returned) && value.returned >= 0 ? value.returned : value.events.length,
    nextEventId: Number.isInteger(value.nextEventId) && value.nextEventId >= 0 ? value.nextEventId : 0
  };
}
async function getYouTubeDownloadTaskDiagnostics(taskId, args = {}) {
  if (typeof taskId !== "string" || !taskId) throw localAgentError("TASK_NOT_FOUND", "taskId is required.");
  const afterEventId = args.afterEventId === void 0 ? 0 : args.afterEventId;
  const limit = args.limit === void 0 ? 100 : args.limit;
  if (!Number.isInteger(afterEventId) || afterEventId < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw localAgentError("INVALID_ARGUMENT", "afterEventId and limit are invalid.");
  }
  return normalizeDownloadTaskDiagnostics(await agentJsonRequest(`/tasks/${encodeURIComponent(taskId)}/diagnostics`, { method: "POST", body: { afterEventId, limit } }));
}
async function cancelYouTubeDownloadTask(taskId) {
  if (typeof taskId !== "string" || !taskId) throw localAgentError("TASK_NOT_FOUND", "taskId is required.");
  await agentJsonRequest(`/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", body: {} });
  return { taskId, accepted: true, message: "Cancellation request accepted. Poll youtube_get_download_task for the terminal status." };
}
function normalizeWorkspacePath(value, fieldName, { allowRoot = false } = {}) {
  if (allowRoot && value === "") return "";
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 1024 || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw localAgentError("WORKSPACE_PATH_INVALID", `${fieldName} must be a safe workspace-relative POSIX path.`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw localAgentError("WORKSPACE_PATH_INVALID", `${fieldName} contains an invalid workspace path component.`);
  }
  return value;
}
function normalizeWorkspaceType(value, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid workspace item.");
  }
  return value;
}
function normalizeWorkspaceEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.name !== "string" || !value.name || value.name.includes("/") || value.name.includes("\\")) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid workspace directory entry.");
  }
  return {
    name: value.name,
    path: normalizeWorkspacePath(value.path, "entry.path"),
    type: normalizeWorkspaceType(value.type, ["file", "directory", "other"]),
    size: nullableAgentNumber(value.size, true)
  };
}
function normalizeWorkspaceStat(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.modifiedAt !== "string") {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid workspace metadata.");
  }
  return {
    path: normalizeWorkspacePath(value.path, "path"),
    type: normalizeWorkspaceType(value.type, ["file", "directory"]),
    size: nullableAgentNumber(value.size, true),
    modifiedAt: value.modifiedAt
  };
}
async function workspaceList(path = "", limit = 100) {
  const normalizedPath = normalizeWorkspacePath(path, "path", { allowRoot: true });
  const document = await agentJsonRequest("/workspace/list", { method: "POST", body: { path: normalizedPath, limit } });
  if (!document || typeof document !== "object" || !Array.isArray(document.entries) || document.entries.length > 500 || !Number.isInteger(document.returned) || !Number.isInteger(document.limit)) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid workspace listing.");
  }
  const entries = document.entries.map(normalizeWorkspaceEntry);
  if (document.returned !== entries.length || document.limit !== limit) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid workspace listing.");
  }
  return { path: normalizeWorkspacePath(document.path, "path", { allowRoot: true }), entries, returned: entries.length, limit };
}
async function workspaceStat(path) {
  const document = await agentJsonRequest("/workspace/stat", { method: "POST", body: { path: normalizeWorkspacePath(path, "path") } });
  return normalizeWorkspaceStat(document);
}
async function workspaceMkdir(path) {
  const document = await agentJsonRequest("/workspace/mkdir", { method: "POST", body: { path: normalizeWorkspacePath(path, "path") } });
  if (!document || typeof document !== "object" || document.type !== "directory" || typeof document.created !== "boolean") {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid mkdir result.");
  }
  return { path: normalizeWorkspacePath(document.path, "path"), type: "directory", created: document.created };
}
async function workspaceMove(source, destination) {
  const input = { source: normalizeWorkspacePath(source, "source"), destination: normalizeWorkspacePath(destination, "destination") };
  const document = await agentJsonRequest("/workspace/move", { method: "POST", body: input });
  if (!document || typeof document !== "object" || document.source !== input.source || document.destination !== input.destination) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid move result.");
  }
  return { source: input.source, destination: input.destination, type: normalizeWorkspaceType(document.type, ["file", "directory"]) };
}
async function workspaceDelete(path) {
  const logicalPath = normalizeWorkspacePath(path, "path");
  const document = await agentJsonRequest("/workspace/delete", { method: "POST", body: { path: logicalPath } });
  if (!document || typeof document !== "object" || document.path !== logicalPath || document.deleted !== true) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid delete result.");
  }
  return { path: logicalPath, type: normalizeWorkspaceType(document.type, ["file", "directory"]), deleted: true };
}
var mediaProbeSectionNames = /* @__PURE__ */ new Set(["format", "streams", "chapters", "programs"]);
function normalizeMediaProbeSections(value) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value) || value.length < 1 || value.length > mediaProbeSectionNames.size || new Set(value).size !== value.length || value.some((section) => typeof section !== "string" || !mediaProbeSectionNames.has(section))) {
    throw localAgentError("MEDIA_PROBE_SECTIONS_INVALID", "sections must be a non-empty array of unique supported ffprobe metadata sections.");
  }
  return value;
}
function normalizeMediaProbeDocument(value, sections) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid ffprobe metadata.");
  }
  const permitted = new Set(sections);
  const probe = {};
  for (const [key, sectionValue] of Object.entries(value)) {
    const section = key === "format" ? "format" : key;
    if (!permitted.has(section) || !mediaProbeSectionNames.has(section)) {
      throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an unexpected ffprobe metadata section.");
    }
    const isListSection = section === "streams" || section === "chapters" || section === "programs";
    if (section === "format" && (!sectionValue || typeof sectionValue !== "object" || Array.isArray(sectionValue)) || isListSection && (!Array.isArray(sectionValue) || sectionValue.some((item) => !item || typeof item !== "object" || Array.isArray(item)))) {
      throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid ffprobe metadata.");
    }
    if (section === "format" && (Object.hasOwn(sectionValue, "filename") || Object.hasOwn(sectionValue, "size"))) {
      throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned a physical filename or unnormalised ffprobe size.");
    }
    probe[key] = sectionValue;
  }
  return probe;
}
async function mediaProbe(path, sections) {
  const logicalPath = normalizeWorkspacePath(path, "path");
  const normalizedSections = normalizeMediaProbeSections(sections);
  const document = await agentJsonRequest("/media/probe", { method: "POST", body: { path: logicalPath, ...normalizedSections === void 0 ? {} : { sections: normalizedSections } }, timeoutMs: AGENT_TASK_TIMEOUT_MS });
  if (!document || typeof document !== "object" || document.path !== logicalPath || !Number.isInteger(document.fileSizeBytes) || document.fileSizeBytes < 0 || !Array.isArray(document.sections) || document.sections.length < 1) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid media metadata.");
  }
  const returnedSections = normalizeMediaProbeSections(document.sections);
  if (normalizedSections !== void 0 && (returnedSections.length !== normalizedSections.length || returnedSections.some((section, index) => section !== normalizedSections[index]))) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned unexpected ffprobe metadata sections.");
  }
  return {
    path: logicalPath,
    fileSizeBytes: document.fileSizeBytes,
    ffprobeFileSizeBytes: nullableAgentNumber(document.ffprobeFileSizeBytes, true),
    sections: returnedSections,
    probe: normalizeMediaProbeDocument(document.probe, returnedSections)
  };
}
function captureFrameFiniteNumber(value, field, { minimum = null, maximum = null } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || minimum !== null && value < minimum || maximum !== null && value > maximum) {
    throw localAgentError("CAPTURE_FRAME_INVALID", `${field} must be a finite number${minimum === 0 ? " greater than or equal to zero" : ""}.`);
  }
  return value;
}
function captureFrameInteger(value, field, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) throw localAgentError("CAPTURE_FRAME_INVALID", `${field} must be an integer ${minimum === 0 ? "greater than or equal to zero" : "greater than zero"}.`);
  return value;
}
function captureFrameObject(value, field, allowed) {
  if (value === void 0) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw localAgentError("CAPTURE_FRAME_INVALID", `${field} contains an unsupported field.`);
  }
  return value;
}
function normalizeCaptureFrameInput(argumentsValue = {}) {
  const args = captureFrameObject(argumentsValue, "capture_frame", /* @__PURE__ */ new Set(["path", "timestampSeconds", "videoStreamIndex", "seekMode", "applyDisplayRotation", "crop", "resize", "image", "delivery"]));
  const path = normalizeWorkspacePath(args.path, "path");
  const timestampSeconds = captureFrameFiniteNumber(args.timestampSeconds, "timestampSeconds", { minimum: 0 });
  const videoStreamIndex = args.videoStreamIndex === void 0 ? void 0 : captureFrameInteger(args.videoStreamIndex, "videoStreamIndex");
  const seekMode = args.seekMode === void 0 ? "accurate" : args.seekMode;
  if (seekMode !== "accurate" && seekMode !== "fast") throw localAgentError("CAPTURE_FRAME_INVALID", "seekMode must be accurate or fast.");
  const applyDisplayRotation = args.applyDisplayRotation === void 0 ? true : args.applyDisplayRotation;
  if (typeof applyDisplayRotation !== "boolean") throw localAgentError("CAPTURE_FRAME_INVALID", "applyDisplayRotation must be a boolean.");
  let crop;
  if (args.crop !== void 0) {
    const value = captureFrameObject(args.crop, "crop", /* @__PURE__ */ new Set(["x", "y", "width", "height"]));
    if (!["x", "y", "width", "height"].every((key) => Object.hasOwn(value, key))) throw localAgentError("CAPTURE_FRAME_INVALID", "crop requires x, y, width, and height.");
    crop = { x: captureFrameInteger(value.x, "crop.x"), y: captureFrameInteger(value.y, "crop.y"), width: captureFrameInteger(value.width, "crop.width", 1), height: captureFrameInteger(value.height, "crop.height", 1) };
  }
  let resize;
  if (args.resize !== void 0) {
    const value = captureFrameObject(args.resize, "resize", /* @__PURE__ */ new Set(["width", "height", "mode", "anchor", "padColor"]));
    if (value.width === void 0 && value.height === void 0) throw localAgentError("CAPTURE_FRAME_INVALID", "resize requires width, height, or both.");
    const mode = value.mode === void 0 ? "contain" : value.mode;
    if (!(/* @__PURE__ */ new Set(["contain", "cover", "stretch"])).has(mode)) throw localAgentError("CAPTURE_FRAME_INVALID", "resize.mode must be contain, cover, or stretch.");
    const anchorValue = captureFrameObject(value.anchor, "resize.anchor", /* @__PURE__ */ new Set(["x", "y"]));
    if (Object.keys(anchorValue).length && (!Object.hasOwn(anchorValue, "x") || !Object.hasOwn(anchorValue, "y"))) throw localAgentError("CAPTURE_FRAME_INVALID", "resize.anchor requires x and y.");
    const padColor = value.padColor === void 0 ? "#000000" : value.padColor;
    if (typeof padColor !== "string" || !/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(padColor)) throw localAgentError("CAPTURE_FRAME_INVALID", "resize.padColor must be #RRGGBB or #RRGGBBAA.");
    resize = {
      ...value.width === void 0 ? {} : { width: captureFrameInteger(value.width, "resize.width", 1) },
      ...value.height === void 0 ? {} : { height: captureFrameInteger(value.height, "resize.height", 1) },
      mode,
      anchor: { x: anchorValue.x === void 0 ? 0.5 : captureFrameFiniteNumber(anchorValue.x, "resize.anchor.x", { minimum: 0, maximum: 1 }), y: anchorValue.y === void 0 ? 0.5 : captureFrameFiniteNumber(anchorValue.y, "resize.anchor.y", { minimum: 0, maximum: 1 }) },
      padColor
    };
  }
  const imageValue = captureFrameObject(args.image, "image", /* @__PURE__ */ new Set(["format", "quality", "compressionLevel"]));
  const imageFormat = imageValue.format === void 0 ? "png" : imageValue.format;
  if (!(/* @__PURE__ */ new Set(["png", "jpeg", "webp"])).has(imageFormat)) throw localAgentError("CAPTURE_FRAME_INVALID", "image.format must be png, jpeg, or webp.");
  const quality = imageValue.quality === void 0 ? void 0 : captureFrameInteger(imageValue.quality, "image.quality", 1);
  if (quality !== void 0 && quality > 100) throw localAgentError("CAPTURE_FRAME_INVALID", "image.quality must be from 1 to 100.");
  const compressionLevel = imageValue.compressionLevel === void 0 ? void 0 : captureFrameInteger(imageValue.compressionLevel, "image.compressionLevel");
  if (compressionLevel !== void 0 && compressionLevel > 9) throw localAgentError("CAPTURE_FRAME_INVALID", "image.compressionLevel must be from 0 to 9.");
  if (imageFormat === "png" && quality !== void 0) throw localAgentError("CAPTURE_FRAME_INVALID", "image.quality is available only for jpeg and webp output.");
  if (imageFormat !== "png" && compressionLevel !== void 0) throw localAgentError("CAPTURE_FRAME_INVALID", "image.compressionLevel is available only for png output.");
  const deliveryValue = captureFrameObject(args.delivery, "delivery", /* @__PURE__ */ new Set(["workspacePath", "saveToLibrary"]));
  const workspacePath = deliveryValue.workspacePath === void 0 ? void 0 : normalizeWorkspacePath(deliveryValue.workspacePath, "delivery.workspacePath");
  const saveToLibrary = deliveryValue.saveToLibrary === void 0 ? false : deliveryValue.saveToLibrary;
  if (typeof saveToLibrary !== "boolean") throw localAgentError("CAPTURE_FRAME_INVALID", "delivery.saveToLibrary must be a boolean.");
  return {
    path,
    timestampSeconds,
    ...videoStreamIndex === void 0 ? {} : { videoStreamIndex },
    seekMode,
    applyDisplayRotation,
    ...crop === void 0 ? {} : { crop },
    ...resize === void 0 ? {} : { resize },
    image: { format: imageFormat, ...quality === void 0 ? {} : { quality }, ...compressionLevel === void 0 ? {} : { compressionLevel } },
    delivery: { ...workspacePath === void 0 ? {} : { workspacePath }, saveToLibrary }
  };
}
function normalizeCaptureFrameResult(document, input) {
  if (!document || typeof document !== "object" || Array.isArray(document) || document.sourcePath !== input.path || document.seekMode !== input.seekMode || document.displayRotationApplied !== true && document.displayRotationApplied !== false) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid captured-frame result.");
  }
  const requestedTimestampSeconds = captureFrameFiniteNumber(document.requestedTimestampSeconds, "requestedTimestampSeconds", { minimum: 0 });
  if (requestedTimestampSeconds !== input.timestampSeconds) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an unexpected captured-frame timestamp.");
  const actualTimestampSeconds = document.actualTimestampSeconds === null ? null : captureFrameFiniteNumber(document.actualTimestampSeconds, "actualTimestampSeconds", { minimum: 0 });
  const selectedVideoStreamIndex = captureFrameInteger(document.selectedVideoStreamIndex, "selectedVideoStreamIndex");
  const image = document.image;
  if (!image || typeof image !== "object" || Array.isArray(image) || !(/* @__PURE__ */ new Set(["png", "jpeg", "webp"])).has(image.format) || !(/* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp"])).has(image.mimeType) || image.delivery !== "workspace" || !Number.isInteger(image.width) || image.width < 1 || !Number.isInteger(image.height) || image.height < 1 || !Number.isInteger(image.imageSizeBytes) || image.imageSizeBytes < 0) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid captured-image metadata.");
  }
  const expectedMimeType = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[image.format];
  if (image.mimeType !== expectedMimeType) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an inconsistent captured-image MIME type.");
  if (typeof image.workspacePath !== "string" || Object.hasOwn(document, "inlineImageBase64") || typeof image.saveToLibrary !== "boolean") {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid workspace image result.");
  }
  if (image.saveToLibrary !== input.delivery.saveToLibrary) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an unexpected library-save instruction.");
  }
  return {
    metadata: {
      sourcePath: input.path,
      requestedTimestampSeconds,
      actualTimestampSeconds,
      selectedVideoStreamIndex,
      seekMode: input.seekMode,
      displayRotationApplied: document.displayRotationApplied,
      image: {
        format: image.format,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        imageSizeBytes: image.imageSizeBytes,
        delivery: image.delivery,
        workspacePath: normalizeWorkspacePath(image.workspacePath, "image.workspacePath"),
        saveToLibrary: image.saveToLibrary
      }
    }
  };
}
async function captureFrame(argumentsValue) {
  const input = normalizeCaptureFrameInput(argumentsValue);
  const document = await agentJsonRequest("/media/capture-frame", { method: "POST", body: input, timeoutMs: AGENT_CAPTURE_FRAME_TIMEOUT_MS });
  return normalizeCaptureFrameResult(document, input);
}
async function getCaptureFrameImage(path) {
  const logicalPath = normalizeWorkspacePath(path, "path");
  const document = await agentJsonRequest("/media/workspace-image", { method: "POST", body: { path: logicalPath }, timeoutMs: AGENT_CAPTURE_FRAME_TIMEOUT_MS });
  if (!document || typeof document !== "object" || document.path !== logicalPath || !(/* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp"])).has(document.mimeType) || !Number.isInteger(document.imageSizeBytes) || document.imageSizeBytes < 0 || typeof document.inlineImageBase64 !== "string" || !document.inlineImageBase64) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid workspace image.");
  }
  return { metadata: { path: logicalPath, mimeType: document.mimeType, imageSizeBytes: document.imageSizeBytes }, inlineImageBase64: document.inlineImageBase64 };
}
function captureFrameDownloadName(path) {
  const fileName = String(path).split("/").pop() || "ResearchTube frame.png";
  return fileName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim() || "ResearchTube frame.png";
}
async function ensureCaptureFrameOffscreenDocument() {
  if (captureFrameOffscreenPromise) return captureFrameOffscreenPromise;
  captureFrameOffscreenPromise = (async () => {
    if (!chrome.offscreen?.createDocument || !chrome.runtime?.getContexts) {
      throw localAgentError("EXTENSION_CAPABILITY_UNAVAILABLE", "This Chrome version cannot access the local clipboard for captured frames.");
    }
    const documentUrl = chrome.runtime.getURL(CAPTURE_FRAME_OFFSCREEN_DOCUMENT);
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [documentUrl] });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: CAPTURE_FRAME_OFFSCREEN_DOCUMENT,
        reasons: ["CLIPBOARD"],
        justification: "Copy a user-requested ResearchTube workspace path or captured image to the local clipboard."
      });
    }
  })();
  try {
    await captureFrameOffscreenPromise;
  } catch (error) {
    captureFrameOffscreenPromise = null;
    if (error?.code) throw error;
    const detail = String(error?.message || error || "Unknown offscreen-document error.");
    console.error("[ResearchTube] Chrome could not open the offscreen clipboard document.", error);
    throw localAgentError("CLIPBOARD_UNAVAILABLE", "Chrome could not open its local clipboard helper.", detail);
  }
}
async function copyCaptureFrameToClipboard(message) {
  await ensureCaptureFrameOffscreenDocument();
  try {
    const result = await chrome.runtime.sendMessage({ type: "researchtube_copy_capture_frame", ...message });
    if (!result?.ok) {
      const detail = String(result?.message || "The offscreen clipboard document returned no success response.");
      console.error("[ResearchTube] The offscreen clipboard document rejected the request.", { kind: message.kind, detail });
      throw localAgentError("CLIPBOARD_UNAVAILABLE", "Chrome could not update the local clipboard.", detail);
    }
  } catch (error) {
    if (error?.code) throw error;
    const detail = String(error?.message || error || "Unknown clipboard messaging error.");
    console.error("[ResearchTube] Chrome clipboard messaging failed.", error);
    throw localAgentError("CLIPBOARD_UNAVAILABLE", "Chrome could not update the local clipboard.", detail);
  }
}
async function copyCaptureFramePath(path) {
  const logicalPath = normalizeWorkspacePath(path, "path");
  console.info("[ResearchTube] Copying captured-frame workspace path through the Chrome clipboard helper.");
  await copyCaptureFrameToClipboard({ kind: "path", text: logicalPath });
  return { path: logicalPath, action: "copiedPath" };
}
async function copyCaptureFrameImage(path) {
  const image = await getCaptureFrameImage(path);
  console.info("[ResearchTube] Copying captured-frame image as PNG through the Chrome clipboard helper.");
  await copyCaptureFrameToClipboard({ kind: "image", base64: image.inlineImageBase64, mimeType: image.metadata.mimeType });
  return { path: image.metadata.path, action: "copiedImage" };
}
async function downloadCaptureFrame(path) {
  const image = await getCaptureFrameImage(path);
  if (!chrome.downloads?.download) {
    throw localAgentError("DOWNLOAD_UNAVAILABLE", "Chrome Downloads is unavailable in this Extension.");
  }
  try {
    console.info("[ResearchTube] Starting a local Chrome download for a captured frame.");
    await chrome.downloads.download({
      url: `data:${image.metadata.mimeType};base64,${image.inlineImageBase64}`,
      filename: captureFrameDownloadName(image.metadata.path),
      saveAs: true,
      conflictAction: "uniquify"
    });
  } catch (error) {
    console.error("[ResearchTube] Chrome could not start the captured-frame download.", error);
    throw localAgentError("DOWNLOAD_UNAVAILABLE", "Chrome could not start the image download.");
  }
  return { path: image.metadata.path, action: "downloadStarted" };
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
    working: { text: "\u2026", color: "#0969da", title: "ResearchTube: working" },
    "youtube-rate-limited": { text: "!", color: "#b7791f", title: "ResearchTube: YouTube search is temporarily limited" },
    "connection-error": { text: "\xD7", color: "#cf222e", title: "ResearchTube: connection needs attention" }
  }[state] ?? { text: "", color: "#6e7781", title: "ResearchTube" };
  try {
    await chrome.action.setBadgeBackgroundColor({ color: appearance.color });
    await chrome.action.setBadgeText({ text: appearance.text });
    await chrome.action.setTitle({ title: appearance.title });
  } catch (error) {
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
    result = pollResult.ok ? { ok: true, stages: { apiKey: true, tunnel: true }, message: "Connection successful." } : connectionFailureFromPoll(pollResult);
  }
  await chrome.storage.local.set({
    lastConnectionTest: {
      success: result.ok,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
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
async function readCaptureFrameWidgetHtml() {
  const response = await fetch(chrome.runtime.getURL("ui/capture-frame-widget-v12.html"));
  if (!response.ok) throw new Error("The bundled capture-frame widget could not be read.");
  return response.text();
}
function captureFrameWidgetResource() {
  return {
    uri: CAPTURE_FRAME_WIDGET_URI,
    name: "ResearchTube captured-frame viewer",
    description: "Displays an image already saved in the local ResearchTube workspace.",
    mimeType: "text/html;profile=mcp-app"
  };
}
async function readMcpResource(id, uri) {
  if (uri !== CAPTURE_FRAME_WIDGET_URI) {
    return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown MCP resource URI" } };
  }
  try {
    const text = await readCaptureFrameWidgetHtml();
    return {
      jsonrpc: "2.0",
      id,
      result: {
        contents: [{
          ...captureFrameWidgetResource(),
          text,
          _meta: {
            ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
            "openai/widgetDescription": "Displays a captured workspace video frame."
          }
        }]
      }
    };
  } catch (error) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: safeErrorMessage(error) } };
  }
}
async function handleMcpRequest(request) {
  if (request?.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: "researchtube", version: EXTENSION_VERSION }
      }
    };
  }
  if (request?.method === "notifications/initialized") return null;
  if (request?.method === "tools/list") {
    return { jsonrpc: "2.0", id: request.id, result: { tools: toolDefinitions() } };
  }
  if (request?.method === "resources/list") {
    return { jsonrpc: "2.0", id: request.id, result: { resources: [captureFrameWidgetResource()] } };
  }
  if (request?.method === "resources/read") {
    return readMcpResource(request.id, request.params?.uri);
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_download") {
    const input = request.params.arguments ?? {};
    return executeToolCall(request.id, "youtube_download", input, () => startYouTubeDownload(input));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_get_download_formats") {
    const videoId = String(request.params.arguments?.videoId ?? "").trim();
    if (!videoId) return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "videoId is required" } };
    return executeToolCall(request.id, "youtube_get_download_formats", { videoId }, () => getYouTubeDownloadFormats(videoId));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_get_download_task") {
    const taskId = String(request.params.arguments?.taskId ?? "").trim();
    if (!taskId) return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "taskId is required" } };
    return executeToolCall(request.id, "youtube_get_download_task", { taskId }, () => getYouTubeDownloadTask(taskId));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_get_download_task_diagnostics") {
    const args = request.params.arguments ?? {};
    const taskId = String(args.taskId ?? "").trim();
    if (!taskId) return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "taskId is required" } };
    return executeToolCall(request.id, "youtube_get_download_task_diagnostics", { taskId, afterEventId: args.afterEventId ?? 0, limit: args.limit ?? 100 }, () => getYouTubeDownloadTaskDiagnostics(taskId, args));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_cancel_download_task") {
    const taskId = String(request.params.arguments?.taskId ?? "").trim();
    if (!taskId) return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "taskId is required" } };
    return executeToolCall(request.id, "youtube_cancel_download_task", { taskId }, () => cancelYouTubeDownloadTask(taskId));
  }
  if (request?.method === "tools/call" && request.params?.name === "researchtube_agent_status") {
    return executeToolCall(request.id, "researchtube_agent_status", {}, () => getAgentStatus());
  }
  if (request?.method === "tools/call" && request.params?.name === "workspace_list") {
    const args = request.params.arguments ?? {};
    const path = args.path === void 0 ? "" : args.path;
    const limit = args.limit === void 0 ? 100 : args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "limit must be an integer from 1 to 500" } };
    }
    return executeToolCall(request.id, "workspace_list", { path, limit }, () => workspaceList(path, limit));
  }
  if (request?.method === "tools/call" && request.params?.name === "workspace_stat") {
    const path = request.params.arguments?.path;
    return executeToolCall(request.id, "workspace_stat", { path }, () => workspaceStat(path));
  }
  if (request?.method === "tools/call" && request.params?.name === "workspace_mkdir") {
    const path = request.params.arguments?.path;
    return executeToolCall(request.id, "workspace_mkdir", { path }, () => workspaceMkdir(path));
  }
  if (request?.method === "tools/call" && request.params?.name === "workspace_move") {
    const args = request.params.arguments ?? {};
    return executeToolCall(request.id, "workspace_move", { source: args.source, destination: args.destination }, () => workspaceMove(args.source, args.destination));
  }
  if (request?.method === "tools/call" && request.params?.name === "workspace_delete") {
    const path = request.params.arguments?.path;
    return executeToolCall(request.id, "workspace_delete", { path }, () => workspaceDelete(path));
  }
  if (request?.method === "tools/call" && request.params?.name === "media_probe") {
    const path = request.params.arguments?.path;
    const sections = request.params.arguments?.sections;
    return executeToolCall(request.id, "media_probe", { path, sections }, () => mediaProbe(path, sections));
  }
  if (request?.method === "tools/call" && request.params?.name === "capture_frame") {
    const args = request.params.arguments ?? {};
    return executeCaptureFrameToolCall(request.id, args);
  }
  if (request?.method === "tools/call" && request.params?.name === "researchtube_get_capture_frame_image") {
    const path = request.params.arguments?.path;
    return executeCaptureFrameImageToolCall(request.id, path);
  }
  if (request?.method === "tools/call" && request.params?.name === "researchtube_copy_capture_frame_path") {
    return executeCaptureFrameWidgetActionToolCall(request.id, "researchtube_copy_capture_frame_path", request.params.arguments?.path, copyCaptureFramePath);
  }
  if (request?.method === "tools/call" && request.params?.name === "researchtube_copy_capture_frame_image") {
    return executeCaptureFrameWidgetActionToolCall(request.id, "researchtube_copy_capture_frame_image", request.params.arguments?.path, copyCaptureFrameImage);
  }
  if (request?.method === "tools/call" && request.params?.name === "researchtube_download_capture_frame") {
    return executeCaptureFrameWidgetActionToolCall(request.id, "researchtube_download_capture_frame", request.params.arguments?.path, downloadCaptureFrame);
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
    const limit = boundedInt(args.limit, 800, 1, 5e3);
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
async function executeCaptureFrameToolCall(id, argumentsValue) {
  const startedAt = Date.now();
  let input = null;
  try {
    input = normalizeCaptureFrameInput(argumentsValue);
    void recordCommandDiagnostic("started", { tool: "capture_frame", input: summarizeCommandInput("capture_frame", input) });
    await setActionBadge("working");
    const result = await captureFrame(input);
    await refreshActionBadge();
    void recordCommandDiagnostic("succeeded", { tool: "capture_frame", elapsed_ms: Date.now() - startedAt, output: summarizeCommandOutput(result.metadata) });
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result.metadata) }], structuredContent: result.metadata, isError: false } };
  } catch (error) {
    await refreshActionBadge();
    void recordCommandDiagnostic("failed", {
      tool: "capture_frame",
      elapsed_ms: Date.now() - startedAt,
      error_code: error?.code || null,
      error: searchDiagnosticMessage(error)
    });
    return toolError(id, error);
  }
}
async function executeCaptureFrameImageToolCall(id, path) {
  const startedAt = Date.now();
  try {
    const result = await getCaptureFrameImage(path);
    const mcpResult = {
      content: [{ type: "text", text: JSON.stringify(result.metadata) }],
      structuredContent: result.metadata,
      // The base64 image is intentionally widget-only. It never appears in
      // model-visible structured content or in the service-worker console.
      _meta: { researchtube: { captureFrameImageBase64: result.inlineImageBase64 } },
      isError: false
    };
    void recordCommandDiagnostic("succeeded", { tool: "researchtube_get_capture_frame_image", elapsed_ms: Date.now() - startedAt, output: { path: result.metadata.path, imageSizeBytes: result.metadata.imageSizeBytes } });
    return { jsonrpc: "2.0", id, result: mcpResult };
  } catch (error) {
    void recordCommandDiagnostic("failed", { tool: "researchtube_get_capture_frame_image", elapsed_ms: Date.now() - startedAt, error_code: error?.code || null, error: searchDiagnosticMessage(error) });
    return toolError(id, error);
  }
}
async function executeCaptureFrameWidgetActionToolCall(id, tool, path, action) {
  const startedAt = Date.now();
  try {
    const result = await action(path);
    void recordCommandDiagnostic("succeeded", { tool, elapsed_ms: Date.now() - startedAt, output: result });
    return jsonToolResult(id, result);
  } catch (error) {
    console.error(`[ResearchTube] ${tool} failed.`, error);
    void recordCommandDiagnostic("failed", { tool, elapsed_ms: Date.now() - startedAt, error_code: error?.code || null, error: searchDiagnosticMessage(error) });
    if (typeof error?.detail === "string" && error.detail) {
      const detailedError = localAgentError(error.code || "TOOL_ERROR", `${String(error.message)} Detail: ${error.detail}`, error.detail);
      return toolError(id, detailedError);
    }
    return toolError(id, error);
  }
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
    const contextualError = operation && !error?.code ? new Error(`${operation}: ${String(error?.message || error)}`, { cause: error }) : error;
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
  if (tool === "capture_frame") return { path: typeof input.path === "string" ? input.path : null, timestampSeconds: input.timestampSeconds ?? null, videoStreamIndex: input.videoStreamIndex ?? null, seekMode: input.seekMode ?? null, delivery: input.delivery?.mode ?? null };
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
  for (const key of ["videoId", "query", "returned", "requested", "hasMore", "totalReplies", "continuation", "sourcePath", "requestedTimestampSeconds", "selectedVideoStreamIndex"]) {
    if (Object.hasOwn(value, key)) summary[key] = value[key];
  }
  return summary;
}
function toolError(id, error) {
  const code = error?.code;
  const message = String(error?.message ?? error);
  const text = typeof code === "string" ? `[${code}] ${message}` : message;
  const structuredError = { error: { code: typeof code === "string" ? code : "TOOL_ERROR", message, ...typeof error?.detail === "string" ? { detail: error.detail } : {} } };
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
var YouTubeSearchRateLimitError = class extends Error {
  constructor(retryAfterSeconds) {
    super(`YouTube search is temporarily limited. Retry after ${retryAfterSeconds} seconds; do not retry sooner.`);
    this.name = "YouTubeSearchRateLimitError";
    this.code = "YOUTUBE_SEARCH_RATE_LIMITED";
    this.retryAfterSeconds = retryAfterSeconds;
  }
};
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function searchDiagnosticQuery(query) {
  return String(query ?? "").replace(/\s+/g, " ").trim().slice(0, SEARCH_DIAGNOSTIC_MAX_QUERY_LENGTH);
}
function recordCommandDiagnostic(event, fields = {}) {
  const entry = { event, timestamp: (/* @__PURE__ */ new Date()).toISOString(), ...fields };
  commandDiagnosticWrite = commandDiagnosticWrite.catch(() => void 0).then(async () => {
    const { commandDiagnostics = [] } = await chrome.storage.local.get({ commandDiagnostics: [] });
    const next = Array.isArray(commandDiagnostics) ? [...commandDiagnostics, entry] : [entry];
    if (next.length > COMMAND_DIAGNOSTIC_MAX_ENTRIES) next.splice(0, next.length - COMMAND_DIAGNOSTIC_MAX_ENTRIES);
    await chrome.storage.local.set({ commandDiagnostics: next });
  });
  return commandDiagnosticWrite;
}
function searchDiagnosticMessage(value) {
  return String(value?.message ?? value ?? "Unknown error").replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").replace(/https?:\/\/[^\s]+/g, "[url]").replace(/\s+/g, " ").slice(0, 280);
}
function recordSearchDiagnostic(event, fields = {}) {
  const entry = { timestamp: (/* @__PURE__ */ new Date()).toISOString(), event, ...fields };
  searchDiagnosticWrite = searchDiagnosticWrite.catch(() => void 0).then(async () => {
    const { searchDiagnostics = [] } = await chrome.storage.local.get({ searchDiagnostics: [] });
    const entries = Array.isArray(searchDiagnostics) ? searchDiagnostics : [];
    entries.push(entry);
    await chrome.storage.local.set({ searchDiagnostics: entries.slice(-SEARCH_DIAGNOSTIC_MAX_ENTRIES) });
  }).catch((error) => console.debug("ResearchTube search diagnostics write failed:", error));
  return searchDiagnosticWrite;
}
async function getDiagnosticsExport() {
  await Promise.all([searchDiagnosticWrite, commandDiagnosticWrite]);
  const { searchDiagnostics = [], commandDiagnostics = [] } = await chrome.storage.local.get({ searchDiagnostics: [], commandDiagnostics: [] });
  const searchEntries = Array.isArray(searchDiagnostics) ? searchDiagnostics : [];
  const commandEntries = Array.isArray(commandDiagnostics) ? commandDiagnostics : [];
  const text = [
    "ResearchTube Diagnostics",
    `Exported: ${(/* @__PURE__ */ new Date()).toISOString()}`,
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
  return `${String(query).trim().toLocaleLowerCase()}\0${limit}`;
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
      query: searchDiagnosticQuery(query),
      limit,
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
    request_id: context.request_id,
    query: context.query,
    limit,
    queue_depth: searchQueueDepth
  });
  const task = searchQueue.then(() => runQueuedYouTubeSearch(query, limit, context));
  searchQueue = task.catch(() => void 0);
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
    request_id: context.request_id,
    outcome,
    queue_depth: searchQueueDepth,
    ...error ? { error: searchDiagnosticMessage(error) } : {}
  });
}
async function runQueuedYouTubeSearch(query, limit, context) {
  await throwIfSearchCooldown(context);
  const spacing = Math.max(0, lastSearchStartedAt + SEARCH_MIN_START_INTERVAL_MS - Date.now());
  if (spacing) await delay(spacing);
  await throwIfSearchCooldown(context);
  lastSearchStartedAt = Date.now();
  void recordSearchDiagnostic("started", {
    request_id: context.request_id,
    query: context.query,
    limit,
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
      request_id: context.request_id,
      returned: result.returned,
      requested: result.requested,
      has_more: result.hasMore,
      http_requests: context.http_requests,
      elapsed_ms: Date.now() - lastSearchStartedAt
    });
    return result;
  } catch (error) {
    if (error?.code === "YOUTUBE_SEARCH_VERIFICATION") {
      void recordSearchDiagnostic("verification_rejected", {
        request_id: context.request_id,
        http_requests: context.http_requests,
        elapsed_ms: Date.now() - lastSearchStartedAt,
        ...error.search_diagnostic ?? {}
      });
      const retryAfterSeconds = await applySearchCooldown(context);
      throw new YouTubeSearchRateLimitError(retryAfterSeconds);
    }
    void recordSearchDiagnostic("failed", {
      request_id: context.request_id,
      http_requests: context.http_requests,
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
    if (cooldownUntil && Number(config.youtubeSearchCooldownLevel || 0)) {
      await chrome.storage.local.set({
        youtubeSearchCooldownUntil: 0,
        youtubeSearchCooldownLevel: 0
      });
      void recordSearchDiagnostic("cooldown_expired", {
        ...context ? { request_id: context.request_id } : {},
        previous_cooldown_level: Number(config.youtubeSearchCooldownLevel || 0)
      });
    }
    return;
  }
  await setActionBadge("youtube-rate-limited");
  void recordSearchDiagnostic("blocked_by_cooldown", {
    ...context ? { request_id: context.request_id } : {},
    retry_after_ms: remainingMs,
    cooldown_level: Number(config.youtubeSearchCooldownLevel || 0)
  });
  throw new YouTubeSearchRateLimitError(Math.ceil(remainingMs / 1e3));
}
async function applySearchCooldown(context = null) {
  const config = await getConfig();
  const now = Date.now();
  const priorCooldownActive = Number(config.youtubeSearchCooldownUntil || 0) > now;
  const priorLevel = priorCooldownActive ? Number(config.youtubeSearchCooldownLevel || 0) : 0;
  const nextLevel = Math.min(priorLevel + 1, SEARCH_COOLDOWN_STEPS_MS.length);
  const duration = SEARCH_COOLDOWN_STEPS_MS[nextLevel - 1];
  const retryAfterSeconds = Math.ceil(duration / 1e3);
  await chrome.storage.local.set({
    youtubeSearchCooldownUntil: now + duration,
    youtubeSearchCooldownLevel: nextLevel,
    lastStatus: `YouTube search temporarily limited; retry after ${retryAfterSeconds} seconds`
  });
  await setActionBadge("youtube-rate-limited");
  void recordSearchDiagnostic("cooldown_applied", {
    ...context ? { request_id: context.request_id } : {},
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
      ...item.method ? { method: item.method } : {},
      ...Number.isInteger(item.status) ? { status: item.status } : {},
      ...item.response_type ? { response_type: item.response_type } : {},
      ...typeof item.redirected === "boolean" ? { redirected: item.redirected } : {}
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
    title: details.title,
    description: details.shortDescription || "",
    channel: { name: details.author || null, channelId: details.channelId || null },
    publishedAt: microformat.publishDate || microformat.uploadDate || null,
    durationSeconds: Number(details.lengthSeconds || 0) || null,
    views: Number.isFinite(Number(details.viewCount)) ? Number(details.viewCount) : parseYouTubeCount(viewsText),
    viewsText,
    likes: parseYouTubeCount(likesText),
    likesText,
    commentCount: parseYouTubeCount(commentCountText),
    commentCountText,
    category: microformat.category || null,
    tags: microformat.tags || [],
    thumbnailUrl: details.thumbnail?.thumbnails?.at(-1)?.url || null,
    captions: { available: tracks.length > 0, tracks },
    youtubeFormats: normalizeYouTubeFormats(player?.streamingData)
  };
}
function normalizeYouTubeFormats(streamingData) {
  const grouped = { available: false, source: "unavailable", message: "YouTube did not expose downloadable media formats for this video.", combined: [], video: [], audio: [] };
  const seen = /* @__PURE__ */ new Set();
  const candidates = [
    ...Array.isArray(streamingData?.formats) ? streamingData.formats : [],
    ...Array.isArray(streamingData?.adaptiveFormats) ? streamingData.adaptiveFormats : []
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
  if (!formatId || !mime.mediaType || mime.mediaType !== "video" && mime.mediaType !== "audio") return null;
  const videoCodec = mime.codecs.find((codec) => !isAudioCodec(codec)) || null;
  const audioCodec = mime.codecs.find(isAudioCodec) || null;
  const kind = mime.mediaType === "audio" ? "audio" : audioCodec ? "combined" : "video";
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
  return rightPixels - leftPixels || (right.fps || 0) - (left.fps || 0) || (right.bitrateBps || 0) - (left.bitrateBps || 0) || left.formatId.localeCompare(right.formatId, void 0, { numeric: true });
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
  if (identifier.length < 2 || identifier.length > 2e3) throw new Error(`${label} is required`);
  return identifier;
}
function optionalContinuation(value) {
  if (value === void 0 || value === null || value === "") return null;
  const continuation = String(value);
  if (continuation.length > 2e4) throw new Error("continuation is too long");
  return continuation;
}
async function runYouTubePageTool(action, videoId, args) {
  try {
    return await runYouTubePageToolAttempt(action, videoId, args);
  } catch (error) {
    if (!isRecoverablePageContextError(error)) throw error;
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
        ...videoId ? { videoId } : {},
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
      ...videoId ? { videoId } : {},
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
async function waitForYouTubeTab(tabId, timeoutMs = 45e3) {
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
      action: "youtube_get_video",
      videoId,
      endpoint: "/watch",
      method: "GET",
      status: response.status,
      response_type: response.type,
      redirected: response.redirected
    });
    return response;
  } catch (error) {
    void recordCommandDiagnostic("youtube_http_network_error", {
      action: "youtube_get_video",
      videoId,
      endpoint: "/watch",
      method: "GET",
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
function textOf(value) {
  return value?.simpleText ?? value?.runs?.map((run) => run.text ?? "").join("") ?? "";
}
function findLikeText(value) {
  let likes = null;
  walk(value, (node) => {
    if (likes || !node || typeof node !== "object") return;
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
  const suffix = compact.match(/(\d+(?:[.,]\d+)?)\s*([KMBT])/);
  if (suffix) {
    const amount = Number(suffix[1].replace(",", "."));
    const multiplier = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[suffix[2].toUpperCase()];
    return Number.isFinite(amount) && multiplier ? Math.round(amount * multiplier) : null;
  }
  const digits = compact.replace(/\D/g, "");
  return digits ? Number(digits) : null;
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
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(objectStart, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}
