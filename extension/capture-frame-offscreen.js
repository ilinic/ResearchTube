function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function pngClipboardBlob(base64, mimeType) {
  const source = base64ToBlob(base64, mimeType);
  if (mimeType === "image/png") return source;
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("PNG conversion failed.");
    return png;
  } finally {
    bitmap.close?.();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "researchtube_copy_capture_frame") return undefined;
  (async () => {
    if (message.kind === "path") {
      if (typeof message.text !== "string" || !message.text) throw new Error("A workspace path is required.");
      await navigator.clipboard.writeText(message.text);
    } else if (message.kind === "image") {
      if (typeof message.base64 !== "string" || !message.base64 || !["image/png", "image/jpeg", "image/webp"].includes(message.mimeType)) {
        throw new Error("A supported captured image is required.");
      }
      const png = await pngClipboardBlob(message.base64, message.mimeType);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    } else {
      throw new Error("Unsupported clipboard request.");
    }
    sendResponse({ ok: true });
  })().catch((error) => sendResponse({ ok: false, message: String(error?.message || error || "Clipboard request failed.") }));
  return true;
});
