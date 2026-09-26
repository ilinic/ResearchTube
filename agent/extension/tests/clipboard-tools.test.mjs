import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");

for (const tool of ["clipboard_status", "clipboard_get", "clipboard_set"]) {
  assert.match(background, new RegExp(`name: "${tool}"`));
  assert.match(background, new RegExp(`"/clipboard/${tool.slice("clipboard_".length)}"`));
}
assert.match(background, /normalizeClipboardStatusInput/);
assert.match(background, /If revision is supplied and the clipboard changed/);
assert.match(background, /status: "clipboard_changed"/);
assert.match(background, /ok: false, status: "clipboard_changed"/);
assert.match(background, /decoded image pixels, not the file/);
assert.match(background, /clipboard may contain sensitive data/);
assert.match(background, /textBytes/);
assert.doesNotMatch(background, /clipboardHistory/);
console.log("clipboard tools: ok");
