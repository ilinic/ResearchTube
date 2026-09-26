import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
const start = background.indexOf("function googleTranslateBase64Bytes");
const end = background.indexOf("\nasync function googleTranslateNetworkAudioCapture", start);
assert.ok(start >= 0 && end > start, "Google Translate network-audio helpers must exist");

const { googleTranslateBatchAudioChunks, googleTranslateIsMp3 } = new Function(
  `${background.slice(start, end)}\nreturn { googleTranslateBatchAudioChunks, googleTranslateIsMp3 };`
)();

const mp3 = new Uint8Array([0xff, 0xfb, ...new TextEncoder().encode("ResearchTube Google Translate source audio")]);
const encoded = Buffer.from(mp3).toString("base64");
const batchResponse = `)]}'\n91\n[["wrb.fr","jQ1olc","[\\"${encoded}\\"]\\n",null,null,null,"generic"]]`;
const chunks = googleTranslateBatchAudioChunks(batchResponse);

assert.equal(chunks.length, 1, "jQ1olc must expose one source-audio chunk");
assert.deepEqual([...chunks[0]], [...mp3]);
assert.equal(googleTranslateIsMp3(chunks[0]), true);
assert.deepEqual(googleTranslateBatchAudioChunks('[["wrb.fr","otherRpc","[\\"not audio\\"]"]]'), []);
console.log("Google Translate network audio: ok");
