import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
const first = background.indexOf("function unavailableDownloadFormats(");
const last = background.indexOf("\nasync function youtubeGetTranscript", first);
assert.ok(first >= 0 && last > first, "yt-dlp format normalizer must exist");

const { normalizeYtDlpDownloadFormats } = new Function(
  `${background.slice(first, last)}\nreturn { normalizeYtDlpDownloadFormats };`
)();

const formats = normalizeYtDlpDownloadFormats({
  available: true,
  combined: [],
  video: [{ formatId: "137", kind: "video", container: "mp4", videoCodec: "avc1", audioCodec: null, width: 1920, height: 1080, fps: 30, bitrateBps: 4_000_000, audioSampleRateHz: null, audioChannels: null, qualityLabel: "1080p", sizeBytes: 250_000_000 }],
  audio: [{ formatId: "140", kind: "audio", container: "m4a", videoCodec: null, audioCodec: "mp4a.40.2", width: null, height: null, fps: null, bitrateBps: 128_000, audioSampleRateHz: 44_100, audioChannels: 2, qualityLabel: null, sizeBytes: 3_000_000 }]
});

assert.equal(formats.available, true);
assert.equal(formats.source, "ytDlp");
assert.equal(formats.message, null);
assert.deepEqual(formats.video.map((item) => item.formatId), ["137"]);
assert.deepEqual(formats.audio.map((item) => item.formatId), ["140"]);
assert.deepEqual(normalizeYtDlpDownloadFormats({ available: true, video: [{ formatId: "bestvideo", kind: "video" }] }).source, "unavailable");
console.log("yt-dlp format normalization: ok");
