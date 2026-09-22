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
assert.match(background, /Page\.setInterceptFileChooserDialog/);
assert.match(background, /Page\.fileChooserOpened/);
assert.match(background, /DOM\.setFileInputFiles/);
assert.match(background, /chrome\.debugger\.detach/);
assert.match(background, /\[ResearchTube CDP\]/);
assert.match(background, /Composer file-input inspection/);
assert.match(background, /cdpAbsoluteFilePath/);
assert.match(background, /cdpWaitForStableComposer/, "first attachment must wait for a stable Composer, not merely tab load");
assert.match(background, /CDP_COMPOSER_SETTLE_MS/, "Composer readiness must include a stability interval");
assert.match(background, /cdpOpenStableFileChooser/, "a missed chooser event must be retried without requiring a new tab");
assert.match(background, /CDP_FILE_CHOOSER_ATTEMPTS/, "chooser retry count must be bounded");
assert.match(background, /result\?\.value === true/, "page-condition waits must inspect the CDP evaluation value");
assert.match(background, /cdpWaitForAttachmentAccepted/, "attachment completion must use Composer file acceptance, not only visible preview text");
assert.match(background, /input\.files/, "file-input selection must be accepted as browser-level attachment evidence");
assert.match(background, /drainLibraryStoreQueue/, "Library batches must share one serialized service-tab queue");
assert.match(background, /cdpAttachImagesNow/, "the queued public entrypoint must serialize the CDP lifecycle");
assert.match(background, /CDP_IMAGE_BATCH_MAX_FILES = 5/, "a Composer batch must be capped at five images");
assert.match(background, /libraryStoreQueue/, "Library batches must be queued independently");
assert.match(background, /DOM\.setFileInputFiles", \{ files: filePaths/, "one chooser operation must receive the whole batch");
assert.match(background, /cdpSendAttachedImages/, "the queued image batch must still be sent through ChatGPT");
assert.match(background, /CDP_CLICK_SEND_BUTTON_EXPRESSION/, "the attached image batch must click ChatGPT Send");
assert.doesNotMatch(background, /Store this image in the Library\.|Store these images in the Library\.|Input\.insertText/, "the Library flow must not insert a second storage instruction into Composer");
const prototype = background.slice(background.indexOf("const CDP_SERVICE_TAB_STORAGE_KEY"), background.indexOf("chrome.runtime.onInstalled"));
assert.doesNotMatch(prototype, /document\.execCommand\('insertText'/);
assert.doesNotMatch(prototype, /uploadFile|DataTransfer|dragstart|ImageContent/);
assert.doesNotMatch(background, /chatgpt-service-tab\.png|setServiceTabFavicon|researchtube-service-favicon|favIconUrl/);
assert.equal(parsedManifest.web_accessible_resources, undefined, "the service tab must not alter or expose a favicon resource");
console.log("CDP service-tab prototype: ok");
