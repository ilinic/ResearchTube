import { Innertube, Parser } from "youtubei.js";

// Runs in YouTube's MAIN JavaScript world. It deliberately never reads or
// exports cookies. It observes the same JSON responses used by the page and
// can perform a narrowly scoped timed-text request in the page's own origin.
(() => {
  if (window.__youtubeResearchPageBridgeInstalled) return;
  window.__youtubeResearchPageBridgeInstalled = true;

  // YouTube occasionally adds an otherwise harmless renderer to comment
  // responses before youtubei.js has a compiled parser for it. The library
  // JIT-generates this exact class and continues normally, so its default
  // "report this bug" console warning is not actionable for an extension
  // user. Use the library's parser hook rather than replacing console.warn,
  // and keep every other parser diagnostic visible.
  Parser.setParserErrorHandler((error) => {
    if (error?.error_type === "class_not_found" && error.classname === "CommentFilterContextView") {
      return;
    }
    console.warn("[ResearchTube][YouTube.js parser]", error);
  });

  const SOURCE = "researchtube-page-bridge";
  const COMMAND_SOURCE = "researchtube-extension-content";
  const originalFetch = window.fetch.bind(window);
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const responseLog = [];
  let innertubePromise = null;

  function isRelevant(url) {
    return /\/(?:watch|results)(?:\?|$)|\/youtubei\/v1\/|\/api\/timedtext(?:\?|$)/.test(url);
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
    // This is deliberately metadata only. Do not retain transcript or comment
    // bodies in the page, extension, or diagnostic export.
    const payload = {
      url, method, status: response.status, responseType: response.type,
      redirected: response.redirected
    };
    rememberResponse(payload);
    post("network-response", payload);
  }

  async function observedFetch(input, init = {}) {
    const response = await originalFetch(input, init);
    captureResponse(urlFrom(input), response, String(init.method || "GET").toUpperCase());
    return response;
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
      if (!this.__youtubeResearchUrl || !isRelevant(this.__youtubeResearchUrl)) return;
      const payload = {
        url: this.__youtubeResearchUrl,
        method: String(this.__youtubeResearchMethod || "GET").toUpperCase(),
        status: this.status,
        responseType: this.responseType || "",
        redirected: false
      };
      rememberResponse(payload);
      post("network-response", payload);
    }, { once: true });
    return originalXhrSend.apply(this, args);
  };

  function storyboardContext(videoId) {
    let player = null;
    // The live player handles SPA navigation; initial globals may be stale.
    try { player = document.getElementById("movie_player")?.getPlayerResponse?.(); } catch (_) {}
    if (typeof player === "string") { try { player = JSON.parse(player); } catch (_) { player = null; } }
    if (player?.videoDetails?.videoId !== videoId) {
      player = window.ytInitialPlayerResponse || window.ytplayer?.config?.args?.player_response;
      if (typeof player === "string") { try { player = JSON.parse(player); } catch (_) { player = null; } }
    }
    const url = new URL(location.href);
    if ((url.searchParams.get("v") !== videoId && url.pathname !== `/shorts/${videoId}`) || player?.videoDetails?.videoId !== videoId) return null;
    return { videoId, title: player.videoDetails.title || "", durationSeconds: Number(player.videoDetails.lengthSeconds),
      isLive: Boolean(player.videoDetails.isLive || player.videoDetails.isUpcoming || player.storyboards?.playerLiveStoryboardSpecRenderer),
      spec: player.storyboards?.playerStoryboardSpecRenderer?.spec || null };
  }

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
        fetch: (input, init) => observedFetch(input, {
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
    const response = await observedFetch(`/watch?v=${encodeURIComponent(videoId)}`, {
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
  // the requested caption baseUrl. No youtubei.js transcript endpoint is used.
  async function getTranscriptFromPlayer({ videoId, limit, trackIndex = 0 }) {
    const pageHtml = await getAnonymousWatchHtml(videoId);
    const apiKey = pageHtml.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
    if (!apiKey) throw new Error("INNERTUBE_API_KEY was not found in the anonymous YouTube watch page");

    const playerResponse = await observedFetch(`/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
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

    const selectedTrackIndex = Number(trackIndex);
    if (!Number.isInteger(selectedTrackIndex) || selectedTrackIndex < 0 || selectedTrackIndex >= tracks.length) {
      const available = tracks.map((item, index) => `${index}: ${item.languageCode || "unknown"} (${textOf(item.name) || "unnamed"})`).join(", ");
      throw new Error(`Caption track index ${trackIndex} is unavailable. Available tracks: ${available}`);
    }
    const track = tracks[selectedTrackIndex];
    if (!track?.baseUrl || !isAllowedTimedTextUrl(track.baseUrl)) {
      throw new Error(`Caption track ${selectedTrackIndex} did not contain a valid YouTube timedtext URL`);
    }
    const captionResponse = await observedFetch(track.baseUrl, {
      credentials: "omit",
      cache: "no-store",
    });
    if (!captionResponse.ok) throw new Error(`YouTube timedtext request failed: HTTP ${captionResponse.status}`);
    const segments = parseCaptionResponse(await captionResponse.text())
      .filter((segment) => segment.text)
      .filter(Boolean)
      .slice(0, Math.max(1, Number(limit || 800)));
    if (!segments.length) throw new Error(`Caption track ${selectedTrackIndex} returned no readable timedtext events`);

    return {
      videoId,
      selectedTrack: {
        trackIndex: selectedTrackIndex,
        languageCode: track.languageCode || null,
        name: textOf(track.name) || null,
        isAutoGenerated: track.kind === "asr"
      },
      segments,
      returned: segments.length,
      requested: Math.max(1, Number(limit || 800))
    };
  }

  // Search deliberately uses fetch from the already-open YouTube document.
  // It does not navigate, alter, pause, or otherwise interact with that page.
  // Credentials remain omitted; this is a public-data request, not an account
  // action or a way to use the viewer's YouTube session.
  function searchEndpoint(url) {
    return new URL(url, location.href).pathname.replace("/youtubei/v1/", "youtubei/");
  }

  function isSearchVerificationResponse(response) {
    const responseUrl = String(response.url || "");
    return response.type === "opaqueredirect" || response.status === 0 ||
      (response.status >= 300 && response.status < 400) ||
      response.status === 403 || response.status === 429 ||
      response.redirected || !responseUrl.startsWith("https://www.youtube.com/");
  }

  async function searchFetch(trace, url, init = {}) {
    const requestNumber = trace.filter((item) => item.event === "http_request").length + 1;
    const endpoint = searchEndpoint(url);
    trace.push({ event: "http_request", endpoint, request_number: requestNumber, method: init.method || "GET" });
    try {
      const response = await observedFetch(url, { ...init, credentials: "omit", redirect: "manual" });
      trace.push({
        event: "http_response", endpoint, request_number: requestNumber,
        status: response.status, response_type: response.type, redirected: response.redirected
      });
      return { response, endpoint, requestNumber };
    } catch (error) {
      trace.push({ event: "http_network_error", endpoint, request_number: requestNumber, error: String(error?.message || error).slice(0, 280) });
      throw error;
    }
  }

  function extractSearchJson(text, markers) {
    for (const marker of markers) {
      const start = text.indexOf(marker);
      if (start < 0) continue;
      const objectStart = text.indexOf("{", start + marker.length);
      if (objectStart < 0) continue;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = objectStart; index < text.length; index += 1) {
        const character = text[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') { inString = true; continue; }
        if (character === "{") depth += 1;
        else if (character === "}" && --depth === 0) {
          try { return JSON.parse(text.slice(objectStart, index + 1)); } catch { break; }
        }
      }
    }
    return null;
  }

  function searchConfig(html, key) {
    return html.match(new RegExp(`"${key}":"([^"\\\\]+)"`))?.[1] || null;
  }

  function walkSearchData(value, visitor) {
    visitor(value);
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) walkSearchData(child, visitor);
  }

  function searchText(value) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    return value.simpleText || value.content || value.label ||
      value.runs?.map((run) => run?.text || "").join("") ||
      searchText(value.text) || searchText(value.title) || "";
  }

  function findSearchContinuation(value) {
    let token = null;
    walkSearchData(value, (node) => {
      if (!token) token = node?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || null;
    });
    return token;
  }

  function appendSearchVideos(data, target) {
    walkSearchData(data, (node) => {
      const renderer = node?.videoRenderer;
      if (!renderer?.videoId || target.some((item) => item.videoId === renderer.videoId)) return;
      const viewsText = searchText(renderer.viewCountText) || null;
      target.push({
        videoId: renderer.videoId,
        title: searchText(renderer.title),
        channel: searchText(renderer.ownerText) || searchText(renderer.longBylineText),
        durationText: searchText(renderer.lengthText) || null,
        publishedText: searchText(renderer.publishedTimeText) || null,
        views: parseYouTubeCount(viewsText),
        viewsText,
        snippet: searchText(renderer.detailedMetadataSnippets?.[0]?.snippetText) || searchText(renderer.snippet) || null
      });
    });
  }

  async function searchPublicVideos({ query, limit }) {
    const requested = Math.max(1, Math.min(50, Number(limit || 10)));
    const trace = [];
    const first = await searchFetch(trace, `/results?search_query=${encodeURIComponent(String(query || ""))}`, {
      headers: { Accept: "text/html" }
    });
    if (isSearchVerificationResponse(first.response)) {
      return {
        verification_rejected: true, rejected_endpoint: first.endpoint,
        rejected_status: first.response.status, rejected_response_type: first.response.type,
        diagnostics: trace, results: [], returned: 0, requested, hasMore: false
      };
    }
    if (!first.response.ok) throw new Error(`YouTube search page failed: HTTP ${first.response.status}`);
    const html = await first.response.text();
    const initialData = extractSearchJson(html, ["var ytInitialData =", "ytInitialData ="]);
    if (!initialData) throw new Error("ytInitialData was not found in the YouTube search response");

    const results = [];
    appendSearchVideos(initialData, results);
    const initialResults = results.length;
    let continuation = findSearchContinuation(initialData);
    const apiKey = searchConfig(html, "INNERTUBE_API_KEY") || window.ytcfg?.get?.("INNERTUBE_API_KEY") || null;
    const clientVersion = searchConfig(html, "INNERTUBE_CLIENT_VERSION") || window.ytcfg?.get?.("INNERTUBE_CLIENT_VERSION") || "2.20260101.00.00";
    const visitorData = searchConfig(html, "VISITOR_DATA") || window.ytcfg?.get?.("VISITOR_DATA") || null;
    let continuationRejected = false;

    while (results.length < requested && continuation && apiKey) {
      const next = await searchFetch(trace, `/youtubei/v1/search?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-YouTube-Client-Name": "1", "X-YouTube-Client-Version": clientVersion },
        body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion, ...(visitorData ? { visitorData } : {}) } }, continuation })
      });
      if (isSearchVerificationResponse(next.response)) {
        continuationRejected = true;
        break;
      }
      if (!next.response.ok) break;
      const page = await next.response.json();
      const before = results.length;
      appendSearchVideos(page, results);
      continuation = findSearchContinuation(page);
      if (results.length === before) break;
    }

    return {
      verification_rejected: false,
      diagnostics: trace,
      initial_results: initialResults,
      continuation_available: Boolean(continuation),
      api_key_available: Boolean(apiKey),
      continuation_rejected: continuationRejected,
      results: results.slice(0, requested),
      returned: Math.min(results.length, requested),
      requested,
      hasMore: Boolean(continuation)
    };
  }

  // Channel and playlist catalogues use the same page-context transport as
  // search. These are background fetches only: they never navigate, scroll,
  // pause, or otherwise modify the YouTube document serving as the context.
  function catalogueChannelPath(channel, tab) {
    const raw = String(channel || "").trim();
    if (!raw) throw new Error("channel is required");
    let path;
    if (/^UC[\w-]+$/i.test(raw)) path = `/channel/${raw}`;
    else if (raw.startsWith("@")) path = `/${encodeURI(raw)}`;
    else {
      let url;
      try { url = new URL(raw); } catch { throw new Error("channel must be an @handle, YouTube channel URL, or UC channel ID"); }
      if (!/(^|\.)youtube\.com$/i.test(url.hostname)) throw new Error("channel URL must be on youtube.com");
      path = url.pathname;
    }
    path = path.replace(/\/(videos|playlists|streams|shorts|featured)\/?$/i, "").replace(/\/+$/, "");
    if (!path || path === "/") throw new Error("channel URL does not identify a channel");
    return `${path}/${tab}`;
  }

  function cataloguePlaylistPath(playlist) {
    const raw = String(playlist || "").trim();
    if (!raw) throw new Error("playlist is required");
    let playlistId = null;
    if (/^[A-Za-z0-9_-]+$/.test(raw) && !raw.includes("/")) playlistId = raw;
    else {
      let url;
      try { url = new URL(raw); } catch { throw new Error("playlist must be a playlist ID or a YouTube playlist URL"); }
      if (!/(^|\.)youtube\.com$/i.test(url.hostname)) throw new Error("playlist URL must be on youtube.com");
      playlistId = url.searchParams.get("list");
    }
    if (!playlistId) throw new Error("playlist URL must include a list parameter");
    return `/playlist?list=${encodeURIComponent(playlistId)}`;
  }

  function publicPageFailure(response) {
    const responseUrl = String(response.url || "");
    return response.type === "opaqueredirect" || response.status === 0 ||
      (response.status >= 300 && response.status < 400) || response.status === 403 || response.status === 429 ||
      response.redirected || !responseUrl.startsWith("https://www.youtube.com/");
  }

  async function loadCataloguePage(path) {
    const response = await observedFetch(path, {
      credentials: "omit", redirect: "manual", headers: { Accept: "text/html" }
    });
    if (publicPageFailure(response)) {
      throw new Error(`YouTube rejected the public catalogue page (HTTP ${response.status || 0})`);
    }
    if (!response.ok) throw new Error(`YouTube catalogue page failed: HTTP ${response.status}`);
    const html = await response.text();
    const data = extractSearchJson(html, ["var ytInitialData =", "ytInitialData ="]);
    if (!data) throw new Error("ytInitialData was not found in the YouTube catalogue response");
    return {
      data,
      apiKey: searchConfig(html, "INNERTUBE_API_KEY") || window.ytcfg?.get?.("INNERTUBE_API_KEY") || null,
      clientVersion: searchConfig(html, "INNERTUBE_CLIENT_VERSION") || window.ytcfg?.get?.("INNERTUBE_CLIENT_VERSION") || "2.20260101.00.00",
      visitorData: searchConfig(html, "VISITOR_DATA") || window.ytcfg?.get?.("VISITOR_DATA") || null
    };
  }

  async function loadCatalogueContinuation(continuation, config) {
    if (!config.apiKey) throw new Error("YouTube did not provide an Innertube key for this catalogue continuation");
    const response = await observedFetch(`/youtubei/v1/browse?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`, {
      method: "POST",
      credentials: "omit",
      redirect: "manual",
      headers: { "Content-Type": "application/json", "X-YouTube-Client-Name": "1", "X-YouTube-Client-Version": config.clientVersion },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: config.clientVersion, ...(config.visitorData ? { visitorData: config.visitorData } : {}) } },
        continuation
      })
    });
    if (publicPageFailure(response)) throw new Error(`YouTube rejected the public catalogue continuation (HTTP ${response.status || 0})`);
    if (!response.ok) throw new Error(`YouTube catalogue continuation failed: HTTP ${response.status}`);
    return response.json();
  }

  function channelIdentity(data, channel) {
    const identity = { id: null, name: null, handle: null };
    walkSearchData(data, (node) => {
      const header = node?.c4TabbedHeaderRenderer || node?.pageHeaderRenderer?.content?.pageHeaderViewModel || null;
      const metadata = node?.channelMetadataRenderer || null;
      if (header) {
        identity.id ||= header.channelId || null;
        identity.name ||= searchText(header.title) || null;
        identity.handle ||= searchText(header.channelHandleText) || null;
      }
      if (metadata) {
        identity.id ||= metadata.externalId || null;
        identity.name ||= metadata.title || null;
        if (!identity.handle && metadata.vanityChannelUrl) {
          const match = String(metadata.vanityChannelUrl).match(/\/(%40|@)([^/?#]+)/i);
          identity.handle = match ? `@${decodeURIComponent(match[2])}` : null;
        }
      }
    });
    if (!identity.handle && String(channel || "").trim().startsWith("@")) identity.handle = String(channel).trim();
    if (!identity.id && /^UC[\w-]+$/i.test(String(channel || "").trim())) identity.id = String(channel).trim();
    return identity;
  }

  function durationSeconds(value) {
    const text = String(value || "").trim();
    if (!/^\d+(?::\d+){1,2}$/.test(text)) return null;
    const parts = text.split(":").map(Number);
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  function rendererText(renderer, ...keys) {
    for (const key of keys) {
      const text = searchText(renderer?.[key]);
      if (text) return text;
    }
    return "";
  }

  function nestedCommand(value) {
    return value?.innertubeCommand || value?.command || value || null;
  }

  function rendererWatchEndpoint(renderer) {
    const candidates = [
      renderer?.navigationEndpoint,
      renderer?.endpoint,
      nestedCommand(renderer?.onTap),
      nestedCommand(renderer?.rendererContext?.commandContext?.onTap)
    ];
    return candidates.map((candidate) => candidate?.watchEndpoint).find(Boolean) || null;
  }

  function rendererBrowseEndpoint(renderer) {
    const candidates = [
      renderer?.navigationEndpoint,
      renderer?.endpoint,
      nestedCommand(renderer?.onTap),
      nestedCommand(renderer?.rendererContext?.commandContext?.onTap)
    ];
    return candidates.map((candidate) => candidate?.browseEndpoint).find(Boolean) || null;
  }

  function lockupMetadata(renderer) {
    return renderer?.metadata?.lockupMetadataViewModel || renderer?.lockupMetadataViewModel || null;
  }

  function metadataTextParts(renderer) {
    const parts = [];
    const seen = new Set();
    const add = (value) => {
      const text = searchText(value).replace(/\s+/g, " ").trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        parts.push(text);
      }
    };
    const metadata = lockupMetadata(renderer);
    add(metadata?.title);
    walkSearchData(metadata?.metadata, (node) => {
      // Current lockup cards split a single display row into several parts,
      // e.g. ["69K", "views"] or ["24", "videos"]. Keep the joined row
      // before its individual parts so count parsing receives the full label.
      if (Array.isArray(node?.metadataParts)) {
        add(node.metadataParts.map((part) => searchText(part?.text)).filter(Boolean).join(" "));
      }
      if (node?.content) add(node.content);
      if (node?.simpleText || node?.runs) add(node);
    });
    return parts;
  }

  function firstMetadataMatch(renderer, expression) {
    for (const text of metadataTextParts(renderer)) {
      const match = text.match(expression);
      if (match) return match[0];
    }
    return null;
  }

  function rendererVideoId(renderer) {
    const watch = rendererWatchEndpoint(renderer);
    const direct = renderer?.videoId || watch?.videoId || null;
    if (direct) return direct;
    return /VIDEO/i.test(String(renderer?.contentType || "")) ? renderer?.contentId || null : null;
  }

  function rendererTitle(renderer) {
    return rendererText(renderer, "title") || searchText(lockupMetadata(renderer)?.title) ||
      searchText(renderer?.headline) || "";
  }

  function rendererThumbnailSources(renderer) {
    return renderer?.thumbnail?.thumbnails ||
      renderer?.thumbnailRenderer?.playlistVideoThumbnailRenderer?.thumbnail?.thumbnails ||
      renderer?.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources ||
      renderer?.contentImage?.thumbnailViewModel?.image?.sources || [];
  }

  function rendererDurationText(renderer) {
    const direct = rendererText(renderer, "lengthText");
    if (direct) return direct;
    let duration = null;
    // Legacy cards use thumbnailOverlays; lockup cards keep the same data
    // below contentImage. Search both narrow image subtrees, never the title
    // or all metadata, so a timestamp-looking title cannot be mistaken for a
    // duration.
    walkSearchData([renderer?.thumbnailOverlays, renderer?.contentImage], (node) => {
      if (duration) return;
      for (const value of [node?.text, node?.accessibility?.accessibilityData?.label, node?.accessibilityText]) {
        const text = searchText(value);
        if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) {
          duration = text;
          return;
        }
      }
    });
    return duration;
  }

  function textMatchIn(value, expression) {
    let matched = null;
    walkSearchData(value, (node) => {
      if (matched) return;
      const candidates = [
        typeof node === "string" ? node : null,
        node?.content,
        node?.simpleText,
        node?.runs ? node : null,
        node?.text,
        node?.label,
        node?.accessibilityText,
        node?.accessibility?.accessibilityData?.label
      ];
      for (const candidate of candidates) {
        const text = searchText(candidate).replace(/\s+/g, " ").trim();
        const match = text.match(expression);
        if (match) {
          matched = match[0];
          return;
        }
      }
    });
    return matched;
  }

  function rendererPlaylistVideoCountText(renderer) {
    const direct = rendererText(renderer, "videoCountText", "videoCountShortText", "videoCount", "viewPlaylistText");
    if (direct) return direct;
    const label = /\b\d+(?:[,.]\d+)?\s*[KMBT]?\s+(?:videos?|видео)\b/i;
    return firstMetadataMatch(renderer, label) ||
      textMatchIn([renderer?.contentImage, renderer?.thumbnail, renderer?.thumbnailRenderer, renderer?.thumbnailOverlays], label) || null;
  }

  function rendererBadges(renderer) {
    const values = [
      ...(renderer?.badges || []), ...(renderer?.ownerBadges || []), ...(renderer?.thumbnailOverlays || [])
    ];
    return values.map((value) => JSON.stringify(value)).join(" ").toLowerCase();
  }

  function rendererUrl(renderer) {
    const watch = rendererWatchEndpoint(renderer);
    return renderer?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url ||
      renderer?.endpoint?.commandMetadata?.webCommandMetadata?.url ||
      nestedCommand(renderer?.onTap)?.commandMetadata?.webCommandMetadata?.url ||
      watch?.videoId && `/watch?v=${watch.videoId}` || "";
  }

  function appendCatalogueVideos(data, target, { includeShorts = true, includeStreams = true, playlist = false, channelName = null } = {}) {
    walkSearchData(data, (node) => {
      const renderer = playlist
        ? (node?.playlistVideoRenderer || node?.playlistPanelVideoRenderer || node?.lockupViewModel)
        : (node?.gridVideoRenderer || node?.videoRenderer || node?.lockupViewModel);
      const videoId = rendererVideoId(renderer);
      if (!videoId || target.some((item) => item.videoId === videoId)) return;
      const urlPath = rendererUrl(renderer);
      const metadata = metadataTextParts(renderer).join(" ");
      const badges = `${rendererBadges(renderer)} ${metadata}`.toLowerCase();
      const isShort = /\/shorts\//i.test(urlPath) || /shorts/.test(badges);
      const isLive = /\blive\b|upcoming|streamed|premiered/.test(badges) || /\blive\b|upcoming/i.test(rendererText(renderer, "thumbnailOverlays"));
      if ((!includeShorts && isShort) || (!includeStreams && isLive)) return;
      const durationText = rendererDurationText(renderer) || firstMetadataMatch(renderer, /\b\d{1,2}:\d{2}(?::\d{2})?\b/) || null;
      const viewsText = rendererText(renderer, "viewCountText", "shortViewCountText") || firstMetadataMatch(renderer, /\b\d+(?:[.,]\d+)?\s*[KMBT]?\s*(?:views?|просмотров?)\b/i) || null;
      const rawPosition = playlist ? (renderer?.index ?? rendererWatchEndpoint(renderer)?.index ?? renderer?.playlistIndex ?? "") : "";
      const positionText = typeof rawPosition === "number" ? String(rawPosition) : (searchText(rawPosition) || String(rawPosition || ""));
      const position = /^\d+$/.test(positionText) ? Number(positionText) : null;
      target.push({
        videoId,
        title: rendererTitle(renderer),
        channel: rendererText(renderer, "shortBylineText", "longBylineText", "ownerText") || channelName,
        position,
        durationSeconds: durationSeconds(durationText),
        durationText,
        publishedAt: null,
        publishedText: rendererText(renderer, "publishedTimeText") || firstMetadataMatch(renderer, /\b(?:streamed|premiered)\b|\b\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b|\b\d+\s+(?:минут[аы]?|час(?:а|ов)?|дн(?:я|ей)|недел[ьяи]|месяц(?:а|ев)?|год(?:а|лет))\s+назад\b/i) || null,
        views: parseYouTubeCount(viewsText),
        viewsText,
        isShort,
        isLive
      });
    });
  }

  function playlistIdFromRenderer(renderer) {
    const candidates = [
      renderer?.playlistId,
      /PLAYLIST/i.test(String(renderer?.contentType || "")) ? renderer?.contentId : null,
      renderer?.navigationEndpoint?.watchEndpoint?.playlistId,
      renderer?.navigationEndpoint?.browseEndpoint?.browseId,
      renderer?.endpoint?.watchEndpoint?.playlistId,
      renderer?.onTap?.innertubeCommand?.watchEndpoint?.playlistId,
      renderer?.onTap?.innertubeCommand?.browseEndpoint?.browseId,
      rendererBrowseEndpoint(renderer)?.browseId
    ];
    const id = candidates.find((candidate) => typeof candidate === "string" && candidate);
    return id?.startsWith("VL") ? id.slice(2) : id || null;
  }

  function appendChannelPlaylists(data, target) {
    walkSearchData(data, (node) => {
      const renderer = node?.gridPlaylistRenderer || node?.playlistRenderer || node?.lockupViewModel || null;
      const playlistId = playlistIdFromRenderer(renderer);
      if (!playlistId || target.some((item) => item.playlistId === playlistId)) return;
      const videoCountText = rendererPlaylistVideoCountText(renderer);
      const thumbnails = rendererThumbnailSources(renderer);
      target.push({
        playlistId,
        title: rendererTitle(renderer),
        videoCount: parseYouTubeCount(videoCountText),
        videoCountText,
        thumbnailUrl: thumbnails.at(-1)?.url || null
      });
    });
  }

  function playlistIdentity(data, playlist) {
    const identity = { id: playlist, title: null, channelId: null, channelName: null };
    walkSearchData(data, (node) => {
      const header = node?.playlistHeaderRenderer || node?.playlistHeaderViewModel ||
        node?.playlistSidebarPrimaryInfoRenderer || node?.playlistMetadataRenderer || null;
      if (header) {
        identity.title ||= rendererTitle(header) || rendererText(header, "title");
        identity.channelName ||= rendererText(header, "ownerText", "ownerName", "author", "byline") || null;
        identity.channelId ||= header?.ownerEndpoint?.browseEndpoint?.browseId || header?.owner?.browseEndpoint?.browseId || rendererBrowseEndpoint(header)?.browseId || null;
      }
      const owner = node?.videoOwnerRenderer || node?.owner?.videoOwnerRenderer || null;
      if (owner) {
        identity.channelName ||= rendererText(owner, "title") || null;
        identity.channelId ||= rendererBrowseEndpoint(owner)?.browseId || null;
      }
      const metadata = node?.playlistMetadataRenderer || null;
      if (metadata) {
        identity.title ||= rendererText(metadata, "title") || null;
        identity.channelName ||= rendererText(metadata, "owner") || null;
      }
      const microformat = node?.microformatDataRenderer || null;
      if (microformat) {
        identity.title ||= rendererText(microformat, "title") || null;
        identity.channelName ||= microformat.ownerChannelName || null;
        identity.channelId ||= microformat.externalChannelId || null;
      }
    });
    return identity;
  }

  function playlistIdFromInput(value) {
    const raw = String(value || "").trim();
    if (/^[A-Za-z0-9_-]+$/.test(raw) && !raw.includes("/")) return raw;
    try { return new URL(raw).searchParams.get("list") || raw; } catch { return raw; }
  }

  async function pageThroughCatalogue({ config, firstData, continuation, requested, append }) {
    let next = continuation || findSearchContinuation(firstData);
    for (let pageNumber = 0; pageNumber < 10 && next && append.count() < requested; pageNumber += 1) {
      const page = await loadCatalogueContinuation(next, config);
      append.page(page);
      const following = findSearchContinuation(page);
      if (!following || following === next) { next = null; break; }
      next = following;
    }
    return next || null;
  }

  async function validateCatalogueContinuation(config, continuation, countItems) {
    if (!continuation) return null;
    try {
      const page = await loadCatalogueContinuation(continuation, config);
      return countItems(page) > 0 ? continuation : null;
    } catch {
      // Do not turn a successfully parsed first page into an error merely
      // because this optional look-ahead met a temporary YouTube limit.
      return continuation;
    }
  }

  async function getChannelVideos({ channel, limit, continuation, includeShorts, includeStreams }) {
    const requested = Math.max(1, Math.min(100, Number(limit || 30)));
    const config = await loadCataloguePage(catalogueChannelPath(channel, "videos"));
    const identity = channelIdentity(config.data, channel);
    const videos = [];
    const append = { count: () => videos.length, page: (data) => appendCatalogueVideos(data, videos, { includeShorts, includeStreams, channelName: identity.name }) };
    if (!continuation) append.page(config.data);
    const next = await pageThroughCatalogue({ config, firstData: config.data, continuation, requested, append });
    return { channel: identity, videos: videos.slice(0, requested), returned: Math.min(videos.length, requested), requested, continuation: next };
  }

  async function getChannelPlaylists({ channel, limit, continuation }) {
    const requested = Math.max(1, Math.min(100, Number(limit || 30)));
    const config = await loadCataloguePage(catalogueChannelPath(channel, "playlists"));
    const playlists = [];
    const append = { count: () => playlists.length, page: (data) => appendChannelPlaylists(data, playlists) };
    if (!continuation) append.page(config.data);
    let next = await pageThroughCatalogue({ config, firstData: config.data, continuation, requested, append });
    if (!continuation && next) {
      next = await validateCatalogueContinuation(config, next, (page) => {
        const probe = [];
        appendChannelPlaylists(page, probe);
        return probe.length;
      });
    }
    return { channel: channelIdentity(config.data, channel), playlists: playlists.slice(0, requested), returned: Math.min(playlists.length, requested), requested, continuation: next };
  }

  async function getPlaylistVideos({ playlist, limit, continuation }) {
    const requested = Math.max(1, Math.min(100, Number(limit || 30)));
    const config = await loadCataloguePage(cataloguePlaylistPath(playlist));
    const identity = playlistIdentity(config.data, playlistIdFromInput(playlist));
    const videos = [];
    const append = { count: () => videos.length, page: (data) => appendCatalogueVideos(data, videos, { playlist: true, channelName: identity.channelName }) };
    if (!continuation) append.page(config.data);
    const next = await pageThroughCatalogue({ config, firstData: config.data, continuation, requested, append });
    return { playlist: identity, videos: videos.slice(0, requested), returned: Math.min(videos.length, requested), requested, continuation: next };
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
    // The compact form deliberately removes whitespace, so "1.2M views"
    // becomes "1.2Mviews". YouTube's K/M/B/T abbreviations are uppercase;
    // matching that uppercase suffix avoids treating words such as "minutes"
    // as a multiplier.
    const suffix = compact.match(/(\d+(?:[.,]\d+)?)\s*([KMBT])/);
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
      if (message.action === "storyboard-context") data = storyboardContext(message.payload?.videoId);
      else if (message.action === "page-state") data = pageState();
      else if (message.action === "search") data = await searchPublicVideos(message.payload || {});
      else if (message.action === "channel-videos") data = await getChannelVideos(message.payload || {});
      else if (message.action === "channel-playlists") data = await getChannelPlaylists(message.payload || {});
      else if (message.action === "playlist-videos") data = await getPlaylistVideos(message.payload || {});
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
