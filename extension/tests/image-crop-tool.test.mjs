import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");

assert.match(background, /name: "researchtube_image_crop"/);
assert.match(background, /Crop a workspace image/);
assert.match(background, /crop\.x and crop\.y are zero-based coordinates in the stored source-image pixels/);
assert.match(background, /existing PNG, JPEG, or WebP source image/);
assert.match(background, /The source is never changed/);
assert.match(background, /The tool never overwrites an existing file and never returns a host path/);
assert.match(background, /function normalizeImageCropInput\(/);
assert.match(background, /function normalizeImageCropResult\(/);
assert.match(background, /"\/media\/image-crop"/);
assert.match(background, /outputPath extension must match image\.format/);
console.log("image crop tool: ok");
