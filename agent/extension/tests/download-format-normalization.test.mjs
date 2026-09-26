import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
const first = background.indexOf("function normalizeYouTubeFormats(");
const last = background.indexOf("\nasync function youtubeGetTranscript", first);
assert.ok(first >= 0 && last > first, "download format normalization helpers must exist");

const normalizeDownloadFormats = new Function(`${background.slice(first, last)}\nreturn normalizeYouTubeFormats;`)();

const formats = normalizeDownloadFormats({
  formats: [{
    itag: 22,
    mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 2_000_000,
    contentLength: "200000000",
    qualityLabel: "720p"
  }],
  adaptiveFormats: [{
    itag: 137,
    mimeType: 'video/mp4; codecs="avc1.640028"',
    width: 1920,
    height: 1080,
    fps: 30,
    averageBitrate: 4_000_000,
    contentLength: "250000000",
    qualityLabel: "1080p"
  }, {
    itag: 251,
    mimeType: 'audio/webm; codecs="opus"',
    bitrate: 160000,
    audioSampleRate: "48000",
    audioChannels: 2,
    contentLength: "30000000"
  }, {
    itag: 999,
    mimeType: 'audio/mp4; codecs="mp4a.40.2"',
    bitrate: 128000,
    contentLength: "not-a-size"
  }]
});

assert.equal(formats.available, true);
assert.equal(formats.source, "youtube");
assert.equal(formats.message, null);
assert.deepEqual(formats.combined.map((item) => item.formatId), ["22"]);
assert.deepEqual(formats.video.map((item) => item.formatId), ["137"]);
assert.deepEqual(formats.audio.map((item) => item.formatId), ["251", "999"]);
assert.deepEqual(formats.combined[0], {
  formatId: "22", kind: "combined", container: "mp4", videoCodec: "avc1.64001F", audioCodec: "mp4a.40.2",
  width: 1280, height: 720, fps: 30, bitrateBps: 2_000_000, audioSampleRateHz: null, audioChannels: null,
  qualityLabel: "720p", sizeBytes: 200_000_000
});
assert.deepEqual(formats.audio[0], {
  formatId: "251", kind: "audio", container: "webm", videoCodec: null, audioCodec: "opus",
  width: null, height: null, fps: null, bitrateBps: 160_000, audioSampleRateHz: 48_000, audioChannels: 2,
  qualityLabel: null, sizeBytes: 30_000_000
});
assert.equal(formats.audio[1].sizeBytes, null);
assert.deepEqual(normalizeDownloadFormats(null), {
  available: false, source: "unavailable", message: "YouTube did not expose downloadable media formats for this video.",
  combined: [], video: [], audio: []
});
console.log("download format normalization: ok");
