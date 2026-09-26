function copyTextWithExecCommand(text) {
  const textEl = document.createElement("textarea");
  textEl.value = text;
  textEl.setAttribute("readonly", "");
  textEl.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0;";
  document.body.append(textEl);
  try {
    textEl.select();
    if (!document.execCommand("copy")) throw new Error("Chrome rejected the clipboard copy command.");
  } finally {
    textEl.remove();
  }
}

const googleTranslateRecordings = new Map();

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function stopGoogleTranslateRecording(taskId, discard = false) {
  const session = googleTranslateRecordings.get(taskId);
  if (!session) return null;
  googleTranslateRecordings.delete(taskId);
  try {
    if (session.recorder && session.recorder.state !== "inactive") {
      const stopped = new Promise(resolve => session.recorder.addEventListener("stop", resolve, { once: true }));
      session.recorder.stop();
      await stopped;
    }
    const blob = session.recorder ? new Blob(session.chunks, { type: session.recorder.mimeType || "audio/webm" }) : null;
    return discard ? null : blob;
  } finally {
    session.source.disconnect();
    session.stream.getTracks().forEach(track => track.stop());
    await session.context.close().catch(() => undefined);
  }
}

async function startGoogleTranslateRecording(message) {
  if (googleTranslateRecordings.has(message.taskId)) await stopGoogleTranslateRecording(message.taskId, true);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: message.streamId } }, video: false
  });
  const context = new AudioContext();
  await context.resume().catch(() => undefined);
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  if (message.relayAudio) source.connect(context.destination);
  const chunks = [];
  const recorder = message.record ? new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" }) : null;
  if (recorder) recorder.addEventListener("dataavailable", event => { if (event.data.size) chunks.push(event.data); });
  recorder?.start(250);
  googleTranslateRecordings.set(message.taskId, { stream, context, source, analyser, recorder, chunks });
}

function audioLevel(analyser) {
  const values = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(values);
  let total = 0;
  for (const value of values) { const delta = (value - 128) / 128; total += delta * delta; }
  return Math.sqrt(total / values.length);
}

async function finishGoogleTranslateRecording(message) {
  const session = googleTranslateRecordings.get(message.taskId);
  if (!session) throw new Error("Google Translate audio capture was not started.");
  const deadline = Date.now() + 60_000;
  let heardAudio = false;
  let quietSince = null;
  while (Date.now() < deadline) {
    const level = audioLevel(session.analyser);
    if (level >= 0.012) { heardAudio = true; quietSince = null; }
    else if (heardAudio) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= 900) break;
    }
    await delay(100);
  }
  if (!heardAudio) {
    await stopGoogleTranslateRecording(message.taskId, true);
    throw new Error("Google Translate produced no tab audio.");
  }
  const blob = await stopGoogleTranslateRecording(message.taskId);
  if (message.uploadUrl) {
    if (!blob || blob.size < 64) throw new Error("Google Translate recording is empty.");
    const response = await fetch(message.uploadUrl, { method: "POST", headers: { "Content-Type": "audio/webm" }, body: blob });
    if (!response.ok) throw new Error("The Local Agent could not save Google Translate audio.");
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "researchtube_copy_capture_frame") {
    try {
      if (message.kind !== "path" || typeof message.text !== "string" || !message.text) {
        throw new Error("A workspace path is required.");
      }
      // Offscreen documents cannot receive focus, so navigator.clipboard is not
      // reliable here. This Chrome extension route copies text using DOM selection.
      copyTextWithExecCommand(message.text);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, message: String(error?.message || error || "Clipboard request failed.") });
    }
    return true;
  }
  if (!String(message?.type || "").startsWith("researchtube_google_translate_")) return undefined;
  (async () => {
    if (typeof message.taskId !== "string" || !message.taskId) throw new Error("Google Translate task ID is required.");
    if (message.type === "researchtube_google_translate_start") {
      if (typeof message.streamId !== "string" || typeof message.record !== "boolean" || typeof message.relayAudio !== "boolean") throw new Error("Google Translate audio capture is invalid.");
      await startGoogleTranslateRecording(message);
    } else if (message.type === "researchtube_google_translate_finish") {
      if (message.uploadUrl !== null && typeof message.uploadUrl !== "string") throw new Error("Google Translate upload URL is invalid.");
      await finishGoogleTranslateRecording(message);
    } else if (message.type === "researchtube_google_translate_stop") {
      await stopGoogleTranslateRecording(message.taskId, true);
    } else {
      throw new Error("Unknown Google Translate audio request.");
    }
    sendResponse({ ok: true });
  })().catch(error => sendResponse({ ok: false, message: String(error?.message || error || "Google Translate audio helper failed.") }));
  return true;
});
