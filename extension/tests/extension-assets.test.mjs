import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
for (const icons of [manifest.icons, manifest.action.default_icon]) {
  for (const [size, path] of Object.entries(icons)) {
    const bytes = await readFile(new URL(`../${path}`, import.meta.url));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", path + " must be PNG");
    assert.equal(bytes.readUInt32BE(16), Number(size), path + " width");
    assert.equal(bytes.readUInt32BE(20), Number(size), path + " height");
    const compressed = [];
    let offset = 8, ended = false;
    while (offset < bytes.length) {
      assert.ok(offset + 12 <= bytes.length, path + " truncated chunk");
      const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
      assert.ok(end <= bytes.length, path + " invalid chunk length");
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      assert.match(type, /^[A-Za-z]{4}$/, path + " invalid chunk type");
      assert.equal(crc32(bytes.subarray(offset + 4, end - 4)), bytes.readUInt32BE(end - 4), path + " " + type + " checksum");
      if (type === "IDAT") compressed.push(bytes.subarray(offset + 8, end - 4));
      if (type === "IEND") { ended = true; assert.equal(end, bytes.length); }
      offset = end;
    }
    assert.ok(ended && compressed.length, path + " must contain image data and an end marker");
    assert.ok(inflateSync(Buffer.concat(compressed)).length, path + " compressed pixels must decode");
  }
}
console.log("Extension manifest icons: present, correctly sized and valid PNGs");
