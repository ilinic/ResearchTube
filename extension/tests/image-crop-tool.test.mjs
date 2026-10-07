import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");

assert.match(background, /name: "media_image_crop"/);
assert.match(background, /Crop a workspace image/);
assert.match(background, /using zero-based source pixels/);
assert.match(background, /existing PNG, JPEG, or WebP source image/);
assert.match(background, /Source is unchanged/);
assert.match(background, /existing outputs are not overwritten/);
assert.match(background, /function normalizeImageCropInput\(/);
assert.match(background, /function normalizeImageCropResult\(/);
assert.match(background, /"\/media\/image-crop"/);
assert.match(background, /outputPath extension must match image\.format/);
console.log("image crop tool: ok");
