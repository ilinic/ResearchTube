import { Innertube } from "youtubei.js";

// Runs in YouTube's MAIN JavaScript world. It deliberately never reads or
// exports cookies. It observes the same JSON responses used by the page and
// can perform a narrowly scoped timed-text request in the page's own origin.
(() => {
  if (window.__youtubeResearchPageBridgeInstalled) return;
  window.__youtubeResearchPageBridgeInstalled = true;

  const SOURCE = "researchtube-page-bridge";
  const COMMAND_SOURCE = "researchtube-extension-content";
  const originalFetch = window.fetch.bind(window);
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const MAX_CAPTURE_BYTES = 1_500_000;
  const responseLog = [];
  let innertubePromise = null;

  function isRelevant(url) {
    return /\/youtubei\/v1\/|\/api\/timedtext(?:\?|$)/.test(url);
  }

  function post(type, payload) {
    window.postMessage({ source: SOURCE, type, payload }, location.origin);
  }

  function rememberResponse(payload) {
    responseLog.push({ at: Date.now(), ...payload });
    if (responseLog.length > 20) responseLog.splice(0, responseLog.length - 20);
  }

  function urlFrom(input) {
    try { return new URL(typeof input === "string" ? input : input?.url, location.href).href; }
    catch { return null; }
  }

  function captureResponse(url, response, method = "GET") {
    if (!url || !isRelevant(url)) return;
    response.clone().text().then((body) => {
      const payload = {
        url, method, status: response.status,
        body: body.length <= MAX_CAPTURE_BYTES ? body : body.slice(0, MAX_CAPTURE_BYTES),
        truncated: body.length > MAX_CAPTURE_BYTES
      };
      rememberResponse(payload);
      post("network-response", payload);
    }).catch(() => {});
  }

  window.fetch = async function (...args) {
    const response = await originalFetch(...args);
    const request = args[1] || {};
    captureResponse(urlFrom(args[0]), response, String(request.method || "GET").toUpperCase());
    return response;
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__youtubeResearchMethod = method;
    this.__youtubeResearchUrl = urlFrom(url);
    return originalXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("loadend", () => {
      if (!this.__youtubeResearchUrl || !isRelevant(this.__youtubeResearchUrl) || typeof this.responseText !== "string") return;
      const body = this.responseText;
      const payload = {
        url: this.__youtubeResearchUrl,
        method: String(this.__youtubeResearchMethod || "GET").toUpperCase(),
        status: this.status,
        body: body.length <= MAX_CAPTURE_BYTES ? body : body.slice(0, MAX_CAPTURE_BYTES),
        truncated: body.length > MAX_CAPTURE_BYTES
      };
      rememberResponse(payload);
      post("network-response", payload);
    }, { once: true });
    return originalXhrSend.apply(this, args);
  };

  function pageState() {
    const rawPlayer = window.ytInitialPlayerResponse || window.ytplayer?.config?.args?.player_response || null;
    let player = rawPlayer;
    if (typeof rawPlayer === "string") {
      try { player = JSON.parse(rawPlayer); } catch { player = null; }
    }
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const apiKey = window.ytcfg?.get?.("INNERTUBE_API_KEY") || null;
    return {
      url: location.href,
      title: document.title,
      ready: Boolean(player || (apiKey && document.readyState !== "loading" && document.title)),
      innertubeConfigured: Boolean(apiKey),
      playerAvailable: Boolean(player),
      videoId: player?.videoDetails?.videoId || null,
      captionTracks: tracks.map((track) => ({
        language: track.languageCode || null,
        name: track.name?.simpleText || track.name?.runs?.map((run) => run.text || "").join("") || null,
        generated: track.kind === "asr",
        vssId: track.vssId || null
      }))
    };
  }

  function isAllowedTimedTextUrl(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && url.pathname === "/api/timedtext";
    } catch { return false; }
  }

  // The library is bundled into this MAIN-world file. Its fetch implementation
  // is deliberately pinned to the YouTube document's native fetch: that is what
  // gives the request the page's https://www.youtube.com origin. During the
  // build, youtubei.js's static public client-key literals are replaced with a
  // getter for this document's live INNERTUBE_API_KEY, so no such literal is
  // committed in the extension bundle.
  async function getInnertube() {
    if (!innertubePromise) {
      const visitorData = window.ytcfg?.get?.("VISITOR_DATA") || undefined;
      innertubePromise = Innertube.create({
        client_type: "WEB",
        retrieve_player: false,
        enable_session_cache: false,
        visitor_data: visitorData,
        fetch: (input, init) => originalFetch(input, {
          ...init,
          credentials: "omit"
        })
      });
    }
    return innertubePromise;
  }

  function textOf(value) {
    return value?.simpleText || value?.runs?.map((run) => run.text || "").join("") || "";
  }

  function decodeCaptionMarkup(value) {
    const named = {
      amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", nbsp: " "
    };
    const decodeOnePass = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|quot|lt|gt|nbsp);/gi, (_match, entity) => {
      const normalized = String(entity).toLowerCase();
      if (normalized[0] !== "#") return named[normalized] ?? `&${entity};`;
      const codePoint = normalized.startsWith("#x")
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      try {
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : `&${entity};`;
      } catch {
        return `&${entity};`;
      }
    });
    let text = String(value || "");
    // Captions occasionally encode entities twice. Bound the work and never
    // assign this string to HTML, which keeps YouTube Trusted Types intact.
    for (let pass = 0; pass < 3; pass += 1) {
      const next = decodeOnePass(text);
      if (next === text) break;
      text = next;
    }
    return text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  }

  function captionText(parts) {
    return decodeCaptionMarkup((parts || []).map((part) => part?.utf8 || "").join(""));
  }

  function playerTracks(player) {
    return player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  }

  function playerStatus(player) {
    const status = player?.playabilityStatus?.status || "unknown";
    const reason = player?.playabilityStatus?.reason || "no caption tracks";
    return `${status}: ${reason}`;
  }

  async function getAnonymousWatchHtml(videoId) {
    const response = await originalFetch(`/watch?v=${encodeURIComponent(videoId)}`, {
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "text/html" }
    });
    if (!response.ok) throw new Error(`YouTube anonymous watch page failed: HTTP ${response.status}`);
    return response.text();
  }

  function parseCaptionResponse(rawData) {
    const text = rawData.trim();
    if (text.startsWith("{")) {
      const json = JSON.parse(text);
      return (json.events || [])
        .filter((event) => Array.isArray(event?.segs) && event.aAppend !== 1)
        .map((event) => ({
          start: Number(event.tStartMs || 0) / 1000,
          duration: Number(event.dDurationMs || 0) / 1000,
          text: captionText(event.segs)
        }));
    }

    const readAttribute = (attributes, name) => {
      const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
      return match?.[1] ?? match?.[2] ?? "";
    };
    const secondsFromClock = (value) => {
      const source = String(value || "").trim().replace(/s$/i, "");
      const numeric = Number(source);
      if (Number.isFinite(numeric)) return numeric;
      const parts = source.split(":").map(Number);
      return parts.length >= 2 && parts.every(Number.isFinite)
        ? parts.reduce((total, part) => total * 60 + part, 0)
        : 0;
    };
    const segments = [];
    for (const match of text.matchAll(/<(?:text|p)\b([^>]*)>([\s\S]*?)<\/(?:text|p)>/gi)) {
      const attributes = match[1];
      const start = readAttribute(attributes, "start");
      const begin = readAttribute(attributes, "begin");
      const t = readAttribute(attributes, "t");
      const duration = readAttribute(attributes, "dur");
      const d = readAttribute(attributes, "d");
      const end = readAttribute(attributes, "end");
      // YouTube's normal transcript XML uses start/dur in seconds. The srv3
      // variant uses p[t,d] in milliseconds; it was the source of all-zero
      // timestamps in the prior build.
      const startSeconds = start ? secondsFromClock(start)
        : begin ? secondsFromClock(begin)
          : t ? Number(t) / 1000 : 0;
      const durationSeconds = duration ? secondsFromClock(duration)
        : d ? Number(d) / 1000
          : end ? Math.max(0, secondsFromClock(end) - startSeconds) : 0;
      segments.push({
        start: Number.isFinite(startSeconds) ? startSeconds : 0,
        duration: Number.isFinite(durationSeconds) ? durationSeconds : 0,
        text: decodeCaptionMarkup(match[2])
      });
    }
    if (!segments.length) throw new Error("YouTube timedtext returned neither JSON3 nor readable XML");
    return segments;
  }

  // This intentionally mirrors the working page-console probe: obtain the
  // live key from /watch, make a minimal ANDROID /player request, then read
  // the primary caption baseUrl. No youtubei.js transcript endpoint is used.
  async function getTranscriptFromPlayer({ videoId, limit }) {
    const pageHtml = await getAnonymousWatchHtml(videoId);
    const apiKey = pageHtml.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
    if (!apiKey) throw new Error("INNERTUBE_API_KEY was not found in the anonymous YouTube watch page");

    const playerResponse = await originalFetch(`/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } },
        videoId
      })
    });
    if (!playerResponse.ok) throw new Error(`YouTube ANDROID /player failed: HTTP ${playerResponse.status}`);
    const player = await playerResponse.json();
    const tracks = playerTracks(player);
    if (!tracks.length) {
      throw new Error(`No public caption track is available (${playerStatus(player)})`);
    }

    // The extension deliberately returns only the primary caption track.
    const track = tracks[0];
    if (!track?.baseUrl || !isAllowedTimedTextUrl(track.baseUrl)) {
      throw new Error("The primary caption track did not contain a valid YouTube timedtext URL");
    }
    const captionResponse = await originalFetch(track.baseUrl, {
      credentials: "omit",
      cache: "no-store",
    });
    if (!captionResponse.ok) throw new Error(`YouTube timedtext request failed: HTTP ${captionResponse.status}`);
    const segments = parseCaptionResponse(await captionResponse.text())
      .filter((segment) => segment.text)
      .filter(Boolean)
      .slice(0, Math.max(1, Number(limit || 800)));
    if (!segments.length) throw new Error("The primary caption track returned no readable timedtext events");

    return {
      videoId,
      selectedTrack: {
        languageCode: track.languageCode || null,
        name: textOf(track.name) || null,
        isAutoGenerated: track.kind === "asr"
      },
      segments,
      returned: segments.length,
      requested: Math.max(1, Number(limit || 800))
    };
  }

  function normalizeCommentThread(thread, rank) {
    const comment = thread?.comment;
    if (!comment?.comment_id) return null;
    const likesText = normalizedText(comment.like_count);
    const replyCountText = normalizedText(comment.reply_count_a11y) || normalizedText(comment.reply_count);
    const knownReplies = Array.isArray(thread.replies) ? thread.replies : null;
    return {
      rank,
      commentId: comment.comment_id,
      author: { name: comment.author?.name || null, channelId: comment.author?.id || null },
      text: comment.content?.text || "",
      // youtubei.js provides relative display text, but not a trustworthy
      // absolute timestamp for every comment. Keep the distinction explicit.
      publishedAt: null,
      publishedText: normalizedText(comment.published_time),
      likes: parseYouTubeCount(comment.like_count_a11y ?? likesText),
      likesText,
      replyCount: parseYouTubeCount(comment.reply_count_a11y ?? comment.reply_count),
      replyCountText,
      isPinned: Boolean(comment.is_pinned),
      isHearted: Boolean(comment.is_hearted),
      hasReplies: Boolean(thread.has_replies),
      authorIsCreator: Boolean(comment.author_is_channel_owner),
      creatorReplied: knownReplies
        ? knownReplies.some((reply) => Boolean(reply?.comment?.author_is_channel_owner))
        : null
    };
  }

  function normalizeReplyThread(thread, rank) {
    const comment = thread?.comment;
    if (!comment?.comment_id) return null;
    const likesText = normalizedText(comment.like_count);
    return {
      rank,
      commentId: comment.comment_id,
      author: { name: comment.author?.name || null, channelId: comment.author?.id || null },
      text: comment.content?.text || "",
      publishedAt: null,
      publishedText: normalizedText(comment.published_time),
      likes: parseYouTubeCount(comment.like_count_a11y ?? likesText),
      likesText,
      authorIsCreator: Boolean(comment.author_is_channel_owner),
      isHearted: Boolean(comment.is_hearted)
    };
  }

  function normalizedText(value) {
    const text = String(value?.toString?.() ?? value ?? "").trim();
    return text || null;
  }

  function parseYouTubeCount(value) {
    const text = normalizedText(value);
    if (!text) return null;
    const compact = text.replace(/[\u00A0\u202F\s]/g, "");
    const suffix = compact.match(/(\d+(?:[.,]\d+)?)\s*([KMBT])\b/i);
    if (suffix) {
      const amount = Number(suffix[1].replace(",", "."));
      const multiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000, T: 1_000_000_000_000 }[suffix[2].toUpperCase()];
      return Number.isFinite(amount) && multiplier ? Math.round(amount * multiplier) : null;
    }
    const digits = compact.replace(/\D/g, "");
    return digits ? Number(digits) : null;
  }

  async function loadCommentPages(videoId, sort, limit, wantedCommentId = null) {
    const yt = await getInnertube();
    let page = await yt.getComments(
      videoId,
      sort === "newest" ? "NEWEST_FIRST" : "TOP_COMMENTS"
    );
    const threads = [];
    const seen = new Set();
    let wantedThread = null;

    // A normal page contains about 20 threads. Bound pagination so an MCP call
    // cannot turn into an unbounded crawl.
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      for (const thread of page.contents || []) {
        const id = thread.comment?.comment_id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        threads.push(thread);
        if (id === wantedCommentId) wantedThread = thread;
      }

      if (wantedThread || (!wantedCommentId && threads.length >= limit) || !page.has_continuation) {
        break;
      }
      page = await page.getContinuation();
    }

    return { threads, wantedThread };
  }

  async function getCommentsWithYtjs({ videoId, limit, sort }) {
    const { threads } = await loadCommentPages(videoId, sort, limit);
    const comments = threads
      .map((thread, index) => normalizeCommentThread(thread, index + 1))
      .filter(Boolean)
      .slice(0, limit);

    return {
      videoId,
      sortRequested: sort,
      comments,
      returned: comments.length,
      requested: limit
    };
  }

  async function getCommentRepliesWithYtjs({ videoId, commentId, limit }) {
    const { wantedThread } = await loadCommentPages(videoId, "top", limit, commentId);
    if (!wantedThread) {
      throw new Error("The requested comment was not found in the first 10 comment pages");
    }
    const parent = normalizeCommentThread(wantedThread, 1);
    const totalReplies = parent.replyCount;
    if (!wantedThread.has_replies) {
      return { videoId, parentCommentId: commentId, parent: parentSummary(parent), replies: [], returned: 0, requested: limit, totalReplies };
    }

    await wantedThread.getReplies();
    const replyThreads = [];
    const seen = new Set();
    let continuation = null;

    const appendReplies = (threads) => {
      for (const thread of threads || []) {
        const id = thread.comment?.comment_id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        replyThreads.push(thread);
      }
    };

    appendReplies(wantedThread.replies);
    if (wantedThread.has_continuation) {
      continuation = await wantedThread.getContinuation();
    }
    while (continuation && replyThreads.length < limit) {
      appendReplies(continuation.replies);
      continuation = continuation.has_continuation
        ? await continuation.getContinuation()
        : null;
    }

    const replies = replyThreads
      .map((thread, index) => normalizeReplyThread(thread, index + 1))
      .filter(Boolean)
      .slice(0, limit);

    return {
      videoId,
      parentCommentId: commentId,
      parent: parentSummary(parent),
      replies,
      returned: replies.length,
      requested: limit,
      totalReplies
    };
  }

  function parentSummary(comment) {
    return {
      commentId: comment.commentId,
      text: comment.text,
      likes: comment.likes,
      likesText: comment.likesText,
      replyCount: comment.replyCount,
      replyCountText: comment.replyCountText
    };
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.source !== COMMAND_SOURCE || message.type !== "command" || !message.id) return;
    try {
      let data;
      if (message.action === "page-state") data = pageState();
      else if (message.action === "transcript-player") data = await getTranscriptFromPlayer(message.payload || {});
      else if (message.action === "network-after") data = { responses: responseLog.filter((response) => response.at >= Number(message.payload?.after ?? 0)) };
      else if (message.action === "comments-ytjs") data = await getCommentsWithYtjs(message.payload || {});
      else if (message.action === "replies-ytjs") data = await getCommentRepliesWithYtjs(message.payload || {});
      else throw new Error("Unsupported MAIN-world bridge action");
      post("command-result", { id: message.id, ok: true, data });
    } catch (error) {
      post("command-result", { id: message.id, ok: false, error: String(error?.message || error) });
    }
  });

  post("ready", { at: Date.now() });
})();
