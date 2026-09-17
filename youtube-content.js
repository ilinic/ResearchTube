if (!globalThis.__youtubeResearchContentBridgeInstalled) {
globalThis.__youtubeResearchContentBridgeInstalled = true;

const MAIN_BRIDGE_SOURCE = "researchtube-page-bridge";
const CONTENT_SOURCE = "researchtube-extension-content";
const pendingMainWorldCalls = new Map();

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const message = event.data;
  if (message?.source !== MAIN_BRIDGE_SOURCE) return;
  if (message.type === "command-result") {
    const pending = pendingMainWorldCalls.get(message.payload?.id);
    if (!pending) return;
    pendingMainWorldCalls.delete(message.payload.id);
    if (message.payload.ok) pending.resolve(message.payload.data);
    else pending.reject(new Error(message.payload.error || "MAIN-world bridge command failed"));
    return;
  }
  // Network-response messages are intentionally ignored. They were used only
  // by a removed UI-transcript diagnostic path; forwarding them from an old
  // content script after an extension reload causes "context invalidated".
});

function callMainWorld(action, payload = {}, timeoutMs = 20_000) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingMainWorldCalls.delete(id);
      reject(new Error(`MAIN-world bridge timed out while running ${action}`));
    }, timeoutMs);
    pendingMainWorldCalls.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
    window.postMessage({ source: CONTENT_SOURCE, type: "command", id, action, payload }, location.origin);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "youtube-ui-tool") return false;
  runUiTool(message).then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({ ok: false, error: String(error?.message ?? error) })
  );
  return true;
});

async function runUiTool({ action, videoId, args }) {
  if (action === "bridge-version") return { version: "1.2.8" };
  if (action === "page-state") return waitForPageData();
  if (action === "transcript") return callMainWorld("transcript-player", { videoId, ...args }, 45_000);
  if (action === "comments") return callMainWorld("comments-ytjs", { videoId, ...args }, 60_000);
  if (action === "replies") return callMainWorld("replies-ytjs", { videoId, ...args }, 60_000);
  await waitFor(() => document.querySelector("ytd-watch-flexy"), 45000, "The YouTube watch page did not finish loading in the worker window");
  if (action === "transcript-debug") return getTranscriptDebug();
  throw new Error(`Unsupported YouTube UI action: ${action}`);
}

async function waitForPageData(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const state = await callMainWorld("page-state", {}, 5_000);
      if (state?.ready) return state;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`YouTube page data did not become ready${lastError ? `: ${String(lastError.message || lastError)}` : ""}`);
}

async function getTranscript(videoId, { language, limit }) {
  const activation = await openTranscriptPanel();
  if (!activation.ok) throw new Error("The YouTube Show transcript control was not found");
  await waitFor(() => transcriptSegmentElements().length, 20000, "Show transcript was clicked, but YouTube did not render transcript segments");
  const segments = await collectTranscriptUntil(limit);
  if (!segments.length) throw new Error("The Show transcript panel opened but has no readable segments");
  return {
    videoId,
    languageRequested: language || null,
    selectedTrack: { language: language || null, name: "YouTube Show transcript", generated: null },
    segments,
    returned: segments.length,
    requested: limit
  };
}

async function openTranscriptPanel() {
  // YouTube keeps desktop, compact, and detached engagement-panel copies of
  // this control in the document. A text match alone can select a hidden
  // template node, so expand the description first and use only visible nodes.
  let button = findTranscriptButton();
  if (!button) {
    const expand = findVisibleElement("ytd-watch-metadata #expand, ytd-text-inline-expander #expand, #description-inline-expander #expand");
    if (expand) {
      activateControl(expand);
      await waitFor(() => findTranscriptButton(), 5000).catch(() => null);
    }
    button = findTranscriptButton();
  }
  if (!button) {
    const transcriptSection = [...document.querySelectorAll("ytd-video-description-transcript-section-renderer")].find(isVisible);
    button = transcriptSection ? findTranscriptButton(transcriptSection) : null;
  }
  if (!button) {
    const candidates = [...document.querySelectorAll("button, yt-button-shape, ytd-button-renderer, ytd-menu-service-item-renderer")].filter(isVisible);
    const more = candidates.find((element) => /more actions|more|ещ[её]/i.test(`${element.textContent || ""} ${element.getAttribute("aria-label") || ""}`));
    if (more) { activateControl(more); await sleep(400); button = findTranscriptButton(); }
  }
  if (!button) return { ok: false, target: null };
  const target = activateControl(button);
  // Do not make the caller wait for rendered DOM rows. The normal YouTube
  // request is the source of truth and is captured independently below.
  await waitFor(() => transcriptPanelIsOpen(), 4_000).catch(() => null);
  return { ok: true, target };
}

function getTranscriptDebug() {
  const describe = (element) => ({
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    text: compactText(element.textContent),
    ariaLabel: element.getAttribute("aria-label"),
    title: element.getAttribute("title"),
    visible: isVisible(element)
  });
  const candidates = [...document.querySelectorAll("button, yt-button-shape, ytd-button-renderer, ytd-menu-service-item-renderer, a, [role='button']")]
    .filter((element) => {
      const label = `${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`;
      return /transcript|transcription|captions|subtitles|description|more|ещ[её]|субтитр|расшифров/i.test(label);
    })
    .slice(0, 80)
    .map(describe);
  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    controls: {
      transcriptButtonFound: Boolean(findTranscriptButton()),
      transcriptSectionPresent: Boolean(document.querySelector("ytd-video-description-transcript-section-renderer")),
      transcriptSegmentsPresent: transcriptSegmentElements().length,
      descriptionExpandPresent: Boolean(document.querySelector("ytd-watch-metadata #expand, ytd-text-inline-expander #expand, #description-inline-expander #expand"))
    },
    candidates
  };
}

function compactText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function isVisible(element) {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) return false;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const parentStyle = getComputedStyle(parent);
    if (parentStyle.display === "none" || parentStyle.visibility === "hidden") return false;
  }
  return true;
}

function findTranscriptButton(root = document) {
  const matcher = /show transcript|показать (транскрипт|расшифровку)|транскрипт/i;
  const labelled = [...root.querySelectorAll("button, yt-button-shape, ytd-button-renderer, ytd-menu-service-item-renderer, a, [role='button']")]
    .find((element) => isVisible(element) && matcher.test(`${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`));
  return labelled ? interactiveChild(labelled) : null;
}

function findVisibleElement(selector, root = document) {
  return [...root.querySelectorAll(selector)].find(isVisible) ?? null;
}

function interactiveChild(element) {
  const choices = [
    element.matches("button, a, [role='button']") ? element : null,
    element.querySelector?.("button, a, [role='button']") ?? null,
    element.shadowRoot?.querySelector?.("button, a, [role='button']") ?? null,
    element.closest?.("button, a, [role='button']") ?? null
  ].filter(Boolean);
  return choices.find(isVisible) ?? choices[0] ?? element;
}

function activateControl(element) {
  const target = interactiveChild(element);
  target.scrollIntoView({ behavior: "instant", block: "center" });
  target.focus?.({ preventScroll: true });
  // A single native HTMLElement.click() is deliberate. The earlier sequence
  // of synthetic mouse events could activate the wrong custom-element host or
  // cause duplicate handlers; it cannot turn into a trusted user event.
  target.click();
  return `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}`;
}

function transcriptPanelIsOpen() {
  return [...document.querySelectorAll("ytd-engagement-panel-section-list-renderer, ytd-transcript-search-panel-renderer, ytd-transcript-segment-list-renderer, button")]
    .some((element) => isVisible(element) && /transcript|close transcript/i.test(`${element.getAttribute("target-id") || ""} ${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`));
}

async function collectTranscriptUntil(limit) {
  let segments = collectTranscriptSegments();
  let unchanged = 0;
  for (let attempt = 0; segments.length < limit && attempt < 30 && unchanged < 4; attempt += 1) {
    const list = document.querySelector("ytd-transcript-segment-list-renderer") || document.querySelector("ytd-transcript-search-panel-renderer") || document.querySelector("ytd-engagement-panel-section-list-renderer");
    const last = transcriptSegmentElements().at(-1);
    (last ?? list)?.scrollIntoView({ behavior: "instant", block: "end" });
    if (list) list.scrollTop = list.scrollHeight;
    await sleep(350);
    const next = collectTranscriptSegments();
    unchanged = next.length === segments.length ? unchanged + 1 : 0;
    segments = next;
  }
  return segments.slice(0, limit);
}

function collectTranscriptSegments() {
  return transcriptSegmentElements().map((segment) => {
    const timeText = segment.querySelector("#segment-timestamp, .segment-timestamp, [class*='timestamp']")?.textContent?.trim() || "";
    const text = segment.querySelector("#segment-text, .segment-text, [class*='segment-text'], yt-formatted-string")?.textContent?.replace(/\s+/g, " ").trim() || "";
    return { start: parseTimestamp(timeText), duration: null, text };
  }).filter((segment) => segment.text);
}

function transcriptSegmentElements() {
  return [...document.querySelectorAll("ytd-transcript-segment-renderer, ytd-transcript-segment-view-model")];
}

function parseTimestamp(value) {
  const parts = value.split(":").map(Number);
  if (!parts.length || parts.some((part) => Number.isNaN(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

async function getComments(videoId, { limit, sort }) {
  await loadCommentsArea();
  const sortApplied = await applySort(sort);
  const comments = await collectUntil(limit, () => collectTopLevelComments());
  return { videoId, sortRequested: sort, sortApplied, comments, returned: comments.length, requested: limit };
}

async function getReplies(videoId, { commentId, limit }) {
  await loadCommentsArea();
  let thread = findThreadByCommentId(commentId);
  for (let attempt = 0; !thread && attempt < 8; attempt += 1) {
    window.scrollBy({ top: 1000, behavior: "instant" });
    await sleep(500);
    thread = findThreadByCommentId(commentId);
  }
  if (!thread) throw new Error("The requested comment was not found in the currently loaded comments");

  await expandReplies(thread, limit);
  const replies = await collectUntil(limit, () => collectReplies(thread));
  return { videoId, commentId, replies, returned: replies.length, requested: limit };
}

async function loadCommentsArea() {
  await waitFor(() => document.querySelector("ytd-watch-flexy"), 30000);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const comments = document.querySelector("ytd-comments");
    if (comments) {
      comments.scrollIntoView({ behavior: "instant", block: "start" });
      await sleep(700);
      if (document.querySelector("ytd-comment-thread-renderer") || document.querySelector("ytd-comments #message")) return;
    }
    window.scrollBy({ top: Math.max(900, window.innerHeight * 0.9), behavior: "instant" });
    await sleep(900);
  }
  throw new Error("YouTube comments did not load; comments may be disabled or consent may be required");
}

async function applySort(sort) {
  if (sort !== "newest") return true;
  const button = document.querySelector("ytd-comments-header-renderer #sort-menu");
  if (!button) return false;
  button.click();
  await sleep(250);
  const choices = [...document.querySelectorAll("tp-yt-paper-listbox ytd-menu-service-item-renderer")];
  if (choices.length < 2) return false;
  choices[1].click();
  await sleep(900);
  return true;
}

async function collectUntil(limit, collect) {
  let rows = collect();
  let unchanged = 0;
  for (let attempt = 0; rows.length < limit && attempt < 20 && unchanged < 3; attempt += 1) {
    const before = rows.length;
    const last = document.querySelector("ytd-comment-thread-renderer:last-of-type, ytd-comment-replies-renderer ytd-comment-renderer:last-of-type");
    (last ?? document.documentElement).scrollIntoView({ behavior: "instant", block: "end" });
    window.scrollBy({ top: 850, behavior: "instant" });
    await sleep(550);
    rows = collect();
    unchanged = rows.length === before ? unchanged + 1 : 0;
  }
  return rows.slice(0, limit);
}

function collectTopLevelComments() {
  const seen = new Set();
  return [...document.querySelectorAll("ytd-comment-thread-renderer")]
    .map((thread) => normalizeComment(thread.querySelector("ytd-comment-view-model, ytd-comment-renderer"), thread))
    .filter((item) => item && !seen.has(item.commentId) && seen.add(item.commentId));
}

function collectReplies(thread) {
  const seen = new Set();
  return [...thread.querySelectorAll("ytd-comment-replies-renderer ytd-comment-view-model, ytd-comment-replies-renderer ytd-comment-renderer")]
    .map((comment) => normalizeComment(comment, comment))
    .filter((item) => item && !seen.has(item.commentId) && seen.add(item.commentId));
}

async function expandReplies(thread, limit) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const button = [...thread.querySelectorAll("#more-replies, ytd-button-renderer")].find((element) => /repl/i.test(element.textContent || ""));
    if (!button) return;
    button.click();
    await sleep(600);
    if (collectReplies(thread).length >= limit) return;
  }
}

function findThreadByCommentId(commentId) {
  return [...document.querySelectorAll("ytd-comment-thread-renderer")].find((thread) => getCommentId(thread) === commentId) ?? null;
}

}

function normalizeComment(comment, root) {
  if (!comment) return null;
  const commentId = getCommentId(root);
  if (!commentId) return null;
  const text = (selector) => root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() || "";
  return {
    commentId,
    author: text("#author-text") || null,
    text: text("#content-text") || null,
    likes: text("#vote-count-middle") || null,
    published: text("#published-time-text") || null,
    replyCount: text("#more-replies") || null,
    hasReplies: Boolean(root.querySelector("#more-replies"))
  };
}

function getCommentId(root) {
  const link = [...root.querySelectorAll("a[href*='lc=']")].find((element) => element.href);
  if (!link) return null;
  try { return new URL(link.href).searchParams.get("lc"); } catch { return null; }
}

async function waitFor(test, timeout, message = "Timed out waiting for YouTube page content") {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = test();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(message);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
