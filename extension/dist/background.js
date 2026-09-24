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
var DEFAULT_MCP_TOOL_PREFERENCES = Object.freeze({ newToolsEnabledByDefault: true, enabledByName: {} });
var MCP_TOOL_GROUPS = Object.freeze({
  system: { title: "System", order: 10 },
  workspace: { title: "Workspace", order: 20 },
  media: { title: "Media and images", order: 30 },
  visualMap: { title: "Visual maps", order: 40 },
  camera: { title: "Camera", order: 50 },
  youtube: { title: "YouTube", order: 60 },
  downloads: { title: "Downloads", order: 70 },
  clipboard: { title: "Clipboard", order: 80 },
  library: { title: "Library and sharing", order: 90 },
  online: { title: "Online Share", order: 100 },
  custom: { title: "Custom", order: 110 }
});
var MCP_TOOL_SETTINGS = Object.freeze({
  system_agent_status: { group: "system", alwaysEnabled: true },
  workspace_list: { group: "workspace" },
  workspace_stat: { group: "workspace" },
  workspace_mkdir: { group: "workspace" },
  workspace_move: { group: "workspace" },
  workspace_delete: { group: "workspace" },
  media_probe: { group: "media" },
  media_capture_frame: { group: "media" },
  media_capture_screen: { group: "media" },
  media_image_crop: { group: "media" },
  media_show_in_chat: { group: "media" },
  media_image_inspect: { group: "media" },
  media_visual_map_create: { group: "visualMap" },
  media_visual_map_get_task: { group: "visualMap" },
  media_visual_map_cancel_task: { group: "visualMap" },
  media_camera_list: { group: "camera" },
  media_camera_capture_frame: { group: "camera" },
  media_camera_record_video: { group: "camera" },
  media_camera_record_audio: { group: "camera" },
  media_camera_record_status: { group: "camera" },
  media_camera_record_stop: { group: "camera" },
  youtube_search: { group: "youtube" },
  youtube_get_video: { group: "youtube" },
  youtube_get_channel_videos: { group: "youtube" },
  youtube_get_channel_playlists: { group: "youtube" },
  youtube_get_playlist_videos: { group: "youtube" },
  youtube_get_transcript: { group: "youtube" },
  youtube_get_comments: { group: "youtube" },
  youtube_get_comment_replies: { group: "youtube" },
  youtube_download_get_formats: { group: "downloads" },
  youtube_download: { group: "downloads" },
  youtube_download_get_task: { group: "downloads" },
  youtube_download_task_diagnostics: { group: "downloads" },
  youtube_download_cancel_task: { group: "downloads" },
  clipboard_status: { group: "clipboard" },
  clipboard_get: { group: "clipboard" },
  clipboard_set: { group: "clipboard" },
  library_store_start: { group: "library" },
  library_store_status: { group: "library" },
  library_store_cancel: { group: "library" },
  online_share_start: { group: "online" },
  online_share_status: { group: "online" },
  online_share_stop: { group: "online" }
});
var EXTENSION_VERSION = "1.89.0";
var REQUIRED_AGENT_INTERFACE_VERSION = 50;
var CAPTURE_FRAME_WIDGET_URI = "ui://researchtube/capture-frame-v39.html";
var RESEARCHTUBE_SERVER_DESCRIPTION = "ResearchTube provides YouTube research, local media and image operations, workspace management, screenshots, clipboard, and Library integration. Search this server when the user refers to ResearchTube, YouTube analysis, a previously created workspace file, captured frame, screenshot, crop, clipboard, or asks to continue a previous ResearchTube operation. In clients with deferred tools, ResearchTube is discoverable through functions.exec lazy MCP-tool discovery; search there before treating the capability as unavailable.";
var RESEARCHTUBE_MCP_INSTRUCTIONS = "ResearchTube exposes MCP tools that may be loaded or discovered lazily by the client. When the user mentions ResearchTube, invokes @ResearchTube, asks to repeat a ResearchTube operation, or requests a capability previously provided by ResearchTube, do not infer that ResearchTube is unavailable merely because its tools are not currently visible as a top-level tool namespace. In this client, ResearchTube is available through functions.exec with lazy MCP-tool discovery: search there for the appropriate ResearchTube tool before reporting that the capability is unavailable. Only report ResearchTube as unavailable if tool discovery actually fails, the required tool cannot be found after discovery, or an actual ResearchTube tool invocation returns an availability, connection, compatibility, or transport error. Successful use earlier in the conversation is evidence that the tools may be discoverable again; rediscover them rather than assuming access has disappeared. media_capture_frame, media_capture_screen, and media_image_crop create workspace images only: when showInChat is true, after a successful result immediately call media_show_in_chat once with the returned workspace path. When showInChat is false, do not call the display tool.";
var CAPTURE_FRAME_OFFSCREEN_DOCUMENT = "capture-frame-offscreen.html";
var AGENT_HEALTH_TIMEOUT_MS = 5e3;
var AGENT_TASK_TIMEOUT_MS = 1e4;
var AGENT_CAPTURE_FRAME_TIMEOUT_MS = 9e4;
var POLL_RETRY_DELAY_MS = 250;
var SEARCH_MIN_START_INTERVAL_MS = 500;
var SEARCH_CACHE_TTL_MS = 5 * 6e4;
var SEARCH_COOLDOWN_STEPS_MS = [2e3, 5e3, 1e4, 2e4, 4e4, 6e4];
var CDP_SERVICE_TAB_STORAGE_KEY = "researchtubeCdpServiceTabId";
var CDP_PROTOCOL_VERSION = "1.3";
var CDP_COMPOSER_SETTLE_MS = 750;
var CDP_FILE_CHOOSER_ATTEMPTS = 2;
var CDP_IMAGE_BATCH_MAX_FILES = 5;
var CDP_SENT_DRAFT_CLEAR_CHECK_DELAYS_MS = [500, 500, 1e3, 2e3];
var LIBRARY_STORE_TASK_STORAGE_KEY = "researchtubeLibraryStoreTasksV1";
var LIBRARY_STORE_QUEUE_STORAGE_KEY = "researchtubeLibraryStoreQueueV1";
var SEARCH_DIAGNOSTIC_MAX_ENTRIES = 250;
var SEARCH_DIAGNOSTIC_MAX_QUERY_LENGTH = 360;
var COMMAND_DIAGNOSTIC_MAX_ENTRIES = 300;
var DESCRIBE_VIDEO_DUPLICATE_WINDOW_MS = 8e3;
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
var recentDescribeVideoRequests = /* @__PURE__ */ new Map();
var captureFrameOffscreenPromise = null;
var libraryStoreTasks = /* @__PURE__ */ new Map();
var libraryStoreQueue = [];
var libraryStoreLoaded = false;
var libraryStoreLoading = null;
var libraryStoreDraining = false;
var searchCache = /* @__PURE__ */ new Map();
var nullableString = { type: ["string", "null"] };
var rejectedToolResultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { const: "rejected" },
    error: {
      type: "object",
      additionalProperties: false,
      properties: { code: { type: "string" }, message: { type: "string" }, detail: nullableString },
      required: ["code", "message", "detail"]
    }
  },
  required: ["status", "error"]
};
var nullableInteger = { type: ["integer", "null"] };
var nullableNumber = { type: ["number", "null"] };
var downloadFormatSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    formatId: { type: "string", description: "Numeric media format identifier in this exact source snapshot. For youtube_download, select a numeric ID only when it was returned by youtube_download_get_formats, not merely by youtubeFormats." },
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
    combined: { type: "array", items: downloadFormatSchema, description: "Ready-made video+audio formats confirmed by local yt-dlp. Select an exact numeric formatId here as formatSelection.combined." },
    video: { type: "array", items: downloadFormatSchema, description: "Video-only formats confirmed by local yt-dlp. Select one exact numeric formatId here as formatSelection.video." },
    audio: { type: "array", items: downloadFormatSchema, description: "Audio-only formats confirmed by local yt-dlp. Select one exact numeric formatId here as formatSelection.audio." }
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
var chromeAutomationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    state: { type: "string", enum: ["enabled", "disabled", "mixed", "unknown"] },
    chromeRunning: { type: ["boolean", "null"] },
    browserInstances: { type: "integer", minimum: 0 },
    message: { type: "string", minLength: 1 }
  },
  required: ["state", "chromeRunning", "browserInstances", "message"]
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
    chromeAutomation: { anyOf: [chromeAutomationSchema, { type: "null" }], description: "Whether Chrome was started with the silent debugger automation switch. Unknown when the Local Agent is unavailable or cannot inspect it." },
    platform: { anyOf: [agentPlatformSchema, { type: "null" }], description: "Public operating-system information for the machine running the Local Agent. It excludes host name, user name, paths, network addresses, and other host identifiers." },
    workspace: { anyOf: [agentWorkspaceSchema, { type: "null" }] },
    components: {
      anyOf: [{
        type: "object",
        additionalProperties: false,
        properties: { ytDlp: agentComponentSchema, deno: agentComponentSchema, ffmpeg: agentComponentSchema, ffprobe: agentComponentSchema, cloudflared: agentComponentSchema },
        required: ["ytDlp", "deno", "ffmpeg", "ffprobe", "cloudflared"]
      }, { type: "null" }]
    }
  },
  required: ["available", "error", "message", "status", "extensionVersion", "extensionInterfaceVersion", "agentVersion", "interfaceVersion", "chromeAutomation", "platform", "workspace", "components"]
};
var youtubeDownloadResultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    videoId: { type: "string", description: "YouTube video ID requested for download." },
    filePath: { type: "string", description: "Path relative to the Local Agent workspace; it never exposes an arbitrary system path." },
    fileName: { type: "string", description: "Sanitized downloaded filename, including [yt_<videoId>], an optional [partial_<start>_<end>] tag, and the task ID." },
    outputDir: { type: "string", description: "Workspace-relative output directory used for this download." },
    partial: { anyOf: [{ type: "object", additionalProperties: false, properties: { startSeconds: { type: "number", minimum: 0 }, endSeconds: { type: "number", minimum: 0 } }, required: ["startSeconds", "endSeconds"] }, { type: "null" }], description: "Requested time range when this is a partial download; otherwise null." }
  },
  required: ["videoId", "filePath", "fileName", "outputDir", "partial"]
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
    combined: { ...downloadSelectionValueSchema, description: "One ready-made audio+video track: 'best' or a numeric formatId from youtube_download_get_formats.downloadFormats.combined. Do not set video or audio at the same time." },
    video: { ...downloadSelectionValueSchema, description: "One video-only track: 'best' or a numeric formatId from youtube_download_get_formats.downloadFormats.video." },
    audio: { ...downloadSelectionValueSchema, description: "One audio-only track: 'best' or a numeric formatId from youtube_download_get_formats.downloadFormats.audio." }
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
    taskId: { type: "string", description: "Opaque Local Agent download task ID. Pass it unchanged to youtube_download_get_task or youtube_download_cancel_task." },
    status: { type: "string", enum: ["working"], description: "The download has been created and is running asynchronously." },
    statusMessage: { type: "string" },
    phase: { ...downloadPhaseSchema, description: "Current yt-dlp operation phase. A new task begins in preparing." },
    createdAt: { type: "string", format: "date-time" },
    lastUpdatedAt: { type: "string", format: "date-time", description: "The time of the most recent progress, lifecycle, or liveness-heartbeat update." },
    pollIntervalMs: { type: "integer", minimum: 100, description: "Suggested minimum interval before calling youtube_download_get_task again." },
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
var workspaceShareFileTypeSchema = { type: "string", enum: ["images", "audio", "video", "documents", "archives", "other", "all"] };
var workspaceShareStatusSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    state: { type: "string", enum: ["active", "inactive"] },
    folder: nullableString,
    file: nullableString,
    fileTypes: { type: "array", uniqueItems: true, items: workspaceShareFileTypeSchema },
    publicBaseUrl: { ...nullableString, pattern: "^https://", description: "Temporary folder URL for an external browser or HTTP client to download allowed files." },
    publicFileUrl: { ...nullableString, pattern: "^https://", description: "Temporary URL when exactly one workspace file is shared." },
    methods: { type: "array", items: { type: "string", enum: ["GET", "HEAD"] } },
    externallyReachable: { type: ["boolean", "null"], description: "True only after an explicitly requested wsrv.nl probe obtained an image response." },
    externalProbe: { type: "object", additionalProperties: false, properties: { state: { type: "string", enum: ["not_requested", "passed", "failed"] }, provider: { type: "string", const: "wsrv.nl" }, probePath: nullableString, httpStatus: nullableInteger, contentType: nullableString }, required: ["state", "provider", "probePath", "httpStatus", "contentType"] }
  },
  required: ["state", "folder", "file", "fileTypes", "publicBaseUrl", "publicFileUrl", "methods", "externallyReachable", "externalProbe"]
};
var workspaceShareStopSchema = {
  type: "object",
  additionalProperties: false,
  properties: { state: { type: "string", const: "stopped" }, stopped: { type: "boolean" } },
  required: ["state", "stopped"]
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
var screenCaptureImageInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    format: { ...captureFrameFormatSchema, default: "png" },
    quality: { type: "integer", minimum: 1, maximum: 100, description: "JPEG/WebP quality. It is invalid for PNG." }
  }
};
var captureFrameYoutubeInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    videoId: { type: "string", minLength: 6, description: "YouTube video ID." },
    formatId: { type: "string", pattern: "^[0-9]+$", description: "Exact numeric video formatId returned immediately beforehand by youtube_download_get_formats. Do not use youtube_get_video.youtubeFormats here." }
  },
  required: ["videoId", "formatId"]
};
var captureFrameSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sourcePath: { type: "string", description: "Logical workspace-relative source media-file path, or youtube:<videoId> for partial YouTube capture." },
    sourceVideoId: { type: "string", description: "Present for a partial YouTube capture." },
    sourceVideoFormatId: { type: "string", description: "yt-dlp-confirmed numeric format ID used for a partial YouTube capture." },
    sourceTitle: { type: "string", description: "Title obtained by the same yt-dlp operation for a partial YouTube capture." },
    partialDownload: { type: "object", additionalProperties: false, properties: { startSeconds: { type: "number", minimum: 0 }, endSeconds: { type: "number", minimum: 0 } }, required: ["startSeconds", "endSeconds"] },
    requestedTimestampSeconds: { type: "number", minimum: 0 },
    actualTimestampSeconds: { ...nullableNumber, minimum: 0, description: "Decoded-frame timestamp reported by ffmpeg when available; null only when ffmpeg did not report it." },
    selectedVideoStreamIndex: { type: "integer", minimum: 0, description: "ffprobe streams[].index of the video stream used." },
    seekMode: { type: "string", enum: ["accurate", "fast"] },
    displayRotationApplied: { type: "boolean" },
    showInChat: { type: "boolean", description: "Whether this result was requested for visible inline display in ChatGPT." },
    image: {
      type: "object",
      additionalProperties: false,
      properties: {
        format: captureFrameFormatSchema,
        mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp"] },
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
        imageSizeBytes: { type: "integer", minimum: 0 },
        workspacePath: { type: "string", minLength: 1, description: "Logical workspace-relative path of the captured image. media_capture_frame always creates this file." }
      },
      required: ["format", "mimeType", "width", "height", "imageSizeBytes", "workspacePath"]
    }
  },
  required: ["sourcePath", "requestedTimestampSeconds", "actualTimestampSeconds", "selectedVideoStreamIndex", "seekMode", "displayRotationApplied", "showInChat", "image"]
};
var visualMapTimestampPositionSchema = { type: "string", enum: ["none", "topLeft", "topRight", "bottomLeft", "bottomRight"] };
var visualMapSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sourcePath: { type: "string", minLength: 1 },
    selection: { type: "string", enum: ["uniform", "sceneDetect", "hybrid"] },
    sceneDetectThreshold: { anyOf: [{ type: "number", minimum: 0, maximum: 100 }, { type: "null" }] },
    range: { type: "object", additionalProperties: false, properties: { startSeconds: { type: "number", minimum: 0 }, endSeconds: { type: "number", minimum: 0 } }, required: ["startSeconds", "endSeconds"] },
    columns: { type: "integer", minimum: 1 },
    rows: { type: "integer", minimum: 1 },
    mapCapacity: { type: "integer", minimum: 1 },
    maxTotalFrames: { type: "integer", minimum: 1 },
    actualTotalFrames: { type: "integer", minimum: 1 },
    maps: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, properties: { workspacePath: { type: "string", minLength: 1 }, frameCount: { type: "integer", minimum: 1 }, timestampsSeconds: { type: "array", minItems: 1, items: { type: "number", minimum: 0 } } }, required: ["workspacePath", "frameCount", "timestampsSeconds"] } }
  },
  required: ["sourcePath", "selection", "sceneDetectThreshold", "range", "columns", "rows", "mapCapacity", "maxTotalFrames", "actualTotalFrames", "maps"]
};
var visualMapTaskSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    taskId: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["working", "completed", "failed", "cancelled"] },
    statusMessage: { type: "string" },
    phase: { type: "string", enum: ["preparing", "detectingScenes", "extractingFrames", "assemblingMaps", "completed", "failed", "cancelled"] },
    progressPercent: { type: "number", minimum: 0, maximum: 100 },
    completedFrames: { type: "integer", minimum: 0 },
    totalFrames: { type: "integer", minimum: 0 },
    completedMaps: { type: "integer", minimum: 0 },
    totalMaps: { type: "integer", minimum: 0 },
    createdAt: { type: "string" },
    lastUpdatedAt: { type: "string" },
    pollIntervalMs: { type: "integer", minimum: 100 },
    result: visualMapSchema,
    error: { type: "object", additionalProperties: false, properties: { code: { type: "string" }, message: { type: "string" } }, required: ["code", "message"] }
  },
  required: ["taskId", "status", "statusMessage", "phase", "progressPercent", "completedFrames", "totalFrames", "completedMaps", "totalMaps", "createdAt", "lastUpdatedAt", "pollIntervalMs"]
};
var visualMapCancelTaskSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    taskId: { type: "string", minLength: 1 },
    accepted: { type: "boolean" },
    message: { type: "string" }
  },
  required: ["taskId", "accepted", "message"]
};
var cameraModeSchema = {
  type: "object",
  additionalProperties: false,
  properties: { width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 }, fps: { type: "number", exclusiveMinimum: 0 } },
  required: ["width", "height"]
};
var cameraListSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cameras: { type: "array", items: { type: "object", additionalProperties: false, properties: { cameraId: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, audioAvailable: { type: "boolean" }, videoModes: { type: "object", additionalProperties: false, minProperties: 1, properties: { "30": cameraModeSchema, "60": cameraModeSchema } } }, required: ["cameraId", "name", "audioAvailable", "videoModes"] } }
  },
  required: ["cameras"]
};
var cameraFrameSchema = {
  type: "object",
  additionalProperties: false,
  properties: { cameraId: { type: "string", minLength: 1 }, workspacePath: { type: "string", minLength: 1 }, format: { type: "string", enum: ["png", "jpeg", "webp"] }, mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp"] }, width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 }, imageSizeBytes: { type: "integer", minimum: 0 } },
  required: ["cameraId", "workspacePath", "format", "mimeType", "width", "height", "imageSizeBytes"]
};
var cameraRecordResultSchema = {
  oneOf: [
    { type: "object", additionalProperties: false, properties: { cameraId: { type: "string", minLength: 1 }, filePath: { type: "string", minLength: 1 }, format: { const: "mp4" }, mimeType: { const: "video/mp4" }, width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 }, fps: { type: "number", exclusiveMinimum: 0 }, audioIncluded: { const: true }, durationSeconds: { type: "number", minimum: 0 }, stoppedEarly: { type: "boolean" } }, required: ["cameraId", "filePath", "format", "mimeType", "width", "height", "fps", "audioIncluded", "durationSeconds"] },
    { type: "object", additionalProperties: false, properties: { cameraId: { type: "string", minLength: 1 }, filePath: { type: "string", minLength: 1 }, format: { const: "m4a" }, mimeType: { const: "audio/mp4" }, durationSeconds: { type: "number", minimum: 0 }, stoppedEarly: { type: "boolean" } }, required: ["cameraId", "filePath", "format", "mimeType", "durationSeconds"] }
  ]
};
var cameraRecordTaskSchema = {
  type: "object",
  additionalProperties: false,
  properties: { taskId: { type: "string", minLength: 1 }, recordingType: { type: "string", enum: ["video", "audio"] }, status: { type: "string", enum: ["working", "completed", "failed"] }, phase: { type: "string", enum: ["starting", "recording", "finalizing", "completed", "failed"] }, statusMessage: { type: "string" }, progressPercent: { type: "number", minimum: 0, maximum: 100 }, elapsedSeconds: { type: "number", minimum: 0 }, requestedDurationSeconds: { type: "integer", minimum: 1, maximum: 600 }, targetFps: { type: ["integer", "null"], enum: [30, 60, null] }, maxDurationSeconds: { type: "integer", enum: [60, 600] }, createdAt: { type: "string" }, lastUpdatedAt: { type: "string" }, pollIntervalMs: { type: "integer", minimum: 100 }, result: cameraRecordResultSchema, error: { type: "object", additionalProperties: false, properties: { code: { type: "string" }, message: { type: "string" } }, required: ["code", "message"] } },
  required: ["taskId", "recordingType", "status", "phase", "statusMessage", "progressPercent", "elapsedSeconds", "requestedDurationSeconds", "targetFps", "maxDurationSeconds", "createdAt", "lastUpdatedAt", "pollIntervalMs"]
};
var cameraStopSchema = { type: "object", additionalProperties: false, properties: { taskId: { type: "string", minLength: 1 }, accepted: { type: "boolean" }, message: { type: "string" } }, required: ["taskId", "accepted", "message"] };
var captureFrameWidgetActionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", minLength: 1, description: "The same logical workspace-relative captured-image path supplied to the widget." },
    action: { type: "string", enum: ["copiedPath"] }
  },
  required: ["path", "action"]
};
var screenCaptureSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    workspacePath: { type: "string", minLength: 1, description: "Logical workspace-relative path of the created screen image." },
    format: captureFrameFormatSchema,
    mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp"] },
    width: { type: "integer", minimum: 1, description: "Virtual-desktop image width in pixels." },
    height: { type: "integer", minimum: 1, description: "Virtual-desktop image height in pixels." },
    imageSizeBytes: { type: "integer", minimum: 0 },
    showInChat: { type: "boolean", description: "Whether this screenshot was requested for visible inline display in ChatGPT." },
    monitorCount: { type: "integer", minimum: 1, description: "Number of monitors included in the captured virtual desktop." },
    virtualDesktop: {
      type: "object",
      additionalProperties: false,
      properties: {
        left: { type: "integer", description: "Left edge of the virtual desktop in operating-system display coordinates; it may be negative." },
        top: { type: "integer", description: "Top edge of the virtual desktop in operating-system display coordinates; it may be negative." },
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 }
      },
      required: ["left", "top", "width", "height"]
    }
  },
  required: ["workspacePath", "format", "mimeType", "width", "height", "imageSizeBytes", "showInChat", "monitorCount", "virtualDesktop"]
};
var imageCropSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sourcePath: { type: "string", minLength: 1, description: "Logical workspace-relative path of the source image." },
    sourceWidth: { type: "integer", minimum: 1, description: "Stored source-image width in pixels, before cropping." },
    sourceHeight: { type: "integer", minimum: 1, description: "Stored source-image height in pixels, before cropping." },
    crop: captureFrameCropSchema,
    showInChat: { type: "boolean", description: "Whether the cropped image was requested for visible inline display in ChatGPT." },
    image: {
      type: "object",
      additionalProperties: false,
      properties: {
        format: captureFrameFormatSchema,
        mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp"] },
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
        imageSizeBytes: { type: "integer", minimum: 0 },
        workspacePath: { type: "string", minLength: 1, description: "Logical workspace-relative path of the new cropped image." }
      },
      required: ["format", "mimeType", "width", "height", "imageSizeBytes", "workspacePath"]
    }
  },
  required: ["sourcePath", "sourceWidth", "sourceHeight", "crop", "showInChat", "image"]
};
var showWorkspaceImageSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    workspacePath: { type: "string", minLength: 1, description: "Logical workspace-relative path of the displayed media." },
    mediaType: { type: "string", enum: ["image", "audio"] },
    mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"] },
    sizeBytes: { type: "integer", minimum: 0 },
    showInChat: { type: "boolean", const: true }
  },
  required: ["workspacePath", "mediaType", "mimeType", "sizeBytes", "showInChat"]
};
var mediaInspectImageSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    workspacePath: { type: "string", minLength: 1, description: "Logical workspace-relative path of the inspected image." },
    format: { type: "string", enum: ["png", "jpeg", "webp"] },
    mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp"] },
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
    imageSizeBytes: { type: "integer", minimum: 0 }
  },
  required: ["workspacePath", "format", "mimeType", "width", "height", "imageSizeBytes"]
};
var clipboardRevisionSchema = { type: "string", pattern: "^cb_[0-9]+$", description: "Opaque revision returned by clipboard_status or clipboard_get. Do not construct it." };
var clipboardStatusSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["text", "image", "empty", "unsupported"] },
    revision: clipboardRevisionSchema,
    changed: { type: "boolean" },
    sizeBytes: { type: "integer", minimum: 0 },
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 }
  },
  required: ["type", "revision"]
};
var clipboardGetSuccessSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["text", "image"] },
    revision: clipboardRevisionSchema,
    text: { type: "string" },
    workspacePath: { type: "string", minLength: 1 },
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 },
    sizeBytes: { type: "integer", minimum: 0 }
  },
  required: ["type", "revision"],
  oneOf: [{ required: ["text"] }, { required: ["workspacePath", "width", "height", "sizeBytes"] }]
};
var clipboardGetSchema = {
  oneOf: [
    clipboardGetSuccessSchema,
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean", const: false },
        status: { type: "string", const: "clipboard_changed" },
        message: { type: "string" }
      },
      required: ["ok", "status", "message"]
    }
  ]
};
var clipboardSetSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    success: { type: "boolean", const: true },
    type: { type: "string", enum: ["text", "image"] },
    revision: clipboardRevisionSchema,
    width: { type: "integer", minimum: 1 },
    height: { type: "integer", minimum: 1 }
  },
  required: ["success", "type", "revision"]
};
var pureReadAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
var localAgentReadAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
var pageReadAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
var localDownloadAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
var localDownloadReadAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
var localWorkspaceWriteAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
var localWorkspaceDeleteAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
var libraryStoreFileSchema = {
  type: "object",
  additionalProperties: false,
  properties: { workspacePath: { type: "string", minLength: 1, description: "Logical workspace-relative PNG, JPEG, or WebP file path. It is never an absolute host path." } },
  required: ["workspacePath"]
};
var libraryStorePhaseSchema = { type: "string", enum: ["queued", "resolvingFiles", "attaching", "composerAccepted", "submitting", "submitted", "failed", "cancelled"] };
var libraryStoreTaskSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    taskId: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["queued", "working", "completed", "failed", "cancelled"] },
    phase: libraryStorePhaseSchema,
    files: { type: "array", minItems: 1, maxItems: 5, items: libraryStoreFileSchema },
    queuePosition: { ...nullableInteger, minimum: 1 },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    submittedAt: nullableString,
    libraryAvailability: { type: "string", enum: ["not_requested", "not_verified"] },
    message: { type: "string", minLength: 1 },
    error: nullableString
  },
  required: ["taskId", "status", "phase", "files", "queuePosition", "createdAt", "updatedAt", "submittedAt", "libraryAvailability", "message", "error"]
};
var libraryStoreStartSchema = { type: "object", additionalProperties: false, properties: { task: libraryStoreTaskSchema }, required: ["task"] };
var libraryStoreStatusSchema = libraryStoreTaskSchema;
var libraryStoreCancelSchema = { type: "object", additionalProperties: false, properties: { task: libraryStoreTaskSchema, cancelled: { type: "boolean" } }, required: ["task", "cancelled"] };
function toolDefinitions() {
  return [
    {
      name: "system_agent_status",
      title: "Get ResearchTube Local Agent status",
      description: "Checks availability, compatibility, platform information, and component status of the ResearchTube Local Agent. When ResearchTube availability is uncertain, prefer discovering ResearchTube tools and calling this tool rather than concluding that ResearchTube is unavailable from tool visibility alone. Returns the serving Chrome Extension implementation version and its required Extension \u2194 Agent interface version, plus the Agent implementation version, interface version, public operating-system information, workspace health, and status, version, discovery source, and diagnostic message for yt-dlp, Deno, ffmpeg, and ffprobe. Deno is an optional local JavaScript runtime passed explicitly to yt-dlp when available. Physical host paths and host identity are intentionally never exposed through MCP. A missing or mismatched Agent interfaceVersion prevents the Extension from using Agent tools, but does not affect ordinary YouTube research tools.",
      annotations: localAgentReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: agentStatusSchema
    },
    {
      name: "library_store_start",
      title: "Store a batch of workspace images in ChatGPT Library",
      description: "Queue one indivisible batch of 1 to 5 PNG, JPEG, or WebP images from the ResearchTube workspace for ChatGPT Library storage. ResearchTube uses one dedicated background ChatGPT service tab, attaches the batch, and presses Send without inserting any text into the Composer. The returned taskId must be polled with library_store_status. A completed task means ResearchTube confirmed Composer acceptance and clicked Send; it never claims that the later ChatGPT Library update is complete.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: { type: "object", additionalProperties: false, properties: { files: { type: "array", minItems: 1, maxItems: 5, uniqueItems: true, items: libraryStoreFileSchema, description: "One immutable batch. Files are attached and submitted together, never split or mixed with another task." } }, required: ["files"] },
      outputSchema: libraryStoreStartSchema
    },
    {
      name: "library_store_status",
      title: "Check a Library storage task",
      description: "Return the current local status of one ResearchTube Library storage task. submitted means ResearchTube confirmed the image batch in Composer and clicked Send without adding instruction text; libraryAvailability remains not_verified because ResearchTube cannot observe the later Library update.",
      annotations: localAgentReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { taskId: { type: "string", minLength: 1 } }, required: ["taskId"] },
      outputSchema: libraryStoreStatusSchema
    },
    {
      name: "library_store_cancel",
      title: "Cancel a queued Library storage task",
      description: "Cancel one Library storage task only while it is queued. A task that has started attaching files or has submitted a request to ChatGPT cannot be cancelled.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { type: "object", additionalProperties: false, properties: { taskId: { type: "string", minLength: 1 } }, required: ["taskId"] },
      outputSchema: libraryStoreCancelSchema
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
      name: "online_share_start",
      title: "Start an online share",
      description: "Explicitly start a temporary public HTTPS share through cloudflared for one existing workspace folder or one file. A folder share needs fileTypes and exposes only allowed regular files beneath that folder; a file share exposes exactly that file. No directory listing is exposed. Set verifyExternal=true to ask wsrv.nl to fetch an image: a folder share then requires probePath, an allowed image inside the folder; a single-file share must itself be an image. externallyReachable is true only after that independent image request succeeds. Starting a new share closes any prior share.",
      annotations: { ...localWorkspaceWriteAnnotations, openWorldHint: true },
      inputSchema: { type: "object", additionalProperties: false, properties: { folder: { type: "string", description: "Existing logical directory. Mutually exclusive with file; empty string means the workspace root." }, file: { type: "string", minLength: 1, description: "Existing logical file. Mutually exclusive with folder." }, fileTypes: { type: "array", minItems: 1, maxItems: 7, uniqueItems: true, items: workspaceShareFileTypeSchema, description: "Required only for a folder share; all cannot be combined with another category." }, verifyExternal: { type: "boolean", default: false, description: "Use wsrv.nl to verify external image reachability." }, probePath: { type: "string", minLength: 1, description: "Required only for a verified folder share: an allowed image inside folder." } }, oneOf: [{ required: ["folder", "fileTypes"], not: { required: ["file"] } }, { required: ["file"], not: { anyOf: [{ required: ["folder"] }, { required: ["fileTypes"] }, { required: ["probePath"] }] } }] },
      outputSchema: workspaceShareStatusSchema
    },
    {
      name: "online_share_status",
      title: "Get online-share status",
      description: "Report the active cloudflared folder or single-file download share. Set verifyExternal=true to repeat its configured wsrv.nl image probe without restarting the share. externallyReachable becomes true only after that probe succeeds. This never exposes a host filesystem path.",
      annotations: localAgentReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { verifyExternal: { type: "boolean", default: false, description: "Repeat the configured external image probe." } } },
      outputSchema: workspaceShareStatusSchema
    },
    {
      name: "online_share_stop",
      title: "Stop the online share",
      description: "Immediately close the currently active local sharing server and its cloudflared Quick Tunnel. It does not delete workspace files.",
      annotations: { ...localWorkspaceWriteAnnotations, openWorldHint: true },
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: workspaceShareStopSchema
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
      name: "media_capture_frame",
      title: "Extract one frame from workspace or YouTube",
      description: "Extract one frame either from an existing workspace media path, or directly from YouTube without downloading the full video. For direct YouTube capture, first call youtube_download_get_formats and pass its exact numeric video formatId as youtube.formatId; the browser-side youtubeFormats list is not accepted because it can differ from local yt-dlp. The Local Agent uses yt-dlp --download-sections with ffmpeg to download only a short window around timestampSeconds, deletes that temporary section, and saves only the image in the workspace. The image filename uses the title returned by that same yt-dlp operation plus [yt_<videoId>], timestamp, and unique capture ID. path and youtube are mutually exclusive. videoStreamIndex is only for path sources. showInChat defaults to false: set it true only when the user needs to see this particular frame inline. Inline display is presentation only; it does not make image pixels a reliable visual input to ChatGPT. No media URLs or host paths are exposed.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1, description: "Logical workspace-relative path of the source media file." },
          youtube: captureFrameYoutubeInputSchema,
          timestampSeconds: { type: "number", minimum: 0, description: "Required media timestamp, in seconds." },
          videoStreamIndex: { type: "integer", minimum: 0, description: "Optional ffprobe streams[].index of the video stream to capture." },
          seekMode: { type: "string", enum: ["accurate", "fast"], default: "accurate" },
          applyDisplayRotation: { type: "boolean", default: true, description: "Apply display rotation metadata before cropping and resizing." },
          crop: captureFrameCropSchema,
          resize: captureFrameResizeSchema,
          image: captureFrameImageInputSchema,
          outputPath: { type: "string", minLength: 1, description: "Optional logical workspace-relative output image path. If omitted, media_capture_frame writes a uniquely named image to captures/. Use this only to choose a different workspace folder or filename; media_capture_frame never overwrites an existing file." },
          showInChat: { type: "boolean", default: false, description: "Set true only when the user needs this resulting frame displayed inline. After a successful result, call media_show_in_chat once for its returned image.workspacePath." }
        },
        required: ["timestampSeconds"],
        oneOf: [{ required: ["path"] }, { required: ["youtube"] }]
      },
      outputSchema: captureFrameSchema,
      _meta: {
        "openai/toolInvocation/invoking": "Capturing frame\u2026",
        "openai/toolInvocation/invoked": "Frame captured."
      }
    },
    {
      name: "media_visual_map_create",
      title: "Start a video visual map",
      description: "Start an asynchronous task that creates chronological PNG contact sheets from an existing Workspace video. selection=uniform samples evenly. selection=sceneDetect uses FFmpeg's native scdet filter; sceneDetectThreshold is its percentage threshold from 0 to 100 and defaults to 10. It de-duplicates changes closer than two seconds and retains the strongest maxTotalFrames. selection=hybrid also uses scdet, but divides the requested range into maxTotalFrames equal intervals and chooses each interval's strongest detected change; an empty interval uses its midpoint. Results are chronological. Never downloads media. Poll media_visual_map_get_task no faster than pollIntervalMs until it completes; then display a specific map with media_show_in_chat if needed.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          workspacePath: { type: "string", minLength: 1, description: "Existing logical workspace-relative video path." },
          columns: { type: "integer", minimum: 1 },
          rows: { type: "integer", minimum: 1 },
          maxTotalFrames: { type: "integer", minimum: 1, maximum: 120 },
          selection: { type: "string", enum: ["uniform", "sceneDetect", "hybrid"], default: "uniform" },
          sceneDetectThreshold: { type: "number", minimum: 0, maximum: 100, default: 10, description: "FFmpeg scdet threshold percentage. Use only with selection=sceneDetect or hybrid." },
          startSeconds: { type: "number", minimum: 0, default: 0 },
          endSeconds: { type: "number", minimum: 0 },
          maxMapDimension: { type: "integer", minimum: 1, default: 4096 },
          frameTimestampPosition: { ...visualMapTimestampPositionSchema, default: "bottomRight" }
        },
        required: ["workspacePath", "columns", "rows", "maxTotalFrames"]
      },
      outputSchema: visualMapTaskSchema,
      _meta: { "openai/toolInvocation/invoking": "Starting visual map\u2026", "openai/toolInvocation/invoked": "Visual-map task started." }
    },
    {
      name: "media_visual_map_get_task",
      title: "Get visual-map task progress",
      description: "Get the current phase, percentage, and final result or error for a visual-map task. Poll no faster than the returned pollIntervalMs. When completed, maps are Workspace images and are not displayed automatically.",
      annotations: localAgentReadAnnotations,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { taskId: { type: "string", minLength: 1 } },
        required: ["taskId"]
      },
      outputSchema: visualMapTaskSchema,
      _meta: { "openai/toolInvocation/invoking": "Checking visual-map progress\u2026", "openai/toolInvocation/invoked": "Visual-map progress checked." }
    },
    {
      name: "media_visual_map_cancel_task",
      title: "Cancel visual-map task",
      description: "Request cancellation of a working visual-map task. Pass taskId unchanged, then call media_visual_map_get_task to observe its terminal state.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { taskId: { type: "string", minLength: 1 } },
        required: ["taskId"]
      },
      outputSchema: visualMapCancelTaskSchema,
      _meta: { "openai/toolInvocation/invoking": "Cancelling visual map\u2026", "openai/toolInvocation/invoked": "Visual-map cancellation requested." }
    },
    {
      name: "media_camera_list",
      title: "List local cameras",
      description: "List currently available local video cameras. cameraId is opaque and valid only while the Local Agent remains running. videoModes returns the largest native mode for each available 30 or 60 FPS recording choice; never returns native device paths or identifiers.",
      annotations: localAgentReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: cameraListSchema
    },
    {
      name: "media_camera_capture_frame",
      title: "Capture a camera frame",
      description: "Capture one current frame from a camera returned by media_camera_list, using its automatically selected maximum native mode. Stores a PNG by default under captures/camera/. This does not display the image; call media_show_in_chat once afterwards only when the user asks to see it.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { cameraId: { type: "string", minLength: 1 }, targetPath: { type: "string", minLength: 1 }, targetFormat: { type: "string", enum: ["png", "jpeg", "webp"], default: "png" } }, required: ["cameraId"] },
      outputSchema: cameraFrameSchema
    },
    {
      name: "media_camera_record_video",
      title: "Record a camera video",
      description: "Start an asynchronous H.264 MP4 video recording with sound from the camera's matched microphone. Choose targetFps from videoModes; durationSeconds is 1\u201360. The terminal result reports the actual video mode and audioIncluded=true. Poll media_camera_record_status until terminal; no partial output is exposed.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { cameraId: { type: "string", minLength: 1 }, durationSeconds: { type: "integer", minimum: 1, maximum: 60 }, targetFps: { type: "integer", enum: [30, 60] } }, required: ["cameraId", "durationSeconds", "targetFps"] },
      outputSchema: cameraRecordTaskSchema
    },
    {
      name: "media_camera_record_audio",
      title: "Record camera audio",
      description: "Start an asynchronous M4A/AAC recording from the microphone matched to a listed camera. durationSeconds is 1\u2013600. Poll and stop this task with the same media_camera_record_status and media_camera_record_stop tools used for video recording.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { cameraId: { type: "string", minLength: 1 }, durationSeconds: { type: "integer", minimum: 1, maximum: 600 } }, required: ["cameraId", "durationSeconds"] },
      outputSchema: cameraRecordTaskSchema
    },
    {
      name: "media_camera_record_status",
      title: "Get camera recording status",
      description: "Get progress or the terminal result of either a camera video or camera audio recording task. Poll no faster than pollIntervalMs.",
      annotations: localAgentReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { taskId: { type: "string", minLength: 1 } }, required: ["taskId"] },
      outputSchema: cameraRecordTaskSchema
    },
    {
      name: "media_camera_record_stop",
      title: "Stop a camera recording",
      description: "Request a graceful early stop for a working camera video or audio recording task. Then poll media_camera_record_status until it becomes completed or failed.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { taskId: { type: "string", minLength: 1 } }, required: ["taskId"] },
      outputSchema: cameraStopSchema
    },
    {
      name: "media_capture_screen",
      title: "Capture the full desktop",
      description: "Capture the complete current virtual desktop into one workspace image. FFmpeg is the only pixel-capture implementation: gdigrab on Windows, x11grab on Linux/X11, and avfoundation on macOS. Small platform display queries provide only truthful virtual-desktop bounds and monitorCount; they do not capture pixels. Linux Wayland capture is intentionally not supported. On macOS, the operating system must grant screen-recording permission to the FFmpeg process. This can capture visible sensitive information; invoke it only when a current full-screen image is actually needed. The default is a lossless PNG. JPEG or WebP may be chosen when a smaller file is preferable. outputPath is optional: if omitted, the Agent creates a uniquely named image under screenshots/. Any supplied outputPath must be a logical workspace-relative image path with an extension that matches image.format. showInChat defaults to false: set it true only when the user needs to see this screenshot inline. Inline display is presentation only; it does not make image pixels a reliable visual input to ChatGPT. The tool never returns a host path and never overwrites an existing workspace file.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          outputPath: { type: "string", minLength: 1, description: "Optional logical workspace-relative image path. If omitted, media_capture_screen creates a uniquely named file under screenshots/. It never overwrites an existing file." },
          image: screenCaptureImageInputSchema,
          showInChat: { type: "boolean", default: false, description: "Set true only when the user needs this screenshot displayed inline. After a successful result, call media_show_in_chat once for its workspacePath." }
        }
      },
      outputSchema: screenCaptureSchema,
      _meta: {
        "openai/toolInvocation/invoking": "Capturing desktop\u2026",
        "openai/toolInvocation/invoked": "Desktop captured."
      }
    },
    {
      name: "media_image_crop",
      title: "Crop a workspace image",
      description: "Create a new PNG, JPEG, or WebP image by cutting one rectangular pixel area from an existing PNG, JPEG, or WebP image in the ResearchTube workspace. crop.x and crop.y are zero-based coordinates in the stored source-image pixels; crop.width and crop.height must keep the entire rectangle inside the source image. The source is never changed. The default output is a PNG under crops/; image.format may choose JPEG or WebP, and outputPath may choose a different logical workspace path with a matching extension. showInChat defaults to false: set it true only when the user needs to see this cropped result inline. Inline display is presentation only; it does not make image pixels a reliable visual input to ChatGPT. The tool never overwrites an existing file and never returns a host path.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1, description: "Logical workspace-relative path of an existing PNG, JPEG, or WebP source image." },
          crop: captureFrameCropSchema,
          image: captureFrameImageInputSchema,
          outputPath: { type: "string", minLength: 1, description: "Optional logical workspace-relative path for the new cropped image. If omitted, the Agent creates a unique PNG under crops/. It never overwrites an existing file." },
          showInChat: { type: "boolean", default: false, description: "Set true only when the user needs this cropped image displayed inline. After a successful result, call media_show_in_chat once for its returned image.workspacePath." }
        },
        required: ["path", "crop"]
      },
      outputSchema: imageCropSchema,
      _meta: {
        "openai/toolInvocation/invoking": "Cropping image\u2026",
        "openai/toolInvocation/invoked": "Image cropped."
      }
    },
    {
      name: "media_show_in_chat",
      title: "Show a workspace image or audio recording in chat",
      description: "Show a workspace image or supported audio recording inline in ChatGPT. Use this once after an image-creation result with showInChat=true, or when the user asks to play a recorded camera audio file. A successful result means the card is already shown; do not repeat it for the same file. The tool exposes neither host paths nor media bytes to the model.",
      annotations: localAgentReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1, description: "Logical workspace-relative path of an existing image or supported audio file." } }, required: ["path"] },
      outputSchema: showWorkspaceImageSchema,
      _meta: {
        ui: { resourceUri: CAPTURE_FRAME_WIDGET_URI },
        "openai/outputTemplate": CAPTURE_FRAME_WIDGET_URI,
        "openai/toolInvocation/invoking": "Loading workspace media\u2026",
        "openai/toolInvocation/invoked": "Workspace media shown."
      }
    },
    {
      name: "media_image_inspect",
      title: "Inspect workspace image metadata",
      description: "Independently validate one PNG, JPEG, or WebP image in the ResearchTube workspace and return only its logical workspace path, verified format, MIME type, pixel dimensions, and byte size. Use this when image dimensions or format must be checked; use workspace_stat only for generic filesystem metadata because it never reads file contents. This tool does not return image pixels, base64 data, a widget, or a host filesystem path.",
      annotations: localAgentReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1, description: "Logical workspace-relative path of an existing PNG, JPEG, or WebP image." } }, required: ["path"] },
      outputSchema: mediaInspectImageSchema
    },
    {
      name: "clipboard_status",
      title: "Inspect clipboard state",
      description: "Inspect the current local system clipboard without returning text or saving an image. It reports only supported type (text or image), an opaque revision, and safe metadata. Provide sinceRevision from an earlier response to learn whether the clipboard changed. Do not call this in the background or repeatedly without a user request: the clipboard may contain sensitive data.",
      annotations: localAgentReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { sinceRevision: clipboardRevisionSchema } },
      outputSchema: clipboardStatusSchema
    },
    {
      name: "clipboard_get",
      title: "Read text or image from clipboard",
      description: "Explicitly read the current local clipboard. For text, returns Unicode text directly. For an image, creates one PNG under clipboard/ and returns only its logical workspace path and metadata. If revision is supplied and the clipboard changed, returns the ordinary structured state result status: clipboard_changed without reading clipboard contents; refresh with clipboard_status before deciding whether to read again. Never call this merely to poll clipboard state; use clipboard_status first. Clipboard contents may be sensitive.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { revision: clipboardRevisionSchema } },
      outputSchema: clipboardGetSchema
    },
    {
      name: "clipboard_set",
      title: "Put text or a workspace image on clipboard",
      description: "Explicitly replace the local system clipboard with either text supplied in text or PNG/JPEG/WebP image pixels decoded from workspacePath. Supply exactly one. An image is placed as image data, never as a copied file, path, or file reference. The clipboard may be sensitive and this affects what the user pastes next. Text is limited to 2 MiB; image files to 20 MiB and decoded images to 50 megapixels.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { text: { type: "string", maxLength: 2e6, description: "Unicode text to place on the system clipboard." }, workspacePath: { type: "string", minLength: 1, description: "Logical workspace-relative PNG, JPEG, or WebP path. Its decoded image pixels, not the file, are placed on the clipboard." } }, oneOf: [{ required: ["text"] }, { required: ["workspacePath"] }] },
      outputSchema: clipboardSetSchema
    },
    {
      name: "media_load_workspace_media",
      title: "Load workspace media for the ResearchTube widget",
      description: "Widget-only support tool. Validates a logical workspace image or audio path and returns its loopback Local Agent URL without placing bytes in MCP. It is not available to the model and exposes no host path.",
      annotations: localAgentReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1, description: "Logical workspace-relative path returned by media_capture_frame.image.workspacePath." } }, required: ["path"] },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" }, mediaType: { type: "string", enum: ["image", "audio"] }, mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"] }, sizeBytes: { type: "integer", minimum: 0 } },
        required: ["path", "mediaType", "mimeType", "sizeBytes"]
      },
      _meta: {
        ui: { visibility: ["app"] },
        "openai/visibility": "private",
        "openai/widgetAccessible": true
      }
    },
    {
      name: "media_copy_workspace_path",
      title: "Copy a captured-frame workspace path",
      description: "Widget-only action. Copies one logical ResearchTube workspace image path to the local system clipboard through the installed Chrome Extension. It is not available to the model.",
      annotations: localWorkspaceWriteAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1 } }, required: ["path"] },
      outputSchema: captureFrameWidgetActionSchema,
      _meta: { ui: { visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true }
    },
    {
      name: "youtube_download_get_formats",
      title: "Get formats available for download",
      description: "Ask the Local Agent's current yt-dlp installation which exact formats it can download for one public video now. This is the authoritative format source for youtube_download: choose numeric formatId values only from this tool and call it immediately before downloading. youtube_get_video.youtubeFormats is a separate advisory snapshot from the browser's direct YouTube player response; its IDs can legitimately differ from local yt-dlp because the two clients resolve YouTube playback independently. This tool exposes no media URLs, credentials, host paths, or raw yt-dlp output.",
      annotations: localDownloadReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { videoId: { type: "string", pattern: "^[A-Za-z0-9_-]{6,}$", description: "Public YouTube video ID returned by a ResearchTube discovery or video-details tool." } }, required: ["videoId"] },
      outputSchema: youtubeDownloadFormatsResultSchema
    },
    {
      name: "youtube_download",
      title: "Download a public YouTube video",
      description: "Start an asynchronous download of one public YouTube video through the optional ResearchTube Local Agent and its locally resolved yt-dlp, Deno, and ffmpeg executables. First call youtube_download_get_formats(videoId) immediately before this tool and select exact numeric formatId values from that tool's local-yt-dlp downloadFormats response; never select a numeric ID only from youtube_get_video.youtubeFormats because that direct-YouTube snapshot is advisory and can differ. formatSelection chooses the downloaded media tracks: combined alone, video alone, audio alone, or video plus audio; never mix combined with video/audio. 'best' remains allowed for one requested component. startSeconds and endSeconds are optional as a pair: omit both to download the full video, or provide both to download only that source-video interval. A partial download requires ffmpeg and its resulting filename includes [partial_<start>_<end>]. A video+audio pair is remuxed into MP4 without re-encoding and therefore requires ffmpeg. The Agent accepts no arbitrary yt-dlp selector or arguments, no credentials, and no playlist. Returns a start handle only. Poll youtube_download_get_task no faster than pollIntervalMs; phase identifies the real yt-dlp operation and progressPercent is the percent within that phase, not a fabricated whole-task percentage. If a task fails or its output is unexpected, use youtube_download_task_diagnostics to inspect its normalized lifecycle and cleanup record. outputDir, when supplied, must be a safe workspace-relative directory.",
      annotations: localDownloadAnnotations,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          videoId: { type: "string", pattern: "^[A-Za-z0-9_-]{6,}$", description: "Public YouTube video ID returned by youtube_search, a channel or playlist catalogue, or youtube_get_video." },
          formatSelection: downloadSelectionSchema,
          startSeconds: { type: "number", minimum: 0, description: "Optional source-video interval start in seconds. Must be supplied together with endSeconds; omit both to download the full video." },
          endSeconds: { type: "number", exclusiveMinimum: 0, description: "Optional source-video interval end in seconds. Must be greater than startSeconds and supplied together with it." },
          outputDir: { type: "string", minLength: 1, description: "Optional directory relative to the Local Agent workspace. Defaults to downloads. Do not use an absolute path or .. segments." }
        },
        required: ["videoId", "formatSelection"]
      },
      outputSchema: youtubeDownloadStartSchema
    },
    {
      name: "youtube_download_get_task",
      title: "Get YouTube download status",
      description: "Read the current status of an asynchronous youtube_download task. Pass taskId unchanged and poll no faster than pollIntervalMs while status is working. phase identifies the actual yt-dlp operation. progressPercent is the native 0\u2013100 percent for that phase: selected video and audio tracks each have their own percentage, merging has null, and completed has 100. lastUpdatedAt advances on progress, lifecycle changes, and liveness heartbeats. The terminal result contains only a workspace-relative filePath; its extension reflects the selected track or remuxed pair.",
      annotations: localDownloadReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { taskId: { type: "string", minLength: 1, description: "Opaque taskId returned by youtube_download." } }, required: ["taskId"] },
      outputSchema: youtubeDownloadTaskSchema
    },
    {
      name: "youtube_download_task_diagnostics",
      title: "Get YouTube download diagnostics",
      description: "Read normalized post-mortem lifecycle events for one youtube_download task, especially after failed, cancelled, or unexpected output states. Events identify yt-dlp start/exit, phase transitions, final-output reporting and verification, structured error code, and cleanup of task-specific workspace artifacts. It intentionally does not return raw yt-dlp stdout/stderr, signed media URLs, credentials, or host paths. Use afterEventId to fetch only newer events.",
      annotations: localDownloadReadAnnotations,
      inputSchema: { type: "object", additionalProperties: false, properties: { taskId: { type: "string", minLength: 1, description: "Opaque taskId returned by youtube_download." }, afterEventId: { type: "integer", minimum: 0, default: 0, description: "Return events with eventId greater than this value." }, limit: { type: "integer", minimum: 1, maximum: 100, default: 100, description: "Maximum diagnostic events to return." } }, required: ["taskId"] },
      outputSchema: downloadTaskDiagnosticsSchema
    },
    {
      name: "youtube_download_cancel_task",
      title: "Cancel YouTube download",
      description: "Request cancellation of a currently running youtube_download task. Pass taskId unchanged. Cancellation is cooperative: after an accepted request, call youtube_download_get_task to observe the terminal state.",
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
      description: "Inspect one public YouTube video by video ID. Returns research metadata including title, description, channel, duration, absolute publication date when available, normalized views, likes, and comment count plus YouTube display text, category, tags, thumbnail, all public caption tracks, and youtubeFormats: an advisory format snapshot extracted directly from this video's browser-side YouTube player response. youtubeFormats is useful for media inspection but must not be treated as a guaranteed local download list; before youtube_download, call youtube_download_get_formats for the local yt-dlp-confirmed IDs. Both lists contain no media URLs or credentials. Each caption track has a trackIndex for youtube_get_transcript. It does not return canonical video URLs, caption text, comment text, replies, account-only, private, member-only, or age-restricted content.",
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
function isPrivateMcpTool(tool) {
  return tool?._meta?.["openai/visibility"] === "private" || tool?._meta?.ui?.visibility?.includes("app");
}
function publicMcpTools() {
  return toolDefinitions().filter((tool) => !isPrivateMcpTool(tool));
}
function toolSettingsMetadata(name) {
  const metadata = MCP_TOOL_SETTINGS[name] || {};
  const group = MCP_TOOL_GROUPS[metadata.group] ? metadata.group : "custom";
  return { group, alwaysEnabled: metadata.alwaysEnabled === true };
}
function shortMcpToolDescription(tool) {
  const firstSentence = String(tool.description || tool.title || "").match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || tool.title || tool.name;
  return firstSentence.length <= 180 ? firstSentence : `${firstSentence.slice(0, 177).trimEnd()}\u2026`;
}
function normalizeMcpToolPreferences(value) {
  const rawEnabled = value && typeof value === "object" && !Array.isArray(value) && value.enabledByName && typeof value.enabledByName === "object" && !Array.isArray(value.enabledByName) ? value.enabledByName : {};
  const enabledByName = {};
  for (const [name, enabled] of Object.entries(rawEnabled)) if (typeof enabled === "boolean") enabledByName[name] = enabled;
  return {
    newToolsEnabledByDefault: value?.newToolsEnabledByDefault !== false,
    enabledByName
  };
}
async function mcpToolPreferences() {
  const stored = await chrome.storage.local.get("mcpToolPreferences");
  const preferences = normalizeMcpToolPreferences(stored.mcpToolPreferences ?? DEFAULT_MCP_TOOL_PREFERENCES);
  let changed = false;
  for (const tool of publicMcpTools()) {
    const { alwaysEnabled } = toolSettingsMetadata(tool.name);
    if (!alwaysEnabled && !Object.hasOwn(preferences.enabledByName, tool.name)) {
      preferences.enabledByName[tool.name] = preferences.newToolsEnabledByDefault;
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ mcpToolPreferences: preferences });
  return preferences;
}
async function mcpToolSettingsCatalog() {
  const preferences = await mcpToolPreferences();
  return publicMcpTools().map((tool) => {
    const metadata = toolSettingsMetadata(tool.name);
    return {
      name: tool.name,
      title: tool.title,
      description: shortMcpToolDescription(tool),
      group: metadata.group,
      alwaysEnabled: metadata.alwaysEnabled,
      enabled: metadata.alwaysEnabled || preferences.enabledByName[tool.name] === true
    };
  }).sort((left, right) => MCP_TOOL_GROUPS[left.group].order - MCP_TOOL_GROUPS[right.group].order || left.name.localeCompare(right.name));
}
async function enabledMcpToolDefinitions() {
  const catalog = await mcpToolSettingsCatalog();
  const enabledNames = new Set(catalog.filter((tool) => tool.enabled).map((tool) => tool.name));
  return publicMcpTools().filter((tool) => enabledNames.has(tool.name)).map((tool) => ({
    ...tool,
    outputSchema: { anyOf: [tool.outputSchema, rejectedToolResultSchema] }
  }));
}
async function isMcpToolEnabled(name) {
  const tool = publicMcpTools().find((candidate) => candidate.name === name);
  if (!tool) return true;
  const metadata = toolSettingsMetadata(name);
  if (metadata.alwaysEnabled) return true;
  const preferences = await mcpToolPreferences();
  return preferences.enabledByName[name] === true;
}
async function updateMcpToolEnabled(name, enabled) {
  const tool = publicMcpTools().find((candidate) => candidate.name === name);
  if (!tool) return { ok: false, errorCode: "MCP_TOOL_UNKNOWN", message: "Unknown public MCP tool." };
  if (toolSettingsMetadata(name).alwaysEnabled) return { ok: false, errorCode: "MCP_TOOL_REQUIRED", message: "This MCP tool is always enabled." };
  if (typeof enabled !== "boolean") return { ok: false, errorCode: "MCP_TOOL_INVALID", message: "enabled must be a boolean." };
  const preferences = await mcpToolPreferences();
  preferences.enabledByName[name] = enabled;
  await chrome.storage.local.set({ mcpToolPreferences: preferences });
  return { ok: true, name, enabled };
}
async function updateNewToolsEnabledByDefault(enabled) {
  if (typeof enabled !== "boolean") return { ok: false, errorCode: "MCP_TOOL_INVALID", message: "newToolsEnabledByDefault must be a boolean." };
  const preferences = await mcpToolPreferences();
  preferences.newToolsEnabledByDefault = enabled;
  await chrome.storage.local.set({ mcpToolPreferences: preferences });
  return { ok: true, newToolsEnabledByDefault: enabled };
}
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function cdpError(message, cause = null) {
  const error = new Error(message);
  error.code = "RESEARCHTUBE_CDP_TEST_FAILED";
  if (cause) error.cause = cause;
  return error;
}
function cdpLog(step, details = void 0) {
  const prefix = "[ResearchTube CDP]";
  if (details === void 0) console.info(`${prefix} ${step}`);
  else console.info(`${prefix} ${step}`, details);
}
function cdpErrorLog(step, error) {
  console.error(`[ResearchTube CDP] ${step}`, error instanceof Error ? error.message : error);
}
async function cdpAttach(tabId) {
  cdpLog("Debugger attach requested", { tabId, protocolVersion: CDP_PROTOCOL_VERSION });
  await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
  cdpLog("Debugger attached", { tabId });
}
async function cdpDetach(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
    cdpLog("Debugger detached", { tabId });
  } catch (error) {
    cdpLog("Debugger already detached or service tab closed", { tabId, error: safeErrorMessage(error) });
  }
}
async function cdpCommand(tabId, method, params = {}) {
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (error) {
    cdpErrorLog(`CDP command failed: ${method}`, { tabId, params, error: safeErrorMessage(error) });
    throw error;
  }
}
async function cdpEvaluate(tabId, expression, { returnByValue = true } = {}) {
  const response = await cdpCommand(tabId, "Runtime.evaluate", { expression, returnByValue, awaitPromise: true, userGesture: true });
  if (response?.result?.subtype === "error" || response?.exceptionDetails) throw cdpError("The ChatGPT page rejected a CDP evaluation.");
  return response?.result;
}
var CDP_COMPOSER_INPUT_STATE_EXPRESSION = `(() => {
  const inputs = [...document.querySelectorAll('input[type="file"]')]
    .filter((input) => !input.disabled);
  const input = inputs[0] || null;
  return {
    ready: document.readyState === 'complete' && Boolean(input),
    signature: input ? [inputs.length, input.accept, input.multiple, input.hidden, getComputedStyle(input).display, getComputedStyle(input).visibility].join('|') : null
  };
})()`;
async function waitForChatGPTTab(tabId, timeoutMs = 45e3) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete" && /^https:\/\/chatgpt\.com\//.test(current.url || "")) {
    cdpLog("Service tab is already loaded", { tabId, url: current.url });
    return current;
  }
  cdpLog("Waiting for service tab navigation", { tabId, status: current.status, url: current.url });
  return new Promise((resolve, reject) => {
    const finish = (callback) => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      callback();
    };
    const timeout = setTimeout(() => finish(() => reject(cdpError("The background ChatGPT service tab did not finish loading within 45 seconds."))), timeoutMs);
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      if (!/^https:\/\/chatgpt\.com\//.test(tab.url || "")) return finish(() => reject(cdpError("The service tab did not load chatgpt.com.")));
      finish(() => {
        cdpLog("Service tab loaded", { tabId, url: tab.url });
        resolve(tab);
      });
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) finish(() => reject(cdpError("The ChatGPT service tab was closed before loading.")));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}
async function storedServiceTab() {
  const { [CDP_SERVICE_TAB_STORAGE_KEY]: tabId = null } = await chrome.storage.local.get({ [CDP_SERVICE_TAB_STORAGE_KEY]: null });
  if (!Number.isInteger(tabId)) {
    cdpLog("No stored service-tab ID");
    return null;
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    const valid = /^https:\/\/chatgpt\.com\//.test(tab.url || "");
    cdpLog("Stored service-tab lookup", { tabId, valid, url: tab.url });
    return valid ? tab : null;
  } catch (_error) {
    cdpLog("Stored service tab no longer exists", { tabId });
    await chrome.storage.local.remove(CDP_SERVICE_TAB_STORAGE_KEY);
    return null;
  }
}
async function findOrCreateServiceTab() {
  const stored = await storedServiceTab();
  if (stored?.id) {
    cdpLog("Using stored service tab", { tabId: stored.id });
    return { tab: stored, created: false };
  }
  const created = await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
  if (!created?.id) throw cdpError("Chrome could not create the background ChatGPT service tab.");
  cdpLog("Created background service tab", { tabId: created.id, active: false });
  const tab = await waitForChatGPTTab(created.id);
  await chrome.storage.local.set({ [CDP_SERVICE_TAB_STORAGE_KEY]: tab.id });
  return { tab, created: true };
}
function waitForDebuggerEvent(tabId, method, timeoutMs = 15e3) {
  return new Promise((resolve, reject) => {
    const finish = (callback) => {
      clearTimeout(timeout);
      chrome.debugger.onEvent.removeListener(onEvent);
      callback();
    };
    cdpLog("Waiting for debugger event", { tabId, method, timeoutMs });
    const timeout = setTimeout(() => finish(() => reject(cdpError(`${method} was not received within ${Math.ceil(timeoutMs / 1e3)} seconds.`))), timeoutMs);
    const onEvent = (source, eventMethod, params) => {
      if (source.tabId === tabId && eventMethod === method) finish(() => {
        cdpLog("Debugger event received", { tabId, method, params });
        resolve(params);
      });
    };
    chrome.debugger.onEvent.addListener(onEvent);
  });
}
async function cdpOpenFileChooser(tabId) {
  const inputs = await cdpEvaluate(tabId, `(() => [...document.querySelectorAll('input[type="file"]')].map((input, index) => ({
    index, disabled: input.disabled, accept: input.accept, multiple: input.multiple,
    hidden: input.hidden, display: getComputedStyle(input).display, visibility: getComputedStyle(input).visibility
  })))()`);
  const inputDetails = inputs?.value || [];
  cdpLog("Composer file-input inspection", { tabId, inputs: inputDetails });
  if (!inputDetails.some((input) => !input.disabled)) throw cdpError("The ChatGPT Composer file input was not found.");
  const opened = waitForDebuggerEvent(tabId, "Page.fileChooserOpened");
  cdpLog("Opening Composer file chooser", { tabId });
  await cdpCommand(tabId, "Runtime.evaluate", {
    expression: `(() => {
      const input = [...document.querySelectorAll('input[type="file"]')].find((item) => !item.disabled);
      if (!input) throw new Error("ChatGPT Composer file input disappeared.");
      input.click();
    })()`,
    userGesture: true
  });
  cdpLog("Composer input.click() command completed", { tabId });
  return opened;
}
async function cdpWaitFor(tabId, expression, description, timeoutMs = 45e3) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  cdpLog("Waiting for page condition", { tabId, description, timeoutMs });
  while (Date.now() < deadline) {
    attempts += 1;
    const result = await cdpEvaluate(tabId, expression);
    if (result?.value === true) {
      cdpLog("Page condition satisfied", { tabId, description, attempts });
      return;
    }
    await sleep(250);
  }
  cdpLog("Page condition timed out", { tabId, description, attempts });
  throw cdpError(`Timed out waiting for ${description}.`);
}
async function cdpWaitForStableComposer(tabId, timeoutMs = 45e3) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  cdpLog("Waiting for stable ChatGPT Composer", { tabId, timeoutMs, settleMs: CDP_COMPOSER_SETTLE_MS });
  while (Date.now() < deadline) {
    attempts += 1;
    const first = (await cdpEvaluate(tabId, CDP_COMPOSER_INPUT_STATE_EXPRESSION))?.value;
    if (first?.ready && first.signature) {
      await sleep(CDP_COMPOSER_SETTLE_MS);
      const second = (await cdpEvaluate(tabId, CDP_COMPOSER_INPUT_STATE_EXPRESSION))?.value;
      if (second?.ready && second.signature === first.signature) {
        cdpLog("ChatGPT Composer is stable", { tabId, attempts, signature: second.signature });
        return;
      }
      cdpLog("ChatGPT Composer changed during settling", { tabId, attempts });
    }
    await sleep(250);
  }
  throw cdpError("Timed out waiting for a stable ChatGPT Composer.");
}
var CDP_TEXT_COMPOSER_STATE_EXPRESSION = `(() => {
  const target = document.querySelector('#prompt-textarea')
    || document.querySelector('[contenteditable="true"][role="textbox"]')
    || document.querySelector('textarea');
  if (!target) return { ready: false, signature: null };
  const style = getComputedStyle(target);
  return {
    ready: document.readyState === 'complete' && !target.disabled && style.display !== 'none' && style.visibility !== 'hidden',
    signature: [target.tagName, target.id, target.getAttribute('role'), target.getAttribute('contenteditable')].join('|')
  };
})()`;
async function cdpWaitForTextComposer(tabId, timeoutMs = 45e3) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = (await cdpEvaluate(tabId, CDP_TEXT_COMPOSER_STATE_EXPRESSION))?.value;
    if (state?.ready && state.signature) return;
    await sleep(250);
  }
  throw cdpError("Timed out waiting for the ChatGPT text Composer.");
}
async function cdpSetComposerText(tabId, text) {
  const selectComposerContentsExpression = `(() => {
    const target = document.querySelector('#prompt-textarea')
      || document.querySelector('[contenteditable="true"][role="textbox"]')
      || document.querySelector('textarea');
    if (!target) return false;
    target.focus();
    if (typeof target.select === 'function') {
      target.select();
      return document.activeElement === target;
    }
    const selection = window.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    return document.activeElement === target;
  })()`;
  const exactText = `(() => {
    const target = document.querySelector('#prompt-textarea')
      || document.querySelector('[contenteditable="true"][role="textbox"]')
      || document.querySelector('textarea');
    const current = target?.value ?? target?.innerText ?? target?.textContent ?? '';
    return current.trim() === ${JSON.stringify(text)};
  })()`;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const selected = (await cdpEvaluate(tabId, selectComposerContentsExpression))?.value;
    if (selected !== true) throw cdpError("ChatGPT Composer could not receive keyboard input.");
    await cdpCommand(tabId, "Input.insertText", { text });
    await sleep(120);
    if ((await cdpEvaluate(tabId, exactText))?.value === true) {
      cdpLog("Composer prompt replaced", { tabId, attempt });
      return;
    }
  }
  throw cdpError("ChatGPT Composer retained an older draft instead of replacing it.");
}
function canonicalYouTubeVideoUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch (_error) {
    throw cdpError("The active tab is not a valid YouTube video URL.");
  }
  if (url.origin !== "https://www.youtube.com") throw cdpError("Open one YouTube video or Short before using Describe this video.");
  const shortMatch = url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})$/);
  const videoId = url.pathname === "/watch" ? url.searchParams.get("v") || "" : shortMatch?.[1] || "";
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw cdpError("The active YouTube page does not contain a valid video ID.");
  return `https://www.youtube.com/watch?v=${videoId}`;
}
function describeYouTubeVideoTitle(value) {
  const title = String(value || "").replace(/\s+/g, " ").trim().replace(/\s*-\s*YouTube(?:\s+Shorts)?$/i, "").trim();
  return title || "YouTube video";
}
async function describeYouTubeVideoInChatGPT(sourceTab) {
  if (!Number.isInteger(sourceTab?.id)) throw cdpError("The active YouTube tab is no longer available.");
  let current = null;
  try {
    const response = await sendYouTubePageTool(sourceTab.id, { type: "youtube-ui-tool", action: "page-state" });
    if (response?.ok && response.data?.videoId) current = response.data;
  } catch (error) {
    cdpLog("Could not refresh Describe this video source", { tabId: sourceTab.id, error: safeErrorMessage(error) });
  }
  const videoUrl = canonicalYouTubeVideoUrl(current?.videoId ? `https://www.youtube.com/watch?v=${current.videoId}` : sourceTab?.url);
  const videoTitle = describeYouTubeVideoTitle(current?.title || sourceTab?.title);
  const now = Date.now();
  const previous = recentDescribeVideoRequests.get(videoUrl) || 0;
  if (now - previous < DESCRIBE_VIDEO_DUPLICATE_WINDOW_MS) {
    cdpLog("Suppressed duplicate video-description request", { videoUrl });
    return { ok: true, videoUrl, duplicateSuppressed: true };
  }
  recentDescribeVideoRequests.set(videoUrl, now);
  const prompt = `@ResearchTube ${videoTitle} ${videoUrl} Study the video and tell me what it is about in my language.`;
  const created = await chrome.tabs.create({ url: "https://chatgpt.com/", active: false, ...Number.isInteger(sourceTab?.index) ? { index: sourceTab.index + 1 } : {} });
  if (!created?.id) throw cdpError("Chrome could not open a ChatGPT tab.");
  const chatTab = await waitForChatGPTTab(created.id);
  let attached = false;
  try {
    await cdpAttach(chatTab.id);
    attached = true;
    await cdpCommand(chatTab.id, "Runtime.enable");
    await cdpWaitForTextComposer(chatTab.id);
    await cdpSetComposerText(chatTab.id, prompt);
    await cdpSendComposerText(chatTab.id, prompt);
    cdpLog("Sent video-description prompt", { tabId: chatTab.id, videoUrl });
    return { ok: true, videoUrl, chatTabId: chatTab.id };
  } catch (error) {
    recentDescribeVideoRequests.delete(videoUrl);
    throw error;
  } finally {
    if (attached) await cdpDetach(chatTab.id);
  }
}
function cdpAttachmentStateExpression(fileNames) {
  return `(() => {
    const expectedNames = ${JSON.stringify(fileNames)};
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    const selectedNames = new Set(inputs.flatMap((input) => [...(input.files || [])].map((file) => file.name)));
    // ChatGPT does not consistently render an attachment filename as visible
    // text (especially for image previews).  A selected FileList is the
    // primary, browser-level confirmation; the DOM checks are useful fallback
    // evidence after React replaces that input with a fresh one.
    const visibleText = document.body?.innerText || '';
    const labeledText = [...document.querySelectorAll('[aria-label], [title], [alt]')]
      .map((element) => [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('alt')].join(' ')).join(' ');
    const acceptedNames = expectedNames.filter((fileName) =>
      selectedNames.has(fileName) || visibleText.includes(fileName) || labeledText.includes(fileName)
    );
    return {
      accepted: acceptedNames.length === expectedNames.length,
      acceptedNames,
      selectedNames: [...selectedNames]
    };
  })()`;
}
async function cdpWaitForAttachmentAccepted(tabId, fileNames, timeoutMs = 15e3) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  cdpLog("Waiting for Composer file acceptance", { tabId, fileNames, timeoutMs });
  while (Date.now() < deadline) {
    attempts += 1;
    const state = (await cdpEvaluate(tabId, cdpAttachmentStateExpression(fileNames)))?.value;
    if (state?.accepted) {
      cdpLog("Composer accepted image attachment", { tabId, fileNames, attempts, state });
      return;
    }
    await sleep(150);
  }
  throw cdpError("ChatGPT did not confirm that it accepted the selected image file.");
}
async function cdpOpenStableFileChooser(tabId) {
  let lastError = null;
  for (let attempt = 1; attempt <= CDP_FILE_CHOOSER_ATTEMPTS; attempt += 1) {
    await cdpWaitForStableComposer(tabId);
    try {
      cdpLog("File chooser attempt", { tabId, attempt, maximumAttempts: CDP_FILE_CHOOSER_ATTEMPTS });
      return await cdpOpenFileChooser(tabId);
    } catch (error) {
      lastError = error;
      const chooserWasMissed = String(error?.message || error).includes("Page.fileChooserOpened");
      if (!chooserWasMissed || attempt === CDP_FILE_CHOOSER_ATTEMPTS) throw error;
      cdpLog("File chooser event was missed; retrying after Composer re-check", { tabId, nextAttempt: attempt + 1 });
    }
  }
  throw lastError || cdpError("The ChatGPT file chooser could not be opened.");
}
function cdpAbsoluteFilePath(value) {
  if (typeof value !== "string" || !value.trim()) throw cdpError("Enter an absolute local image-file path.");
  const filePath = value.trim();
  if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(filePath)) throw cdpError("The image-file path must be absolute, for example C:\\Pictures\\frame.png.");
  return filePath;
}
var CDP_ENABLED_SEND_BUTTON_EXPRESSION = `(() => [...document.querySelectorAll('button')]
  .some((button) => !button.disabled && button.getAttribute('aria-disabled') !== 'true' && (
    button.dataset.testid === 'send-button'
    || /^(send|send prompt)$/i.test(button.getAttribute('aria-label') || '')
  )))()`;
var CDP_SEND_BUTTON_CENTER_EXPRESSION = `(() => {
  const button = [...document.querySelectorAll('button')].find((candidate) => !candidate.disabled
    && candidate.getAttribute('aria-disabled') !== 'true' && (
      candidate.dataset.testid === 'send-button'
      || /^(send|send prompt)$/i.test(candidate.getAttribute('aria-label') || '')
    ));
  if (!button) return null;
  const bounds = button.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
})()`;
var CDP_SUBMIT_COMPOSER_FORM_EXPRESSION = `(() => {
  const composer = document.querySelector('#prompt-textarea')
    || document.querySelector('[contenteditable="true"][role="textbox"]')
    || document.querySelector('textarea');
  if (!composer) return false;
  const form = composer.closest('form');
  if (!form) return false;
  const submitButton = [...form.querySelectorAll('button')].find((candidate) => !candidate.disabled
    && candidate.getAttribute('aria-disabled') !== 'true' && (
      candidate.dataset.testid === 'send-button'
      || /^(send|send prompt)$/i.test(candidate.getAttribute('aria-label') || '')
    ));
  if (!submitButton) return false;
  form.requestSubmit(submitButton);
  return true;
})()`;
function cdpComposerDraftStateExpression(expectedText) {
  return `(() => {
    const composer = document.querySelector('#prompt-textarea')
      || document.querySelector('[contenteditable="true"][role="textbox"]')
      || document.querySelector('textarea');
    if (!composer) return "missing";
    const current = composer.value ?? composer.innerText ?? composer.textContent ?? '';
    if (current.trim() === ${JSON.stringify(expectedText)}) return "match";
    if (current.trim() === '') return "empty";
    return "changed";
  })()`;
}
var CDP_SELECT_COMPOSER_CONTENTS_EXPRESSION = `(() => {
  const composer = document.querySelector('#prompt-textarea')
    || document.querySelector('[contenteditable="true"][role="textbox"]')
    || document.querySelector('textarea');
  if (!composer) return false;
  composer.focus();
  if (typeof composer.select === 'function') return composer.select(), document.activeElement === composer;
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection.removeAllRanges();
  selection.addRange(range);
  return document.activeElement === composer;
})()`;
async function cdpClearSentComposerDraft(tabId, sentText) {
  for (let attempt = 0; attempt < CDP_SENT_DRAFT_CLEAR_CHECK_DELAYS_MS.length; attempt += 1) {
    await sleep(CDP_SENT_DRAFT_CLEAR_CHECK_DELAYS_MS[attempt]);
    try {
      const state = (await cdpEvaluate(tabId, cdpComposerDraftStateExpression(sentText)))?.value;
      if (state === "missing") return;
      if (state === "changed") {
        cdpLog("Composer draft changed by user; stopping cleanup", { tabId, attempt: attempt + 1 });
        return;
      }
      if (state === "empty") continue;
      if (state !== "match") return;
      const selected = (await cdpEvaluate(tabId, CDP_SELECT_COMPOSER_CONTENTS_EXPRESSION))?.value;
      if (selected !== true) return;
      await cdpCommand(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
      await cdpCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
      cdpLog("Cleared delayed Composer draft after submission", { tabId, attempt: attempt + 1 });
    } catch (error) {
      cdpLog("Stopped Composer draft cleanup", { tabId, attempt: attempt + 1, error: safeErrorMessage(error) });
      return;
    }
  }
}
async function cdpClickEnabledSendButton(tabId, timeoutMs = 45e3) {
  await cdpWaitFor(tabId, CDP_ENABLED_SEND_BUTTON_EXPRESSION, "the enabled ChatGPT Send button", timeoutMs);
  const target = (await cdpEvaluate(tabId, CDP_SEND_BUTTON_CENTER_EXPRESSION))?.value;
  if (!Number.isFinite(target?.x) || !Number.isFinite(target?.y)) throw cdpError("The ChatGPT Send button was not available.");
  await cdpCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y, button: "none", buttons: 0 });
  await cdpCommand(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", buttons: 1, clickCount: 1 });
  await cdpCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", buttons: 0, clickCount: 1 });
  cdpLog("Clicked ChatGPT Send button with browser input", { tabId });
}
async function cdpSendComposerText(tabId, text) {
  await cdpWaitFor(tabId, CDP_ENABLED_SEND_BUTTON_EXPRESSION, "the enabled ChatGPT Send button", 5e3);
  const submitted = (await cdpEvaluate(tabId, CDP_SUBMIT_COMPOSER_FORM_EXPRESSION))?.value;
  if (submitted !== true) throw cdpError("The ChatGPT Composer form could not be submitted.");
  cdpLog("Submitted ChatGPT Composer form", { tabId });
  await cdpClearSentComposerDraft(tabId, text);
}
async function cdpSendAttachedImages(tabId, fileCount) {
  cdpLog("Sending attached image batch without Composer text", { tabId, fileCount });
  await cdpClickEnabledSendButton(tabId, 9e4);
  cdpLog("Attached image batch sent", { tabId, fileCount });
}
async function cdpAttachImagesNow(filePathValues, { onPhase = null } = {}) {
  if (!Array.isArray(filePathValues) || !filePathValues.length || filePathValues.length > CDP_IMAGE_BATCH_MAX_FILES) {
    throw cdpError(`An image batch must contain between 1 and ${CDP_IMAGE_BATCH_MAX_FILES} files.`);
  }
  const filePaths = filePathValues.map(cdpAbsoluteFilePath);
  const fileNames = filePaths.map((filePath) => filePath.split(/[/\\\\]/).pop());
  cdpLog("Image batch attachment started", { fileCount: filePaths.length, fileNames });
  if (onPhase) await onPhase("attaching");
  const { tab } = await findOrCreateServiceTab();
  if (!tab.id) throw cdpError("The ChatGPT service tab has no tab ID.");
  let attached = false;
  try {
    await cdpAttach(tab.id);
    attached = true;
    await cdpCommand(tab.id, "Page.enable");
    await cdpCommand(tab.id, "DOM.enable");
    await cdpCommand(tab.id, "Runtime.enable");
    cdpLog("Required CDP domains enabled", { tabId: tab.id, domains: ["Page", "DOM", "Runtime"] });
    await cdpCommand(tab.id, "Page.setInterceptFileChooserDialog", { enabled: true });
    cdpLog("File-chooser interception enabled", { tabId: tab.id });
    const chooser = await cdpOpenStableFileChooser(tab.id);
    if (!Number.isInteger(chooser?.backendNodeId)) throw cdpError("ChatGPT opened a file chooser without a file-input node.");
    cdpLog("Supplying files to chooser", { tabId: tab.id, backendNodeId: chooser.backendNodeId, fileCount: filePaths.length, fileNames });
    await cdpCommand(tab.id, "DOM.setFileInputFiles", { files: filePaths, backendNodeId: chooser.backendNodeId });
    cdpLog("DOM.setFileInputFiles completed", { tabId: tab.id, backendNodeId: chooser.backendNodeId, fileCount: filePaths.length });
    await cdpWaitForAttachmentAccepted(tab.id, fileNames);
    if (onPhase) await onPhase("composerAccepted");
    if (onPhase) await onPhase("submitting");
    await cdpSendAttachedImages(tab.id, filePaths.length);
    cdpLog("Image batch completed", { tabId: tab.id, fileCount: filePaths.length });
    return { ok: true, tabId: tab.id, fileCount: filePaths.length };
  } finally {
    if (attached) await cdpCommand(tab.id, "Page.setInterceptFileChooserDialog", { enabled: false }).then(() => cdpLog("File-chooser interception disabled", { tabId: tab.id })).catch((error) => cdpErrorLog("Could not disable file-chooser interception", error));
    if (attached) await cdpDetach(tab.id);
  }
}
function libraryStoreNow() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function libraryStoreQueuePosition(taskId) {
  const index = libraryStoreQueue.indexOf(taskId);
  return index < 0 ? null : index + 1;
}
function libraryStoreTaskDocument(task) {
  return {
    taskId: task.taskId,
    status: task.status,
    phase: task.phase,
    files: task.files.map(({ workspacePath }) => ({ workspacePath })),
    queuePosition: libraryStoreQueuePosition(task.taskId),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    submittedAt: task.submittedAt,
    libraryAvailability: task.libraryAvailability,
    message: task.message,
    error: task.error
  };
}
async function persistLibraryStoreTasks() {
  await chrome.storage.local.set({
    [LIBRARY_STORE_TASK_STORAGE_KEY]: [...libraryStoreTasks.values()],
    [LIBRARY_STORE_QUEUE_STORAGE_KEY]: libraryStoreQueue
  });
}
async function ensureLibraryStoreLoaded() {
  if (libraryStoreLoaded) return;
  if (libraryStoreLoading) return libraryStoreLoading;
  libraryStoreLoading = (async () => {
    const stored = await chrome.storage.local.get({ [LIBRARY_STORE_TASK_STORAGE_KEY]: [], [LIBRARY_STORE_QUEUE_STORAGE_KEY]: [] });
    const tasks = Array.isArray(stored[LIBRARY_STORE_TASK_STORAGE_KEY]) ? stored[LIBRARY_STORE_TASK_STORAGE_KEY] : [];
    libraryStoreTasks = new Map(tasks.filter((task) => task && typeof task.taskId === "string").map((task) => [task.taskId, task]));
    libraryStoreQueue = Array.isArray(stored[LIBRARY_STORE_QUEUE_STORAGE_KEY]) ? stored[LIBRARY_STORE_QUEUE_STORAGE_KEY].filter((taskId) => typeof taskId === "string" && libraryStoreTasks.get(taskId)?.status === "queued") : [];
    for (const task of libraryStoreTasks.values()) {
      if (task.status === "working") {
        task.status = "failed";
        task.phase = "failed";
        task.updatedAt = libraryStoreNow();
        task.error = "The Extension restarted before this Library task finished its local submission.";
        task.message = task.error;
      }
    }
    libraryStoreLoaded = true;
    await persistLibraryStoreTasks();
  })().finally(() => {
    libraryStoreLoading = null;
  });
  return libraryStoreLoading;
}
async function updateLibraryStoreTask(task, phase, message, { status = "working", error = null, submittedAt = task.submittedAt } = {}) {
  task.status = status;
  task.phase = phase;
  task.message = message;
  task.error = error;
  task.submittedAt = submittedAt;
  task.updatedAt = libraryStoreNow();
  await persistLibraryStoreTasks();
}
function normalizeLibraryStoreFiles(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > CDP_IMAGE_BATCH_MAX_FILES) {
    throw localAgentError("LIBRARY_STORE_INVALID", `files must contain between 1 and ${CDP_IMAGE_BATCH_MAX_FILES} items.`);
  }
  const paths = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).length !== 1 || typeof entry.workspacePath !== "string") {
      throw localAgentError("LIBRARY_STORE_INVALID", "Each files item must contain only workspacePath.");
    }
    return normalizeWorkspacePath(entry.workspacePath, "files.workspacePath");
  });
  if (new Set(paths).size !== paths.length) throw localAgentError("LIBRARY_STORE_INVALID", "files must not repeat the same workspacePath.");
  return paths.map((workspacePath) => ({ workspacePath }));
}
async function resolveLibraryStoreFiles(files) {
  const document = await agentJsonRequest("/internal/library-store-files", { method: "POST", body: { files } });
  if (!document || typeof document !== "object" || !Array.isArray(document.files) || document.files.length !== files.length) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid Library file resolution.");
  }
  return document.files.map((entry, index) => {
    if (!entry || typeof entry !== "object" || entry.workspacePath !== files[index].workspacePath || typeof entry.localPath !== "string") {
      throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid Library file resolution.");
    }
    return entry.localPath;
  });
}
async function drainLibraryStoreQueue() {
  if (libraryStoreDraining) return;
  libraryStoreDraining = true;
  try {
    while (libraryStoreQueue.length) {
      const taskId = libraryStoreQueue.shift();
      const task = libraryStoreTasks.get(taskId);
      if (!task || task.status !== "queued") continue;
      await updateLibraryStoreTask(task, "resolvingFiles", "Resolving the workspace image batch.");
      try {
        const localPaths = await resolveLibraryStoreFiles(task.files);
        await cdpAttachImagesNow(localPaths, { onPhase: async (phase) => {
          const messages = { attaching: "Attaching the image batch to the background ChatGPT Composer.", composerAccepted: "The ChatGPT Composer accepted the image batch.", submitting: "Sending the attached image batch to ChatGPT without Composer text." };
          await updateLibraryStoreTask(task, phase, messages[phase] || "Processing the attached image batch.");
        } });
        task.libraryAvailability = "not_verified";
        await updateLibraryStoreTask(task, "submitted", "ResearchTube sent the attached image batch to ChatGPT without Composer text. Library completion cannot be verified.", {
          status: "completed",
          submittedAt: libraryStoreNow()
        });
      } catch (error) {
        await updateLibraryStoreTask(task, "failed", "ResearchTube could not submit this Library request.", { status: "failed", error: safeErrorMessage(error) });
      }
    }
  } finally {
    libraryStoreDraining = false;
  }
}
async function libraryStoreStart(filesValue) {
  await ensureLibraryStoreLoaded();
  const files = normalizeLibraryStoreFiles(filesValue);
  const createdAt = libraryStoreNow();
  const task = {
    taskId: `library_${crypto.randomUUID()}`,
    status: "queued",
    phase: "queued",
    files,
    createdAt,
    updatedAt: createdAt,
    submittedAt: null,
    libraryAvailability: "not_requested",
    message: "Queued for the dedicated ChatGPT Library service tab.",
    error: null
  };
  libraryStoreTasks.set(task.taskId, task);
  libraryStoreQueue.push(task.taskId);
  await persistLibraryStoreTasks();
  void drainLibraryStoreQueue();
  return { task: libraryStoreTaskDocument(task) };
}
async function libraryStoreStatus(taskId) {
  await ensureLibraryStoreLoaded();
  const task = libraryStoreTasks.get(taskId);
  if (!task) throw localAgentError("LIBRARY_STORE_TASK_NOT_FOUND", "The Library storage task was not found.");
  return libraryStoreTaskDocument(task);
}
async function libraryStoreCancel(taskId) {
  await ensureLibraryStoreLoaded();
  const task = libraryStoreTasks.get(taskId);
  if (!task) throw localAgentError("LIBRARY_STORE_TASK_NOT_FOUND", "The Library storage task was not found.");
  if (task.status !== "queued") return { task: libraryStoreTaskDocument(task), cancelled: false };
  libraryStoreQueue = libraryStoreQueue.filter((queuedTaskId) => queuedTaskId !== taskId);
  await updateLibraryStoreTask(task, "cancelled", "Cancelled before ChatGPT attachment began.", { status: "cancelled" });
  return { task: libraryStoreTaskDocument(task), cancelled: true };
}
chrome.runtime.onInstalled.addListener(({ reason }) => {
  void bootstrapTunnel();
  void ensureLibraryStoreLoaded().then(drainLibraryStoreQueue);
  if (reason === "install") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html"), active: true });
  }
});
chrome.runtime.onStartup.addListener(() => {
  void bootstrapTunnel();
  void ensureLibraryStoreLoaded().then(drainLibraryStoreQueue);
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
  if (message?.type === "get-mcp-tool-settings") {
    mcpToolPreferences().then(async (preferences) => sendResponse({ ok: true, preferences, tools: await mcpToolSettingsCatalog(), groups: MCP_TOOL_GROUPS })).catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }
  if (message?.type === "set-mcp-tool-enabled") {
    updateMcpToolEnabled(message.payload?.name, message.payload?.enabled).then(sendResponse).catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }
  if (message?.type === "set-mcp-new-tools-default") {
    updateNewToolsEnabledByDefault(message.payload?.enabled).then(sendResponse).catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
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
  if (message?.type === "describe-youtube-video") {
    describeYouTubeVideoInChatGPT(message.tab).then(sendResponse).catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }
  if (message?.type === "researchtube_capture_frame_local_action") {
    if (message.action !== "copyPath") {
      sendResponse({ ok: false, error: "This widget action is not available." });
      return false;
    }
    copyCaptureFramePath(message.path).then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
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
    extensionVersion: EXTENSION_VERSION,
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
    chromeAutomation: null,
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
function normalizeChromeAutomation(value) {
  if (!value || typeof value !== "object" || !["enabled", "disabled", "mixed", "unknown"].includes(value.state) || !(typeof value.chromeRunning === "boolean" || value.chromeRunning === null) || !Number.isInteger(value.browserInstances) || value.browserInstances < 0 || typeof value.message !== "string" || !value.message.trim()) return null;
  return { state: value.state, chromeRunning: value.chromeRunning, browserInstances: value.browserInstances, message: value.message.trim() };
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
    ffprobe: normalizeAgentComponent(components.ffprobe),
    cloudflared: normalizeAgentComponent(components.cloudflared)
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
      chromeAutomation: normalizeChromeAutomation(health.chromeAutomation),
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
function mcpLogStatus(value, failed = false) {
  const task = value && typeof value === "object" && value.task && typeof value.task === "object" ? value.task : null;
  const candidate = task?.phase ?? value?.phase ?? task?.status ?? value?.status;
  if (typeof candidate === "string" && /^[a-z0-9_-]{1,40}$/.test(candidate)) return candidate;
  return failed ? "error" : "completed";
}
async function reportMcpToolToAgent(tool, value, failed = false) {
  try {
    const config = await getConfig();
    const port = normalizeAgentPort(config.agentPort);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      await fetch(`http://127.0.0.1:${port}/mcp/log/${tool}`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ status: mcpLogStatus(value, failed) }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (_error) {
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
function normalizeFormatSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw localAgentError("FORMAT_SELECTION_INVALID", "formatSelection is required.");
  }
  const allowed = /* @__PURE__ */ new Set(["combined", "video", "audio"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw localAgentError("FORMAT_SELECTION_INVALID", "formatSelection contains an unsupported field.");
  }
  const selection = {};
  for (const key of allowed) {
    if (!(key in value) || value[key] === null) continue;
    if (typeof value[key] !== "string" || !/^(?:best|[0-9]+)$/.test(value[key])) {
      throw localAgentError("FORMAT_SELECTION_INVALID", `formatSelection.${key} must be 'best' or a numeric formatId.`);
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
  const formatSelection = normalizeFormatSelection(args.formatSelection);
  const startSeconds = args.startSeconds;
  const endSeconds = args.endSeconds;
  if (startSeconds === void 0 !== (endSeconds === void 0)) throw localAgentError("DOWNLOAD_RANGE_INVALID", "startSeconds and endSeconds must be supplied together.");
  if (startSeconds !== void 0 && (!Number.isFinite(startSeconds) || startSeconds < 0)) throw localAgentError("DOWNLOAD_RANGE_INVALID", "startSeconds must be a finite non-negative number.");
  if (endSeconds !== void 0 && (!Number.isFinite(endSeconds) || endSeconds < 0 || endSeconds <= startSeconds)) throw localAgentError("DOWNLOAD_RANGE_INVALID", "endSeconds must be a finite number greater than startSeconds.");
  const outputDir = args.outputDir;
  if (outputDir !== void 0 && (typeof outputDir !== "string" || !outputDir.trim())) {
    throw localAgentError("OUTPUT_DIR_INVALID", "outputDir must be a non-empty workspace-relative directory string.");
  }
  return publicDownloadStartTask(normalizeAgentTask(await agentJsonRequest("/tasks/youtube-download", { method: "POST", body: { videoId, formatSelection, ...startSeconds === void 0 ? {} : { startSeconds, endSeconds }, ...outputDir === void 0 ? {} : { outputDir: outputDir.trim() } } })));
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
  return { taskId, accepted: true, message: "Cancellation request accepted. Poll youtube_download_get_task for the terminal status." };
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
function normalizeMediaInspectImage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !(/* @__PURE__ */ new Set(["png", "jpeg", "webp"])).has(value.format) || !(/* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp"])).has(value.mimeType) || !Number.isInteger(value.width) || value.width < 1 || !Number.isInteger(value.height) || value.height < 1 || !Number.isInteger(value.imageSizeBytes) || value.imageSizeBytes < 0) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid image metadata.");
  }
  const expectedMimeType = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[value.format];
  if (value.mimeType !== expectedMimeType) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned inconsistent image metadata.");
  return { workspacePath: normalizeWorkspacePath(value.workspacePath, "workspacePath"), format: value.format, mimeType: value.mimeType, width: value.width, height: value.height, imageSizeBytes: value.imageSizeBytes };
}
async function mediaInspectImage(path) {
  const document = await agentJsonRequest("/media/inspect-image", { method: "POST", body: { path: normalizeWorkspacePath(path, "path") } });
  return normalizeMediaInspectImage(document);
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
var workspaceShareFileTypes = /* @__PURE__ */ new Set(["images", "audio", "video", "documents", "archives", "other", "all"]);
function normalizeWorkspaceShareFileTypes(value) {
  if (!Array.isArray(value) || !value.length || value.length > workspaceShareFileTypes.size || new Set(value).size !== value.length || value.some((item) => typeof item !== "string" || !workspaceShareFileTypes.has(item)) || value.includes("all") && value.length !== 1) {
    throw localAgentError("ONLINE_SHARE_INVALID", "fileTypes must be a non-empty array of unique supported categories; all cannot be combined with another category.");
  }
  return value;
}
function normalizeWorkspaceShareStatus(document) {
  if (!document || typeof document !== "object" || Array.isArray(document) || !["active", "inactive"].includes(document.state) || !Array.isArray(document.fileTypes) || !Array.isArray(document.methods) || !document.externalProbe || typeof document.externalProbe !== "object") {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid workspace sharing status.");
  }
  const active = document.state === "active";
  const fileTypes = active ? normalizeWorkspaceShareFileTypes(document.fileTypes) : document.fileTypes;
  if (!active && fileTypes.length) throw localAgentError("AGENT_INVALID_RESPONSE", "An inactive workspace share must not have file types.");
  if (document.folder !== null && typeof document.folder !== "string") throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid shared folder.");
  const folder = document.folder === null ? null : normalizeWorkspacePath(document.folder, "folder", { allowRoot: true });
  if (document.file !== null && typeof document.file !== "string") throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid shared file.");
  const file = document.file === null ? null : normalizeWorkspacePath(document.file, "file");
  if (document.publicBaseUrl !== null && (typeof document.publicBaseUrl !== "string" || !/^https:\/\//.test(document.publicBaseUrl))) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid public workspace URL.");
  if (document.publicFileUrl !== null && (typeof document.publicFileUrl !== "string" || !/^https:\/\//.test(document.publicFileUrl))) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid public workspace file URL.");
  if (document.methods.some((method) => method !== "GET" && method !== "HEAD")) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid public workspace methods.");
  const folderShare = folder !== null && file === null && document.publicBaseUrl !== null && document.publicFileUrl === null && fileTypes.length > 0;
  const fileShare = folder === null && file !== null && document.publicBaseUrl === null && document.publicFileUrl !== null && fileTypes.length === 0;
  if (active !== ((folderShare || fileShare) && document.methods.length === 2)) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an inconsistent workspace sharing status.");
  const probe = document.externalProbe;
  if (!["not_requested", "passed", "failed"].includes(probe.state) || probe.provider !== "wsrv.nl" || probe.probePath !== null && typeof probe.probePath !== "string" || probe.httpStatus !== null && (!Number.isInteger(probe.httpStatus) || probe.httpStatus < 100 || probe.httpStatus > 599) || probe.contentType !== null && typeof probe.contentType !== "string") throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid external sharing probe.");
  if (![true, false, null].includes(document.externallyReachable) || document.externallyReachable === true !== (probe.state === "passed") || document.externallyReachable === false !== (probe.state === "failed")) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an inconsistent external sharing probe.");
  return { state: document.state, folder, file, fileTypes, publicBaseUrl: document.publicBaseUrl, publicFileUrl: document.publicFileUrl, methods: document.methods, externallyReachable: document.externallyReachable, externalProbe: { state: probe.state, provider: probe.provider, probePath: probe.probePath === null ? null : normalizeWorkspacePath(probe.probePath, "externalProbe.probePath"), httpStatus: probe.httpStatus, contentType: probe.contentType } };
}
async function workspaceShareStart(args) {
  const hasFolder = Object.hasOwn(args, "folder"), hasFile = Object.hasOwn(args, "file");
  if (hasFolder === hasFile) throw localAgentError("ONLINE_SHARE_INVALID", "Specify exactly one of folder or file.");
  const verifyExternal = args.verifyExternal === void 0 ? false : args.verifyExternal;
  if (typeof verifyExternal !== "boolean") throw localAgentError("ONLINE_SHARE_INVALID", "verifyExternal must be a boolean.");
  const input = hasFolder ? { folder: normalizeWorkspacePath(args.folder, "folder", { allowRoot: true }), fileTypes: normalizeWorkspaceShareFileTypes(args.fileTypes), verifyExternal } : { file: normalizeWorkspacePath(args.file, "file"), verifyExternal };
  if (hasFolder && verifyExternal) input.probePath = normalizeWorkspacePath(args.probePath, "probePath");
  return normalizeWorkspaceShareStatus(await agentJsonRequest("/workspace/share/start", { method: "POST", body: input, timeoutMs: 2e4 }));
}
async function workspaceShareStatus(verifyExternal = false) {
  if (typeof verifyExternal !== "boolean") throw localAgentError("ONLINE_SHARE_INVALID", "verifyExternal must be a boolean.");
  return normalizeWorkspaceShareStatus(await agentJsonRequest("/workspace/share/status", { method: "POST", body: { verifyExternal }, timeoutMs: verifyExternal ? 3e4 : 1e4 }));
}
async function workspaceShareStop() {
  const document = await agentJsonRequest("/workspace/share/stop", { method: "POST", body: {} });
  if (!document || typeof document !== "object" || document.state !== "stopped" || typeof document.stopped !== "boolean") throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid workspace sharing stop result.");
  return { state: "stopped", stopped: document.stopped };
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
  const args = captureFrameObject(argumentsValue, "media_capture_frame", /* @__PURE__ */ new Set(["path", "youtube", "timestampSeconds", "videoStreamIndex", "seekMode", "applyDisplayRotation", "crop", "resize", "image", "outputPath", "showInChat"]));
  if (args.path === void 0 === (args.youtube === void 0)) throw localAgentError("CAPTURE_FRAME_INVALID", "media_capture_frame requires exactly one source: path or youtube.");
  const path = args.path === void 0 ? void 0 : normalizeWorkspacePath(args.path, "path");
  let youtube;
  if (args.youtube !== void 0) {
    const value = captureFrameObject(args.youtube, "youtube", /* @__PURE__ */ new Set(["videoId", "formatId"]));
    if (!Object.hasOwn(value, "videoId") || !Object.hasOwn(value, "formatId") || Object.keys(value).length !== 2) throw localAgentError("CAPTURE_FRAME_INVALID", "youtube requires videoId and formatId.");
    const videoId = requireVideoId({ videoId: value.videoId });
    if (typeof value.formatId !== "string" || !/^[0-9]+$/.test(value.formatId)) throw localAgentError("CAPTURE_FRAME_INVALID", "youtube.formatId must be a numeric ID returned by youtube_download_get_formats.");
    youtube = { videoId, formatId: value.formatId };
  }
  const timestampSeconds = captureFrameFiniteNumber(args.timestampSeconds, "timestampSeconds", { minimum: 0 });
  const videoStreamIndex = args.videoStreamIndex === void 0 ? void 0 : captureFrameInteger(args.videoStreamIndex, "videoStreamIndex");
  const seekMode = args.seekMode === void 0 ? "accurate" : args.seekMode;
  if (seekMode !== "accurate" && seekMode !== "fast") throw localAgentError("CAPTURE_FRAME_INVALID", "seekMode must be accurate or fast.");
  const applyDisplayRotation = args.applyDisplayRotation === void 0 ? true : args.applyDisplayRotation;
  if (typeof applyDisplayRotation !== "boolean") throw localAgentError("CAPTURE_FRAME_INVALID", "applyDisplayRotation must be a boolean.");
  const showInChat = args.showInChat === void 0 ? false : args.showInChat;
  if (typeof showInChat !== "boolean") throw localAgentError("CAPTURE_FRAME_INVALID", "showInChat must be a boolean.");
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
  const outputPath = args.outputPath === void 0 ? void 0 : normalizeWorkspacePath(args.outputPath, "outputPath");
  if (youtube && videoStreamIndex !== void 0) throw localAgentError("CAPTURE_FRAME_INVALID", "videoStreamIndex is available only with a workspace path source.");
  return {
    ...path === void 0 ? {} : { path },
    ...youtube === void 0 ? {} : { youtube },
    timestampSeconds,
    ...videoStreamIndex === void 0 ? {} : { videoStreamIndex },
    seekMode,
    applyDisplayRotation,
    ...crop === void 0 ? {} : { crop },
    ...resize === void 0 ? {} : { resize },
    image: { format: imageFormat, ...quality === void 0 ? {} : { quality }, ...compressionLevel === void 0 ? {} : { compressionLevel } },
    ...outputPath === void 0 ? {} : { outputPath },
    showInChat
  };
}
function normalizeCaptureFrameResult(document, input) {
  const expectedSource = input.path ?? `youtube:${input.youtube.videoId}`;
  if (!document || typeof document !== "object" || Array.isArray(document) || document.sourcePath !== expectedSource || document.seekMode !== input.seekMode || document.displayRotationApplied !== true && document.displayRotationApplied !== false) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid captured-frame result.");
  }
  const requestedTimestampSeconds = captureFrameFiniteNumber(document.requestedTimestampSeconds, "requestedTimestampSeconds", { minimum: 0 });
  if (requestedTimestampSeconds !== input.timestampSeconds) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an unexpected captured-frame timestamp.");
  const actualTimestampSeconds = document.actualTimestampSeconds === null ? null : captureFrameFiniteNumber(document.actualTimestampSeconds, "actualTimestampSeconds", { minimum: 0 });
  const selectedVideoStreamIndex = captureFrameInteger(document.selectedVideoStreamIndex, "selectedVideoStreamIndex");
  const image = document.image;
  if (!image || typeof image !== "object" || Array.isArray(image) || !(/* @__PURE__ */ new Set(["png", "jpeg", "webp"])).has(image.format) || !(/* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp"])).has(image.mimeType) || !Number.isInteger(image.width) || image.width < 1 || !Number.isInteger(image.height) || image.height < 1 || !Number.isInteger(image.imageSizeBytes) || image.imageSizeBytes < 0) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid captured-image metadata.");
  }
  const expectedMimeType = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[image.format];
  if (image.mimeType !== expectedMimeType) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an inconsistent captured-image MIME type.");
  if (typeof image.workspacePath !== "string" || Object.hasOwn(document, "inlineImageBase64") || Object.hasOwn(image, "publicUrl")) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid workspace image result.");
  }
  const remote = input.youtube === void 0 ? {} : {
    sourceVideoId: document.sourceVideoId,
    sourceVideoFormatId: document.sourceVideoFormatId,
    sourceTitle: document.sourceTitle,
    partialDownload: document.partialDownload
  };
  if (input.youtube !== void 0 && (document.sourceVideoId !== input.youtube.videoId || document.sourceVideoFormatId !== input.youtube.formatId || typeof document.sourceTitle !== "string" || !document.sourceTitle || !document.partialDownload || typeof document.partialDownload !== "object" || !Number.isFinite(document.partialDownload.startSeconds) || !Number.isFinite(document.partialDownload.endSeconds))) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid partial YouTube capture metadata.");
  }
  return {
    metadata: {
      sourcePath: document.sourcePath,
      requestedTimestampSeconds,
      actualTimestampSeconds,
      selectedVideoStreamIndex,
      seekMode: input.seekMode,
      displayRotationApplied: document.displayRotationApplied,
      showInChat: input.showInChat,
      ...remote,
      image: {
        format: image.format,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        imageSizeBytes: image.imageSizeBytes,
        workspacePath: normalizeWorkspacePath(image.workspacePath, "image.workspacePath")
      }
    }
  };
}
async function captureFrame(argumentsValue) {
  const input = normalizeCaptureFrameInput(argumentsValue);
  const { showInChat: _showInChat, ...agentInput } = input;
  const document = await agentJsonRequest("/media/capture-frame", { method: "POST", body: agentInput, timeoutMs: AGENT_CAPTURE_FRAME_TIMEOUT_MS });
  return normalizeCaptureFrameResult(document, input);
}
function normalizeVisualMapInput(argumentsValue = {}) {
  const args = captureFrameObject(argumentsValue, "media_visual_map_create", /* @__PURE__ */ new Set(["workspacePath", "columns", "rows", "maxTotalFrames", "selection", "sceneDetectThreshold", "startSeconds", "endSeconds", "maxMapDimension", "frameTimestampPosition"]));
  const workspacePath = normalizeWorkspacePath(args.workspacePath, "workspacePath");
  const columns = captureFrameInteger(args.columns, "columns", 1);
  const rows = captureFrameInteger(args.rows, "rows", 1);
  const maxTotalFrames = captureFrameInteger(args.maxTotalFrames, "maxTotalFrames", 1);
  if (maxTotalFrames > 120) throw localAgentError("VISUAL_MAP_INVALID", "maxTotalFrames must not exceed 120.");
  const selection = args.selection === void 0 ? "uniform" : args.selection;
  if (!(/* @__PURE__ */ new Set(["uniform", "sceneDetect", "hybrid"])).has(selection)) throw localAgentError("VISUAL_MAP_INVALID", "selection must be uniform, sceneDetect, or hybrid.");
  if (!(/* @__PURE__ */ new Set(["sceneDetect", "hybrid"])).has(selection) && args.sceneDetectThreshold !== void 0) throw localAgentError("VISUAL_MAP_INVALID", "sceneDetectThreshold is available only when selection is sceneDetect or hybrid.");
  const sceneDetectThreshold = (/* @__PURE__ */ new Set(["sceneDetect", "hybrid"])).has(selection) ? args.sceneDetectThreshold === void 0 ? 10 : args.sceneDetectThreshold : null;
  if ((/* @__PURE__ */ new Set(["sceneDetect", "hybrid"])).has(selection) && (typeof sceneDetectThreshold !== "number" || !Number.isFinite(sceneDetectThreshold) || sceneDetectThreshold < 0 || sceneDetectThreshold > 100)) {
    throw localAgentError("VISUAL_MAP_INVALID", "sceneDetectThreshold must be a finite number from 0 to 100.");
  }
  const startSeconds = args.startSeconds === void 0 ? 0 : captureFrameFiniteNumber(args.startSeconds, "startSeconds", { minimum: 0 });
  const endSeconds = args.endSeconds === void 0 ? void 0 : captureFrameFiniteNumber(args.endSeconds, "endSeconds", { minimum: 0 });
  if (endSeconds !== void 0 && startSeconds >= endSeconds) throw localAgentError("VISUAL_MAP_INVALID", "startSeconds must be less than endSeconds.");
  const maxMapDimension = args.maxMapDimension === void 0 ? 4096 : captureFrameInteger(args.maxMapDimension, "maxMapDimension", 1);
  const frameTimestampPosition = args.frameTimestampPosition === void 0 ? "bottomRight" : args.frameTimestampPosition;
  if (!(/* @__PURE__ */ new Set(["none", "topLeft", "topRight", "bottomLeft", "bottomRight"])).has(frameTimestampPosition)) throw localAgentError("VISUAL_MAP_INVALID", "frameTimestampPosition is invalid.");
  return { workspacePath, columns, rows, maxTotalFrames, selection, ...sceneDetectThreshold === null ? {} : { sceneDetectThreshold }, startSeconds, ...endSeconds === void 0 ? {} : { endSeconds }, maxMapDimension, frameTimestampPosition };
}
function normalizeVisualMapResult(document, input) {
  if (!document || typeof document !== "object" || Array.isArray(document) || typeof document.sourcePath !== "string" || !document.sourcePath || !(/* @__PURE__ */ new Set(["uniform", "sceneDetect", "hybrid"])).has(document.selection) || !(document.sceneDetectThreshold === null || Number.isFinite(document.sceneDetectThreshold) && document.sceneDetectThreshold >= 0 && document.sceneDetectThreshold <= 100) || document.selection === "uniform" && document.sceneDetectThreshold !== null || (/* @__PURE__ */ new Set(["sceneDetect", "hybrid"])).has(document.selection) && document.sceneDetectThreshold === null || !document.range || !Number.isFinite(document.range.startSeconds) || !Number.isFinite(document.range.endSeconds) || !Number.isInteger(document.columns) || document.columns < 1 || !Number.isInteger(document.rows) || document.rows < 1 || document.mapCapacity !== document.columns * document.rows || !Number.isInteger(document.maxTotalFrames) || document.maxTotalFrames < 1 || !Number.isInteger(document.actualTotalFrames) || document.actualTotalFrames < 1 || document.actualTotalFrames > document.maxTotalFrames || document.selection === "hybrid" && document.actualTotalFrames !== document.maxTotalFrames || !Array.isArray(document.maps) || !document.maps.length) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid visual-map result.");
  }
  if (input && (document.sourcePath !== input.workspacePath || document.selection !== input.selection || document.sceneDetectThreshold !== (input.sceneDetectThreshold ?? null) || document.range.startSeconds !== input.startSeconds || document.columns !== input.columns || document.rows !== input.rows || document.maxTotalFrames !== input.maxTotalFrames || document.actualTotalFrames > input.maxTotalFrames)) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned a visual-map result that does not match the requested task.");
  }
  let count = 0;
  const maps = document.maps.map((map) => {
    if (!map || typeof map !== "object" || typeof map.workspacePath !== "string" || !Number.isInteger(map.frameCount) || map.frameCount < 1 || !Array.isArray(map.timestampsSeconds) || map.frameCount !== map.timestampsSeconds.length || map.timestampsSeconds.some((value) => !Number.isFinite(value) || value < 0)) {
      throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid visual-map entries.");
    }
    count += map.frameCount;
    return { workspacePath: normalizeWorkspacePath(map.workspacePath, "maps.workspacePath"), frameCount: map.frameCount, timestampsSeconds: map.timestampsSeconds };
  });
  if (count !== document.actualTotalFrames) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned inconsistent visual-map frame counts.");
  return { sourcePath: document.sourcePath, selection: document.selection, sceneDetectThreshold: document.sceneDetectThreshold, range: { startSeconds: document.range.startSeconds, endSeconds: document.range.endSeconds }, columns: document.columns, rows: document.rows, mapCapacity: document.mapCapacity, maxTotalFrames: document.maxTotalFrames, actualTotalFrames: count, maps };
}
function normalizeVisualMapTask(document, input = null) {
  if (!document || typeof document !== "object" || Array.isArray(document) || typeof document.taskId !== "string" || !document.taskId || !(/* @__PURE__ */ new Set(["working", "completed", "failed", "cancelled"])).has(document.status) || typeof document.statusMessage !== "string" || !(/* @__PURE__ */ new Set(["preparing", "detectingScenes", "extractingFrames", "assemblingMaps", "completed", "failed", "cancelled"])).has(document.phase) || !Number.isFinite(document.progressPercent) || document.progressPercent < 0 || document.progressPercent > 100 || !["completedFrames", "totalFrames", "completedMaps", "totalMaps", "pollIntervalMs"].every((key) => Number.isInteger(document[key]) && document[key] >= 0) || typeof document.createdAt !== "string" || typeof document.lastUpdatedAt !== "string" || document.pollIntervalMs < 100) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid visual-map task.");
  }
  if (document.status === "completed" && (!document.result || document.error)) throw localAgentError("AGENT_INVALID_RESPONSE", "A completed visual-map task must contain only its result.");
  if (document.status === "failed" && (!document.error || document.result || typeof document.error.code !== "string" || typeof document.error.message !== "string")) throw localAgentError("AGENT_INVALID_RESPONSE", "A failed visual-map task must contain only its error.");
  const task = { taskId: document.taskId, status: document.status, statusMessage: document.statusMessage, phase: document.phase, progressPercent: document.progressPercent, completedFrames: document.completedFrames, totalFrames: document.totalFrames, completedMaps: document.completedMaps, totalMaps: document.totalMaps, createdAt: document.createdAt, lastUpdatedAt: document.lastUpdatedAt, pollIntervalMs: document.pollIntervalMs };
  if (document.result) task.result = normalizeVisualMapResult(document.result, input);
  if (document.error) task.error = { code: document.error.code, message: document.error.message };
  return task;
}
async function createVisualMap(argumentsValue) {
  const input = normalizeVisualMapInput(argumentsValue);
  const document = await agentJsonRequest("/tasks/visual-map", { method: "POST", body: input, timeoutMs: AGENT_TASK_TIMEOUT_MS });
  return normalizeVisualMapTask(document, input);
}
async function getVisualMapTask(taskId) {
  if (typeof taskId !== "string" || !taskId.trim()) throw localAgentError("INVALID_ARGUMENT", "taskId must be a non-empty string.");
  const document = await agentJsonRequest(`/tasks/visual-map/${encodeURIComponent(taskId)}`, { timeoutMs: AGENT_TASK_TIMEOUT_MS });
  return normalizeVisualMapTask(document);
}
async function cancelVisualMapTask(taskId) {
  if (typeof taskId !== "string" || !taskId.trim()) throw localAgentError("INVALID_ARGUMENT", "taskId must be a non-empty string.");
  const document = await agentJsonRequest(`/tasks/visual-map/${encodeURIComponent(taskId)}/cancel`, { method: "POST", body: {}, timeoutMs: AGENT_TASK_TIMEOUT_MS });
  if (!document || typeof document !== "object" || document.accepted !== true) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent did not confirm visual-map cancellation.");
  }
  return { taskId, accepted: true, message: "Cancellation request accepted. Poll media_visual_map_get_task for the terminal status." };
}
function normalizeCameraMode(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isInteger(value.width) || value.width < 1 || !Number.isInteger(value.height) || value.height < 1 || value.fps !== void 0 && (!Number.isFinite(value.fps) || value.fps <= 0)) {
    throw localAgentError("AGENT_INVALID_RESPONSE", `The Local Agent returned invalid ${field}.`);
  }
  return { width: value.width, height: value.height, ...value.fps === void 0 ? {} : { fps: value.fps } };
}
function normalizeCameraList(document) {
  if (!document || typeof document !== "object" || Array.isArray(document) || !Array.isArray(document.cameras)) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid camera list.");
  return { cameras: document.cameras.map((camera) => {
    if (!camera || typeof camera !== "object" || Array.isArray(camera) || typeof camera.cameraId !== "string" || !camera.cameraId || typeof camera.name !== "string" || !camera.name || typeof camera.audioAvailable !== "boolean" || !camera.videoModes || typeof camera.videoModes !== "object" || Array.isArray(camera.videoModes)) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid camera metadata.");
    const keys = Object.keys(camera.videoModes);
    if (!keys.length || keys.some((key) => !["30", "60"].includes(key))) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid camera video modes.");
    const videoModes = Object.fromEntries(keys.map((key) => [key, normalizeCameraMode(camera.videoModes[key], `camera videoModes.${key}`)]));
    if (Object.entries(videoModes).some(([key, mode]) => !Number.isFinite(mode.fps) || Math.abs(mode.fps - Number(key)) > 1)) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned inconsistent camera video modes.");
    return { cameraId: camera.cameraId, name: camera.name, audioAvailable: camera.audioAvailable, videoModes };
  }) };
}
async function cameraList() {
  return normalizeCameraList(await agentJsonRequest("/media/camera/list", { method: "POST", body: {} }));
}
function normalizeCameraCaptureInput(argumentsValue = {}) {
  const args = captureFrameObject(argumentsValue, "media_camera_capture_frame", /* @__PURE__ */ new Set(["cameraId", "targetPath", "targetFormat"]));
  if (typeof args.cameraId !== "string" || !args.cameraId.trim()) throw localAgentError("CAMERA_CAPTURE_INVALID", "cameraId must be a non-empty string.");
  const targetFormat = args.targetFormat === void 0 ? "png" : args.targetFormat;
  if (!(/* @__PURE__ */ new Set(["png", "jpeg", "webp"])).has(targetFormat)) throw localAgentError("CAMERA_CAPTURE_INVALID", "targetFormat must be png, jpeg, or webp.");
  return { cameraId: args.cameraId, ...args.targetPath === void 0 ? {} : { targetPath: normalizeWorkspacePath(args.targetPath, "targetPath") }, targetFormat };
}
function normalizeCameraFrame(document, input) {
  if (!document || typeof document !== "object" || Array.isArray(document) || document.cameraId !== input.cameraId || typeof document.workspacePath !== "string" || !(/* @__PURE__ */ new Set(["png", "jpeg", "webp"])).has(document.format) || !(/* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp"])).has(document.mimeType) || !Number.isInteger(document.width) || document.width < 1 || !Number.isInteger(document.height) || document.height < 1 || !Number.isInteger(document.imageSizeBytes) || document.imageSizeBytes < 0) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid camera frame.");
  return { cameraId: document.cameraId, workspacePath: normalizeWorkspacePath(document.workspacePath, "workspacePath"), format: document.format, mimeType: document.mimeType, width: document.width, height: document.height, imageSizeBytes: document.imageSizeBytes };
}
async function cameraCaptureFrame(argumentsValue) {
  const input = normalizeCameraCaptureInput(argumentsValue);
  return normalizeCameraFrame(await agentJsonRequest("/media/camera/capture-frame", { method: "POST", body: input, timeoutMs: AGENT_CAPTURE_FRAME_TIMEOUT_MS }), input);
}
function cameraTaskId(taskId) {
  if (typeof taskId !== "string" || !taskId.trim()) throw localAgentError("INVALID_ARGUMENT", "taskId must be a non-empty string.");
  return taskId;
}
function normalizeCameraRecordInput(argumentsValue = {}) {
  const args = captureFrameObject(argumentsValue, "media_camera_record_video", /* @__PURE__ */ new Set(["cameraId", "durationSeconds", "targetFps"]));
  if (typeof args.cameraId !== "string" || !args.cameraId.trim() || !Number.isInteger(args.durationSeconds) || args.durationSeconds < 1 || args.durationSeconds > 60) throw localAgentError("CAMERA_RECORD_INVALID", "cameraId and durationSeconds from 1 to 60 are required.");
  if (![30, 60].includes(args.targetFps)) throw localAgentError("CAMERA_RECORD_INVALID", "targetFps must be 30 or 60.");
  return { cameraId: args.cameraId, durationSeconds: args.durationSeconds, targetFps: args.targetFps };
}
function normalizeCameraAudioRecordInput(argumentsValue = {}) {
  const args = captureFrameObject(argumentsValue, "media_camera_record_audio", /* @__PURE__ */ new Set(["cameraId", "durationSeconds"]));
  if (typeof args.cameraId !== "string" || !args.cameraId.trim() || !Number.isInteger(args.durationSeconds) || args.durationSeconds < 1 || args.durationSeconds > 600) throw localAgentError("CAMERA_RECORD_INVALID", "cameraId and durationSeconds from 1 to 600 are required.");
  return { cameraId: args.cameraId, durationSeconds: args.durationSeconds };
}
function normalizeCameraRecordTask(document, input = null) {
  if (!document || typeof document !== "object" || Array.isArray(document) || typeof document.taskId !== "string" || !document.taskId || !["video", "audio"].includes(document.recordingType) || !(/* @__PURE__ */ new Set(["working", "completed", "failed"])).has(document.status) || !(/* @__PURE__ */ new Set(["starting", "recording", "finalizing", "completed", "failed"])).has(document.phase) || typeof document.statusMessage !== "string" || !Number.isFinite(document.progressPercent) || document.progressPercent < 0 || document.progressPercent > 100 || !Number.isFinite(document.elapsedSeconds) || document.elapsedSeconds < 0 || !Number.isInteger(document.requestedDurationSeconds) || document.requestedDurationSeconds < 1 || document.requestedDurationSeconds > (document.recordingType === "video" ? 60 : 600) || document.recordingType === "video" && ![30, 60].includes(document.targetFps) || document.recordingType === "audio" && document.targetFps !== null || document.maxDurationSeconds !== (document.recordingType === "video" ? 60 : 600) || typeof document.createdAt !== "string" || typeof document.lastUpdatedAt !== "string" || !Number.isInteger(document.pollIntervalMs) || document.pollIntervalMs < 100) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid camera recording task.");
  if (input && document.recordingType !== input.recordingType) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an unexpected camera task type.");
  if (input && document.requestedDurationSeconds !== input.durationSeconds) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned a camera task that does not match the requested duration.");
  if (input?.recordingType === "video" && document.targetFps !== input.targetFps) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned a camera task that does not match the requested targetFps.");
  const task = { taskId: document.taskId, recordingType: document.recordingType, status: document.status, phase: document.phase, statusMessage: document.statusMessage, progressPercent: document.progressPercent, elapsedSeconds: document.elapsedSeconds, requestedDurationSeconds: document.requestedDurationSeconds, targetFps: document.targetFps, maxDurationSeconds: document.maxDurationSeconds, createdAt: document.createdAt, lastUpdatedAt: document.lastUpdatedAt, pollIntervalMs: document.pollIntervalMs };
  if (document.result) {
    const result = document.result;
    if (!result || typeof result !== "object" || input && result.cameraId !== input.cameraId || typeof result.cameraId !== "string" || typeof result.filePath !== "string" || !Number.isFinite(result.durationSeconds) || result.durationSeconds < 0 || result.stoppedEarly !== void 0 && typeof result.stoppedEarly !== "boolean") throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid camera recording result.");
    if (document.recordingType === "video") {
      if (result.format !== "mp4" || result.mimeType !== "video/mp4" || result.audioIncluded !== true || !Number.isInteger(result.width) || result.width < 1 || !Number.isInteger(result.height) || result.height < 1 || !Number.isFinite(result.fps) || result.fps <= 0) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid camera video result.");
      task.result = { cameraId: result.cameraId, filePath: normalizeWorkspacePath(result.filePath, "result.filePath"), format: "mp4", mimeType: "video/mp4", width: result.width, height: result.height, fps: result.fps, audioIncluded: true, durationSeconds: result.durationSeconds, ...result.stoppedEarly === void 0 ? {} : { stoppedEarly: result.stoppedEarly } };
    } else {
      if (result.format !== "m4a" || result.mimeType !== "audio/mp4") throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid camera audio result.");
      task.result = { cameraId: result.cameraId, filePath: normalizeWorkspacePath(result.filePath, "result.filePath"), format: "m4a", mimeType: "audio/mp4", durationSeconds: result.durationSeconds, ...result.stoppedEarly === void 0 ? {} : { stoppedEarly: result.stoppedEarly } };
    }
  }
  if (document.error) {
    if (!document.error || typeof document.error.code !== "string" || typeof document.error.message !== "string") throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid camera recording error.");
    task.error = { code: document.error.code, message: document.error.message };
  }
  if (task.status === "completed" !== Boolean(task.result) || task.status === "failed" !== Boolean(task.error)) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an inconsistent camera recording task.");
  return task;
}
async function cameraRecordVideo(argumentsValue) {
  const input = { ...normalizeCameraRecordInput(argumentsValue), recordingType: "video" };
  const { recordingType: _recordingType, ...agentInput } = input;
  return normalizeCameraRecordTask(await agentJsonRequest("/tasks/camera-record", { method: "POST", body: agentInput, timeoutMs: AGENT_TASK_TIMEOUT_MS }), input);
}
async function cameraRecordAudio(argumentsValue) {
  const input = { ...normalizeCameraAudioRecordInput(argumentsValue), recordingType: "audio" };
  return normalizeCameraRecordTask(await agentJsonRequest("/tasks/camera-audio", { method: "POST", body: { cameraId: input.cameraId, durationSeconds: input.durationSeconds }, timeoutMs: AGENT_TASK_TIMEOUT_MS }), input);
}
async function cameraRecordStatus(taskId) {
  taskId = cameraTaskId(taskId);
  return normalizeCameraRecordTask(await agentJsonRequest(`/tasks/camera-record/${encodeURIComponent(taskId)}`, { timeoutMs: AGENT_TASK_TIMEOUT_MS }));
}
async function cameraRecordStop(taskId) {
  taskId = cameraTaskId(taskId);
  const document = await agentJsonRequest(`/tasks/camera-record/${encodeURIComponent(taskId)}/stop`, { method: "POST", body: {}, timeoutMs: AGENT_TASK_TIMEOUT_MS });
  if (!document || typeof document !== "object" || document.taskId !== taskId || typeof document.accepted !== "boolean" || typeof document.message !== "string") throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent did not confirm the camera recording stop request.");
  return document;
}
function normalizeScreenCaptureInput(argumentsValue = {}) {
  const args = captureFrameObject(argumentsValue, "media_capture_screen", /* @__PURE__ */ new Set(["outputPath", "image", "showInChat"]));
  const imageValue = captureFrameObject(args.image, "image", /* @__PURE__ */ new Set(["format", "quality"]));
  const format = imageValue.format === void 0 ? "png" : imageValue.format;
  if (!(/* @__PURE__ */ new Set(["png", "jpeg", "webp"])).has(format)) throw localAgentError("SCREEN_CAPTURE_INVALID", "image.format must be png, jpeg, or webp.");
  const quality = imageValue.quality === void 0 ? void 0 : captureFrameInteger(imageValue.quality, "image.quality", 1);
  if (quality !== void 0 && quality > 100) throw localAgentError("SCREEN_CAPTURE_INVALID", "image.quality must be from 1 to 100.");
  if (format === "png" && quality !== void 0) throw localAgentError("SCREEN_CAPTURE_INVALID", "image.quality is available only for jpeg and webp output.");
  const outputPath = args.outputPath === void 0 ? void 0 : normalizeWorkspacePath(args.outputPath, "outputPath");
  const extension = outputPath?.slice(outputPath.lastIndexOf(".")).toLowerCase();
  const allowedExtensions = { png: /* @__PURE__ */ new Set([".png"]), jpeg: /* @__PURE__ */ new Set([".jpg", ".jpeg"]), webp: /* @__PURE__ */ new Set([".webp"]) };
  if (extension && !allowedExtensions[format].has(extension)) throw localAgentError("SCREEN_CAPTURE_INVALID", `outputPath extension must match image.format ${format}.`);
  const showInChat = args.showInChat === void 0 ? false : args.showInChat;
  if (typeof showInChat !== "boolean") throw localAgentError("SCREEN_CAPTURE_INVALID", "showInChat must be a boolean.");
  return { image: { format, ...quality === void 0 ? {} : { quality } }, ...outputPath === void 0 ? {} : { outputPath }, showInChat };
}
function normalizeScreenCaptureResult(document) {
  if (!document || typeof document !== "object" || Array.isArray(document) || typeof document.workspacePath !== "string" || !(/* @__PURE__ */ new Set(["png", "jpeg", "webp"])).has(document.format) || !(/* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp"])).has(document.mimeType) || !Number.isInteger(document.width) || document.width < 1 || !Number.isInteger(document.height) || document.height < 1 || !Number.isInteger(document.imageSizeBytes) || document.imageSizeBytes < 0 || !Number.isInteger(document.monitorCount) || document.monitorCount < 1 || !document.virtualDesktop || typeof document.virtualDesktop !== "object" || Array.isArray(document.virtualDesktop) || !Number.isInteger(document.virtualDesktop.left) || !Number.isInteger(document.virtualDesktop.top) || !Number.isInteger(document.virtualDesktop.width) || document.virtualDesktop.width < 1 || !Number.isInteger(document.virtualDesktop.height) || document.virtualDesktop.height < 1 || document.virtualDesktop.width !== document.width || document.virtualDesktop.height !== document.height) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid screen-capture result.");
  }
  const expectedMimeType = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[document.format];
  if (document.mimeType !== expectedMimeType) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an inconsistent screen-capture MIME type.");
  return { workspacePath: normalizeWorkspacePath(document.workspacePath, "workspacePath"), format: document.format, mimeType: document.mimeType, width: document.width, height: document.height, imageSizeBytes: document.imageSizeBytes, showInChat: false, monitorCount: document.monitorCount, virtualDesktop: { left: document.virtualDesktop.left, top: document.virtualDesktop.top, width: document.virtualDesktop.width, height: document.virtualDesktop.height } };
}
async function captureScreen(argumentsValue) {
  const input = normalizeScreenCaptureInput(argumentsValue);
  const { showInChat, ...agentInput } = input;
  return { ...normalizeScreenCaptureResult(await agentJsonRequest("/media/capture-screen", { method: "POST", body: agentInput, timeoutMs: AGENT_CAPTURE_FRAME_TIMEOUT_MS })), showInChat };
}
function normalizeImageCropInput(argumentsValue = {}) {
  const args = captureFrameObject(argumentsValue, "media_image_crop", /* @__PURE__ */ new Set(["path", "crop", "image", "outputPath", "showInChat"]));
  const path = normalizeWorkspacePath(args.path, "path");
  const cropValue = captureFrameObject(args.crop, "crop", /* @__PURE__ */ new Set(["x", "y", "width", "height"]));
  if (!["x", "y", "width", "height"].every((key) => Object.hasOwn(cropValue, key))) throw localAgentError("IMAGE_CROP_INVALID", "crop requires x, y, width, and height.");
  const crop = { x: captureFrameInteger(cropValue.x, "crop.x"), y: captureFrameInteger(cropValue.y, "crop.y"), width: captureFrameInteger(cropValue.width, "crop.width", 1), height: captureFrameInteger(cropValue.height, "crop.height", 1) };
  const imageValue = captureFrameObject(args.image, "image", /* @__PURE__ */ new Set(["format", "quality", "compressionLevel"]));
  const format = imageValue.format === void 0 ? "png" : imageValue.format;
  if (!(/* @__PURE__ */ new Set(["png", "jpeg", "webp"])).has(format)) throw localAgentError("IMAGE_CROP_INVALID", "image.format must be png, jpeg, or webp.");
  const quality = imageValue.quality === void 0 ? void 0 : captureFrameInteger(imageValue.quality, "image.quality", 1);
  if (quality !== void 0 && quality > 100) throw localAgentError("IMAGE_CROP_INVALID", "image.quality must be from 1 to 100.");
  const compressionLevel = imageValue.compressionLevel === void 0 ? void 0 : captureFrameInteger(imageValue.compressionLevel, "image.compressionLevel");
  if (compressionLevel !== void 0 && compressionLevel > 9) throw localAgentError("IMAGE_CROP_INVALID", "image.compressionLevel must be from 0 to 9.");
  if (format === "png" && quality !== void 0) throw localAgentError("IMAGE_CROP_INVALID", "image.quality is available only for jpeg and webp output.");
  if (format !== "png" && compressionLevel !== void 0) throw localAgentError("IMAGE_CROP_INVALID", "image.compressionLevel is available only for png output.");
  const outputPath = args.outputPath === void 0 ? void 0 : normalizeWorkspacePath(args.outputPath, "outputPath");
  const extension = outputPath?.slice(outputPath.lastIndexOf(".")).toLowerCase();
  const allowedExtensions = { png: /* @__PURE__ */ new Set([".png"]), jpeg: /* @__PURE__ */ new Set([".jpg", ".jpeg"]), webp: /* @__PURE__ */ new Set([".webp"]) };
  if (extension && !allowedExtensions[format].has(extension)) throw localAgentError("IMAGE_CROP_INVALID", `outputPath extension must match image.format ${format}.`);
  const showInChat = args.showInChat === void 0 ? false : args.showInChat;
  if (typeof showInChat !== "boolean") throw localAgentError("IMAGE_CROP_INVALID", "showInChat must be a boolean.");
  return { path, crop, image: { format, ...quality === void 0 ? {} : { quality }, ...compressionLevel === void 0 ? {} : { compressionLevel } }, ...outputPath === void 0 ? {} : { outputPath }, showInChat };
}
function normalizeImageCropResult(document, input) {
  const image = document?.image;
  if (!document || typeof document !== "object" || Array.isArray(document) || document.sourcePath !== input.path || !Number.isInteger(document.sourceWidth) || document.sourceWidth < 1 || !Number.isInteger(document.sourceHeight) || document.sourceHeight < 1 || !document.crop || document.crop.x !== input.crop.x || document.crop.y !== input.crop.y || document.crop.width !== input.crop.width || document.crop.height !== input.crop.height || !image || typeof image !== "object" || Array.isArray(image) || image.format !== input.image.format || !(/* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp"])).has(image.mimeType) || image.width !== input.crop.width || image.height !== input.crop.height || !Number.isInteger(image.imageSizeBytes) || image.imageSizeBytes < 0 || typeof image.workspacePath !== "string" || Object.hasOwn(image, "publicUrl") || Object.hasOwn(document, "inlineImageBase64")) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid image-crop result.");
  }
  const expectedMimeType = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[image.format];
  if (image.mimeType !== expectedMimeType) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an inconsistent cropped-image MIME type.");
  return {
    sourcePath: input.path,
    sourceWidth: document.sourceWidth,
    sourceHeight: document.sourceHeight,
    crop: input.crop,
    showInChat: input.showInChat,
    image: { format: image.format, mimeType: image.mimeType, width: image.width, height: image.height, imageSizeBytes: image.imageSizeBytes, workspacePath: normalizeWorkspacePath(image.workspacePath, "image.workspacePath") }
  };
}
async function imageCrop(argumentsValue) {
  const input = normalizeImageCropInput(argumentsValue);
  const { showInChat: _showInChat, ...agentInput } = input;
  return normalizeImageCropResult(await agentJsonRequest("/media/image-crop", { method: "POST", body: agentInput, timeoutMs: AGENT_CAPTURE_FRAME_TIMEOUT_MS }), input);
}
async function getWorkspaceMediaMetadata(path) {
  const logicalPath = normalizeWorkspacePath(path, "path");
  const document = await agentJsonRequest("/media/workspace-media-info", { method: "POST", body: { path: logicalPath }, timeoutMs: AGENT_CAPTURE_FRAME_TIMEOUT_MS });
  if (!document || typeof document !== "object" || document.path !== logicalPath || !["image", "audio"].includes(document.mediaType) || !(/* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm"])).has(document.mimeType) || !Number.isInteger(document.sizeBytes) || document.sizeBytes < 0) {
    throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid workspace media metadata.");
  }
  if (document.mediaType === "image" !== document.mimeType.startsWith("image/")) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned inconsistent workspace media metadata.");
  return { path: logicalPath, mediaType: document.mediaType, mimeType: document.mimeType, sizeBytes: document.sizeBytes };
}
async function localAgentWorkspaceMediaUrl(path) {
  const logicalPath = normalizeWorkspacePath(path, "path");
  const config = await getConfig();
  const port = normalizeAgentPort(config.agentPort);
  await requireCompatibleAgent(port);
  const encodedWorkspacePath = logicalPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `http://127.0.0.1:${port}/${encodedWorkspacePath}`;
}
async function showWorkspaceMedia(path) {
  const metadata = await getWorkspaceMediaMetadata(path);
  return {
    metadata: { workspacePath: metadata.path, mediaType: metadata.mediaType, mimeType: metadata.mimeType, sizeBytes: metadata.sizeBytes, showInChat: true },
    localAgentMediaUrl: await localAgentWorkspaceMediaUrl(metadata.path)
  };
}
function normalizeClipboardRevision(value, field) {
  if (typeof value !== "string" || !/^cb_[0-9]+$/.test(value)) throw localAgentError("CLIPBOARD_INVALID", `${field} must be a clipboard revision returned by clipboard_status.`);
  return value;
}
function normalizeClipboardStatusInput(argumentsValue = {}) {
  const args = captureFrameObject(argumentsValue, "clipboard_status", /* @__PURE__ */ new Set(["sinceRevision"]));
  return args.sinceRevision === void 0 ? {} : { sinceRevision: normalizeClipboardRevision(args.sinceRevision, "sinceRevision") };
}
function normalizeClipboardStatusResult(document, input) {
  if (!document || typeof document !== "object" || Array.isArray(document) || !(/* @__PURE__ */ new Set(["text", "image", "empty", "unsupported"])).has(document.type)) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid clipboard status.");
  const result = { type: document.type, revision: normalizeClipboardRevision(document.revision, "revision") };
  if (input.sinceRevision !== void 0) {
    if (typeof document.changed !== "boolean") throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent did not return clipboard change status.");
    result.changed = document.changed;
  }
  if (document.sizeBytes !== void 0) {
    if (!Number.isInteger(document.sizeBytes) || document.sizeBytes < 0) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid clipboard size.");
    result.sizeBytes = document.sizeBytes;
  }
  if (document.type === "image") {
    if (!Number.isInteger(document.width) || document.width < 1 || !Number.isInteger(document.height) || document.height < 1) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid clipboard image dimensions.");
    result.width = document.width;
    result.height = document.height;
  }
  return result;
}
async function clipboardStatus(argumentsValue) {
  const input = normalizeClipboardStatusInput(argumentsValue);
  return normalizeClipboardStatusResult(await agentJsonRequest("/clipboard/status", { method: "POST", body: input, timeoutMs: AGENT_TASK_TIMEOUT_MS }), input);
}
function normalizeClipboardGetInput(argumentsValue = {}) {
  const args = captureFrameObject(argumentsValue, "clipboard_get", /* @__PURE__ */ new Set(["revision"]));
  return args.revision === void 0 ? {} : { revision: normalizeClipboardRevision(args.revision, "revision") };
}
function normalizeClipboardGetResult(document) {
  if (!document || typeof document !== "object" || Array.isArray(document) || !(/* @__PURE__ */ new Set(["text", "image"])).has(document.type)) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid clipboard value.");
  const result = { type: document.type, revision: normalizeClipboardRevision(document.revision, "revision") };
  if (document.type === "text") {
    if (typeof document.text !== "string") throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid clipboard text.");
    result.text = document.text;
  } else {
    if (typeof document.workspacePath !== "string" || !Number.isInteger(document.width) || document.width < 1 || !Number.isInteger(document.height) || document.height < 1 || !Number.isInteger(document.sizeBytes) || document.sizeBytes < 0) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid clipboard image metadata.");
    result.workspacePath = normalizeWorkspacePath(document.workspacePath, "workspacePath");
    result.width = document.width;
    result.height = document.height;
    result.sizeBytes = document.sizeBytes;
  }
  return result;
}
async function clipboardGet(argumentsValue) {
  try {
    return normalizeClipboardGetResult(await agentJsonRequest("/clipboard/get", { method: "POST", body: normalizeClipboardGetInput(argumentsValue), timeoutMs: AGENT_CAPTURE_FRAME_TIMEOUT_MS }));
  } catch (error) {
    if (error?.code === "CLIPBOARD_CHANGED") {
      return { ok: false, status: "clipboard_changed", message: "The clipboard changed after the supplied revision." };
    }
    throw error;
  }
}
function normalizeClipboardSetInput(argumentsValue = {}) {
  const args = captureFrameObject(argumentsValue, "clipboard_set", /* @__PURE__ */ new Set(["text", "workspacePath"]));
  if (args.text === void 0 === (args.workspacePath === void 0)) throw localAgentError("CLIPBOARD_INVALID", "clipboard_set requires exactly one of text or workspacePath.");
  if (args.text !== void 0) {
    if (typeof args.text !== "string" || new TextEncoder().encode(args.text).byteLength > 2 * 1024 * 1024) throw localAgentError("CLIPBOARD_TOO_LARGE", "text must be a Unicode string of at most 2 MiB UTF-8.");
    return { text: args.text };
  }
  return { workspacePath: normalizeWorkspacePath(args.workspacePath, "workspacePath") };
}
function normalizeClipboardSetResult(document) {
  if (!document || typeof document !== "object" || Array.isArray(document) || document.success !== true || !(/* @__PURE__ */ new Set(["text", "image"])).has(document.type)) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned an invalid clipboard write result.");
  const result = { success: true, type: document.type, revision: normalizeClipboardRevision(document.revision, "revision") };
  if (document.type === "image") {
    if (!Number.isInteger(document.width) || document.width < 1 || !Number.isInteger(document.height) || document.height < 1) throw localAgentError("AGENT_INVALID_RESPONSE", "The Local Agent returned invalid clipboard image dimensions.");
    result.width = document.width;
    result.height = document.height;
  }
  return result;
}
async function clipboardSet(argumentsValue) {
  return normalizeClipboardSetResult(await agentJsonRequest("/clipboard/set", { method: "POST", body: normalizeClipboardSetInput(argumentsValue), timeoutMs: AGENT_CAPTURE_FRAME_TIMEOUT_MS }));
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
        justification: "Copy a user-requested ResearchTube workspace path to the local clipboard."
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
  const response = await fetch(chrome.runtime.getURL("ui/capture-frame-widget-v27.html"));
  if (!response.ok) throw new Error("The bundled workspace-image widget could not be read.");
  return response.text();
}
function captureFrameWidgetResource() {
  return {
    uri: CAPTURE_FRAME_WIDGET_URI,
    name: "ResearchTube workspace-image viewer",
    description: "Displays a requested frame, screenshot, cropped image, or existing workspace image.",
    mimeType: "text/html;profile=mcp-app"
  };
}
async function readMcpResource(id, uri) {
  if (uri !== CAPTURE_FRAME_WIDGET_URI) {
    return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown MCP resource URI" } };
  }
  try {
    const text = await readCaptureFrameWidgetHtml();
    const config = await getConfig();
    const loopbackOrigin = `http://127.0.0.1:${normalizeAgentPort(config.agentPort)}`;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        contents: [{
          ...captureFrameWidgetResource(),
          text,
          _meta: {
            ui: { prefersBorder: true, csp: { connectDomains: [loopbackOrigin], resourceDomains: [loopbackOrigin] } },
            "openai/widgetDescription": "Displays a requested workspace image with context-specific provenance."
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
        instructions: RESEARCHTUBE_MCP_INSTRUCTIONS,
        serverInfo: { name: "researchtube", version: EXTENSION_VERSION, title: "ResearchTube", description: RESEARCHTUBE_SERVER_DESCRIPTION }
      }
    };
  }
  if (request?.method === "notifications/initialized") return null;
  if (request?.method === "tools/list") {
    return { jsonrpc: "2.0", id: request.id, result: { tools: await enabledMcpToolDefinitions() } };
  }
  if (request?.method === "resources/list") {
    return { jsonrpc: "2.0", id: request.id, result: { resources: [captureFrameWidgetResource()] } };
  }
  if (request?.method === "resources/read") {
    return readMcpResource(request.id, request.params?.uri);
  }
  if (request?.method === "tools/call" && typeof request.params?.name === "string" && !await isMcpToolEnabled(request.params.name)) {
    return disabledMcpToolError(request.id, request.params.name);
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_download") {
    const input = request.params.arguments ?? {};
    return executeToolCall(request.id, "youtube_download", input, () => startYouTubeDownload(input));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_download_get_formats") {
    const videoId = String(request.params.arguments?.videoId ?? "").trim();
    if (!videoId) return toolError(request.id, localAgentError("INVALID_ARGUMENT", "videoId is required."));
    return executeToolCall(request.id, "youtube_download_get_formats", { videoId }, () => getYouTubeDownloadFormats(videoId));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_download_get_task") {
    const taskId = String(request.params.arguments?.taskId ?? "").trim();
    if (!taskId) return toolError(request.id, localAgentError("INVALID_ARGUMENT", "taskId is required."));
    return executeToolCall(request.id, "youtube_download_get_task", { taskId }, () => getYouTubeDownloadTask(taskId));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_download_task_diagnostics") {
    const args = request.params.arguments ?? {};
    const taskId = String(args.taskId ?? "").trim();
    if (!taskId) return toolError(request.id, localAgentError("INVALID_ARGUMENT", "taskId is required."));
    return executeToolCall(request.id, "youtube_download_task_diagnostics", { taskId, afterEventId: args.afterEventId ?? 0, limit: args.limit ?? 100 }, () => getYouTubeDownloadTaskDiagnostics(taskId, args));
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_download_cancel_task") {
    const taskId = String(request.params.arguments?.taskId ?? "").trim();
    if (!taskId) return toolError(request.id, localAgentError("INVALID_ARGUMENT", "taskId is required."));
    return executeToolCall(request.id, "youtube_download_cancel_task", { taskId }, () => cancelYouTubeDownloadTask(taskId));
  }
  if (request?.method === "tools/call" && request.params?.name === "system_agent_status") {
    return executeToolCall(request.id, "system_agent_status", {}, () => getAgentStatus());
  }
  if (request?.method === "tools/call" && request.params?.name === "library_store_start") {
    const files = request.params.arguments?.files;
    return executeToolCall(request.id, "library_store_start", { files }, () => libraryStoreStart(files));
  }
  if (request?.method === "tools/call" && request.params?.name === "library_store_status") {
    const taskId = String(request.params.arguments?.taskId ?? "").trim();
    if (!taskId) return toolError(request.id, localAgentError("INVALID_ARGUMENT", "taskId is required."));
    return executeToolCall(request.id, "library_store_status", { taskId }, () => libraryStoreStatus(taskId));
  }
  if (request?.method === "tools/call" && request.params?.name === "library_store_cancel") {
    const taskId = String(request.params.arguments?.taskId ?? "").trim();
    if (!taskId) return toolError(request.id, localAgentError("INVALID_ARGUMENT", "taskId is required."));
    return executeToolCall(request.id, "library_store_cancel", { taskId }, () => libraryStoreCancel(taskId));
  }
  if (request?.method === "tools/call" && request.params?.name === "workspace_list") {
    const args = request.params.arguments ?? {};
    const path = args.path === void 0 ? "" : args.path;
    const limit = args.limit === void 0 ? 100 : args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return toolError(request.id, localAgentError("INVALID_ARGUMENT", "limit must be an integer from 1 to 500."));
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
  if (request?.method === "tools/call" && request.params?.name === "online_share_start") {
    const args = request.params.arguments ?? {};
    return executeToolCall(request.id, "online_share_start", args, () => workspaceShareStart(args));
  }
  if (request?.method === "tools/call" && request.params?.name === "online_share_status") {
    const args = request.params.arguments ?? {};
    return executeToolCall(request.id, "online_share_status", args, () => workspaceShareStatus(args.verifyExternal));
  }
  if (request?.method === "tools/call" && request.params?.name === "online_share_stop") {
    return executeToolCall(request.id, "online_share_stop", {}, workspaceShareStop);
  }
  if (request?.method === "tools/call" && request.params?.name === "media_probe") {
    const path = request.params.arguments?.path;
    const sections = request.params.arguments?.sections;
    return executeToolCall(request.id, "media_probe", { path, sections }, () => mediaProbe(path, sections));
  }
  if (request?.method === "tools/call" && request.params?.name === "media_capture_frame") {
    const args = request.params.arguments ?? {};
    return executeCaptureFrameToolCall(request.id, args);
  }
  if (request?.method === "tools/call" && request.params?.name === "media_visual_map_create") {
    const args = request.params.arguments ?? {};
    return executeToolCall(request.id, "media_visual_map_create", args, () => createVisualMap(args));
  }
  if (request?.method === "tools/call" && request.params?.name === "media_visual_map_get_task") {
    const taskId = request.params.arguments?.taskId;
    return executeToolCall(request.id, "media_visual_map_get_task", { taskId }, () => getVisualMapTask(taskId));
  }
  if (request?.method === "tools/call" && request.params?.name === "media_visual_map_cancel_task") {
    const taskId = request.params.arguments?.taskId;
    return executeToolCall(request.id, "media_visual_map_cancel_task", { taskId }, () => cancelVisualMapTask(taskId));
  }
  if (request?.method === "tools/call" && request.params?.name === "media_camera_list") {
    return executeToolCall(request.id, "media_camera_list", {}, cameraList);
  }
  if (request?.method === "tools/call" && request.params?.name === "media_camera_capture_frame") {
    const args = request.params.arguments ?? {};
    return executeToolCall(request.id, "media_camera_capture_frame", args, () => cameraCaptureFrame(args));
  }
  if (request?.method === "tools/call" && request.params?.name === "media_camera_record_video") {
    const args = request.params.arguments ?? {};
    return executeToolCall(request.id, "media_camera_record_video", args, () => cameraRecordVideo(args));
  }
  if (request?.method === "tools/call" && request.params?.name === "media_camera_record_audio") {
    const args = request.params.arguments ?? {};
    return executeToolCall(request.id, "media_camera_record_audio", args, () => cameraRecordAudio(args));
  }
  if (request?.method === "tools/call" && request.params?.name === "media_camera_record_status") {
    const taskId = request.params.arguments?.taskId;
    return executeToolCall(request.id, "media_camera_record_status", { taskId }, () => cameraRecordStatus(taskId));
  }
  if (request?.method === "tools/call" && request.params?.name === "media_camera_record_stop") {
    const taskId = request.params.arguments?.taskId;
    return executeToolCall(request.id, "media_camera_record_stop", { taskId }, () => cameraRecordStop(taskId));
  }
  if (request?.method === "tools/call" && request.params?.name === "media_capture_screen") {
    const args = request.params.arguments ?? {};
    return executeToolCall(request.id, "media_capture_screen", args, () => captureScreen(args));
  }
  if (request?.method === "tools/call" && request.params?.name === "media_image_crop") {
    const args = request.params.arguments ?? {};
    return executeToolCall(request.id, "media_image_crop", args, () => imageCrop(args));
  }
  if (request?.method === "tools/call" && request.params?.name === "media_show_in_chat") {
    return executeShowWorkspaceMediaToolCall(request.id, request.params.arguments?.path);
  }
  if (request?.method === "tools/call" && request.params?.name === "media_image_inspect") {
    const path = request.params.arguments?.path;
    return executeToolCall(request.id, "media_image_inspect", { path }, () => mediaInspectImage(path));
  }
  if (request?.method === "tools/call" && request.params?.name === "clipboard_status") {
    return executeToolCall(request.id, "clipboard_status", request.params.arguments ?? {}, () => clipboardStatus(request.params.arguments ?? {}));
  }
  if (request?.method === "tools/call" && request.params?.name === "clipboard_get") {
    return executeToolCall(request.id, "clipboard_get", request.params.arguments ?? {}, () => clipboardGet(request.params.arguments ?? {}));
  }
  if (request?.method === "tools/call" && request.params?.name === "clipboard_set") {
    return executeToolCall(request.id, "clipboard_set", request.params.arguments ?? {}, () => clipboardSet(request.params.arguments ?? {}));
  }
  if (request?.method === "tools/call" && request.params?.name === "media_load_workspace_media") {
    const path = request.params.arguments?.path;
    return executeWorkspaceMediaToolCall(request.id, path);
  }
  if (request?.method === "tools/call" && request.params?.name === "media_copy_workspace_path") {
    return executeCaptureFrameWidgetActionToolCall(request.id, "media_copy_workspace_path", request.params.arguments?.path, copyCaptureFramePath);
  }
  if (request?.method === "tools/call" && request.params?.name === "youtube_search") {
    const query = String(request.params.arguments?.query ?? "").trim();
    const limit = boundedInt(request.params.arguments?.limit, 10, 1, 50);
    if (!query) {
      return toolError(request.id, localAgentError("INVALID_ARGUMENT", "query is required."));
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
    if (!commentId) return toolError(request.id, localAgentError("INVALID_ARGUMENT", "commentId is required."));
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
    void recordCommandDiagnostic("started", { tool: "media_capture_frame", input: summarizeCommandInput("media_capture_frame", input) });
    await setActionBadge("working");
    const result = await captureFrame(input);
    await refreshActionBadge();
    void recordCommandDiagnostic("succeeded", { tool: "media_capture_frame", elapsed_ms: Date.now() - startedAt, output: summarizeCommandOutput(result.metadata) });
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result.metadata) }], structuredContent: result.metadata, isError: false } };
  } catch (error) {
    await refreshActionBadge();
    void recordCommandDiagnostic("failed", {
      tool: "media_capture_frame",
      elapsed_ms: Date.now() - startedAt,
      error_code: error?.code || null,
      error: searchDiagnosticMessage(error)
    });
    return toolError(id, error);
  }
}
async function executeWorkspaceMediaToolCall(id, path) {
  const startedAt = Date.now();
  try {
    const metadata = await getWorkspaceMediaMetadata(path);
    const result = { metadata, localAgentMediaUrl: await localAgentWorkspaceMediaUrl(metadata.path) };
    const mcpResult = {
      content: [{ type: "text", text: JSON.stringify(result.metadata) }],
      structuredContent: result.metadata,
      // Image delivery is widget-only; image bytes never enter the MCP result.
      _meta: { researchtube: { localAgentMediaUrl: result.localAgentMediaUrl } },
      isError: false
    };
    void recordCommandDiagnostic("succeeded", { tool: "media_load_workspace_media", elapsed_ms: Date.now() - startedAt, output: { path: result.metadata.path, sizeBytes: result.metadata.sizeBytes } });
    return { jsonrpc: "2.0", id, result: mcpResult };
  } catch (error) {
    void recordCommandDiagnostic("failed", { tool: "media_load_workspace_media", elapsed_ms: Date.now() - startedAt, error_code: error?.code || null, error: searchDiagnosticMessage(error) });
    return toolError(id, error);
  }
}
async function executeShowWorkspaceMediaToolCall(id, path) {
  const startedAt = Date.now();
  try {
    const result = await showWorkspaceMedia(path);
    void recordCommandDiagnostic("succeeded", { tool: "media_show_in_chat", elapsed_ms: Date.now() - startedAt, output: result.metadata });
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Workspace media shown." }], structuredContent: result.metadata, _meta: { researchtube: { localAgentMediaUrl: result.localAgentMediaUrl } }, isError: false } };
  } catch (error) {
    void recordCommandDiagnostic("failed", { tool: "media_show_in_chat", elapsed_ms: Date.now() - startedAt, error_code: error?.code || null, error: searchDiagnosticMessage(error) });
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
  const reportsLongOperationStatus = tool === "library_store_status";
  void recordCommandDiagnostic("started", { tool, input: summarizeCommandInput(tool, input) });
  await setActionBadge("working");
  try {
    const value = await work();
    if (reportsLongOperationStatus) await reportMcpToolToAgent(tool, value);
    await refreshActionBadge();
    void recordCommandDiagnostic("succeeded", {
      tool,
      elapsed_ms: Date.now() - startedAt,
      output: summarizeCommandOutput(value)
    });
    return jsonToolResult(id, value);
  } catch (error) {
    if (reportsLongOperationStatus) await reportMcpToolToAgent(tool, null, true);
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
  if (tool === "media_capture_frame") return { path: typeof input.path === "string" ? input.path : null, youtube: input.youtube && typeof input.youtube === "object" ? { videoId: input.youtube.videoId ?? null, formatId: input.youtube.formatId ?? null } : null, timestampSeconds: input.timestampSeconds ?? null, videoStreamIndex: input.videoStreamIndex ?? null, seekMode: input.seekMode ?? null, outputPath: typeof input.outputPath === "string" ? input.outputPath : null };
  if (tool === "media_visual_map_create") return { workspacePath: typeof input.workspacePath === "string" ? input.workspacePath : null, columns: input.columns ?? null, rows: input.rows ?? null, maxTotalFrames: input.maxTotalFrames ?? null, selection: input.selection ?? "uniform" };
  if (tool === "media_visual_map_get_task") return { taskId: typeof input.taskId === "string" ? input.taskId : null };
  if (tool === "media_visual_map_cancel_task") return { taskId: typeof input.taskId === "string" ? input.taskId : null };
  if (tool === "media_camera_list") return {};
  if (tool === "media_camera_capture_frame") return { cameraId: typeof input.cameraId === "string" ? input.cameraId : null, targetFormat: input.targetFormat ?? "png" };
  if (tool === "media_camera_record_video") return { cameraId: typeof input.cameraId === "string" ? input.cameraId : null, durationSeconds: input.durationSeconds ?? null, targetFps: input.targetFps ?? null };
  if (tool === "media_camera_record_audio") return { cameraId: typeof input.cameraId === "string" ? input.cameraId : null, durationSeconds: input.durationSeconds ?? null };
  if (tool === "media_camera_record_status" || tool === "media_camera_record_stop") return { taskId: typeof input.taskId === "string" ? input.taskId : null };
  if (tool === "media_capture_screen") return { outputPath: typeof input.outputPath === "string" ? input.outputPath : null, format: input.image?.format ?? null };
  if (tool === "media_image_crop") return { path: typeof input.path === "string" ? input.path : null, crop: input.crop ?? null, outputPath: typeof input.outputPath === "string" ? input.outputPath : null, format: input.image?.format ?? null };
  if (tool === "clipboard_status") return { sinceRevisionProvided: typeof input.sinceRevision === "string" };
  if (tool === "clipboard_get") return { revisionProvided: typeof input.revision === "string" };
  if (tool === "clipboard_set") return { type: typeof input.text === "string" ? "text" : typeof input.workspacePath === "string" ? "image" : "invalid", textBytes: typeof input.text === "string" ? new TextEncoder().encode(input.text).byteLength : null, workspacePath: typeof input.workspacePath === "string" ? input.workspacePath : null };
  if (tool === "youtube_download") return { videoId: typeof input.videoId === "string" ? input.videoId : null, formatSelection: input.formatSelection ?? null, startSeconds: input.startSeconds ?? null, endSeconds: input.endSeconds ?? null, outputDir: typeof input.outputDir === "string" ? input.outputDir.slice(0, 300) : null };
  if (tool === "youtube_search") return { query: searchDiagnosticQuery(input.query), limit: input.limit };
  if (tool === "youtube_get_comment_replies") return { videoId: input.videoId, commentId: input.commentId, limit: input.limit };
  if (tool === "youtube_get_channel_videos") return { channel: input.channel, limit: input.limit, includeShorts: input.includeShorts, includeStreams: input.includeStreams, continuationProvided: Boolean(input.continuation) };
  if (tool === "youtube_get_channel_playlists") return { channel: input.channel, limit: input.limit, continuationProvided: Boolean(input.continuation) };
  if (tool === "youtube_get_playlist_videos") return { playlist: input.playlist, limit: input.limit, continuationProvided: Boolean(input.continuation) };
  return { ...input };
}
function summarizeCommandOutput(value) {
  if (!value || typeof value !== "object") return null;
  if (value.type === "text" && typeof value.revision === "string" && typeof value.text === "string") return { type: "text", revision: value.revision, textBytes: new TextEncoder().encode(value.text).byteLength };
  if ((value.type === "image" || value.type === "text") && typeof value.revision === "string") return { type: value.type, revision: value.revision, ...Number.isInteger(value.width) ? { width: value.width, height: value.height } : {}, ...Number.isInteger(value.sizeBytes) ? { sizeBytes: value.sizeBytes } : {} };
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
  const errorDocument = { code: typeof code === "string" ? code : "TOOL_ERROR", message, detail: typeof error?.detail === "string" ? error.detail : null };
  if (isExpectedToolError(errorDocument.code)) {
    const rejected = { status: "rejected", error: errorDocument };
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], structuredContent: rejected, isError: false } };
  }
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], structuredContent: { error: errorDocument }, isError: true } };
}
function isExpectedToolError(code) {
  if (typeof code !== "string") return false;
  if ((/* @__PURE__ */ new Set(["INVALID_ARGUMENT", "INVALID_REQUEST", "INVALID_VIDEO_ID", "NOT_FOUND", "TOOL_DISABLED", "CLIPBOARD_CHANGED", "CLIPBOARD_EMPTY", "CLIPBOARD_TOO_LARGE", "DESTINATION_EXISTS", "DIRECTORY_NOT_EMPTY", "FORMAT_NOT_AVAILABLE", "CAPTURE_VIDEO_FORMAT_NOT_AVAILABLE", "REQUEST_TOO_LARGE", "WORKSPACE_PATH_OUTSIDE_SANDBOX", "PUBLIC_SHARE_NOT_ACTIVE"])).has(code)) return true;
  return code.endsWith("_INVALID") || code.endsWith("_NOT_FOUND") || code.endsWith("_DESTINATION_EXISTS");
}
function disabledMcpToolError(id, name) {
  return toolError(id, Object.assign(new Error(`ResearchTube tool ${name} is disabled in Extension Settings. Enable it, then open ChatGPT Plugins, find ResearchTube, choose Manage, and click Refresh to reload the MCP tool schema.`), { code: "TOOL_DISABLED" }));
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
