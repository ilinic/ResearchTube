import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [background, manifest] = await Promise.all([
  readFile(new URL("../background.js", import.meta.url), "utf8"),
  readFile(new URL("../manifest.json", import.meta.url), "utf8")
]);
const parsedManifest = JSON.parse(manifest);

assert.ok(parsedManifest.permissions.includes("debugger"));
assert.ok(parsedManifest.host_permissions.includes("https://chatgpt.com/*"));
assert.match(background, /active: false/);
assert.match(background, /chatgpt-service-tab\.png/);
assert.match(background, /Page\.setInterceptFileChooserDialog/);
assert.match(background, /Page\.fileChooserOpened/);
assert.match(background, /DOM\.setFileInputFiles/);
assert.match(background, /chrome\.debugger\.detach/);
assert.match(background, /\[ResearchTube CDP\]/);
assert.match(background, /Composer file-input inspection/);
assert.match(background, /cdpAbsoluteFilePath/);
assert.match(background, /cdpAttachImage\(message\.filePath\)/);
const prototype = background.slice(background.indexOf("const CDP_SERVICE_TAB_STORAGE_KEY"), background.indexOf("chrome.runtime.onInstalled"));
assert.doesNotMatch(prototype, /send-button|document\.execCommand\('insertText'/);
assert.doesNotMatch(prototype, /uploadFile|DataTransfer|dragstart|ImageContent/);
console.log("CDP service-tab prototype: ok");
