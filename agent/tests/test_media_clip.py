#!/usr/bin/env python3
"""Contracts for asynchronous local video/audio clipping."""

from __future__ import annotations

import asyncio
import hashlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

from agent import researchtube_agent as agent


class _ProgressReader:
    def __init__(self, lines: list[bytes]) -> None:
        self.lines = iter(lines)

    async def readline(self) -> bytes:
        return next(self.lines, b"")


class _ProgressProcess:
    def __init__(self, lines: list[bytes]) -> None:
        self.stdout = _ProgressReader(lines)


class _BytesReader:
    async def read(self) -> bytes:
        return b""


class _SuccessfulClipProcess:
    def __init__(self) -> None:
        self.stdout = _ProgressReader([])
        self.stderr = _BytesReader()
        self.returncode: int | None = None

    async def wait(self) -> int:
        self.returncode = 0
        return 0


class MediaClipTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.old_workspace = agent.WORKSPACE_PATH
        agent.WORKSPACE_PATH = Path(self.temp.name) / "workspace"
        agent.WORKSPACE_PATH.mkdir(parents=True)

    def tearDown(self) -> None:
        agent.WORKSPACE_PATH = self.old_workspace
        self.temp.cleanup()

    def test_options_preserve_interval_order_and_defaults(self) -> None:
        options = agent.media_clip_options({
            "path": "inputs/example.mp4",
            "outputFormat": "mp4",
            "segments": [
                {"startSeconds": 20, "endSeconds": 25.5},
                {"startSeconds": 2, "endSeconds": 4},
            ],
        })
        self.assertEqual(options["segments"], [
            {"startSeconds": 20.0, "endSeconds": 25.5},
            {"startSeconds": 2.0, "endSeconds": 4.0},
        ])
        self.assertEqual(options["cutMode"], "accurate")
        self.assertTrue(options["includeAudio"])
        self.assertEqual(options["outputDir"], "clips")

    def test_options_allow_whole_source_audio_extraction(self) -> None:
        options = agent.media_clip_options({"path": "inputs/example.mp4", "outputFormat": "m4a"})
        self.assertIsNone(options["segments"])
        self.assertEqual(options["outputFormat"], "m4a")

    def test_options_reject_duplicates_and_cross_field_conflicts(self) -> None:
        with self.assertRaises(agent.AgentApiError) as duplicate:
            agent.media_clip_options({
                "path": "inputs/example.mp4", "outputFormat": "m4a",
                "segments": [
                    {"startSeconds": 1, "endSeconds": 2},
                    {"startSeconds": 1, "endSeconds": 2},
                ],
            })
        self.assertEqual(duplicate.exception.code, "MEDIA_CLIP_INVALID")
        with self.assertRaises(agent.AgentApiError):
            agent.media_clip_options({"path": "inputs/example.mp4", "outputKind": "audio"})
        with self.assertRaises(agent.AgentApiError):
            agent.media_clip_options({"path": "inputs/example.mp4", "outputFormat": "mp4", "includeAudio": False, "audioStreamIndex": 1})

    def test_required_format_and_encoding_options(self) -> None:
        for payload in ({"path": "x.mp4"}, {"path": "x.mp4", "outputFormat": "../mp3"},
                        {"path": "x.mp4", "outputFormat": "mp3", "audioBitrate": "0"},
                        {"path": "x.mp4", "outputFormat": "mp3", "cutMode": "copy", "audioCodec": "mp3"}):
            with self.assertRaises(agent.AgentApiError):
                agent.media_clip_options(payload)
        options = agent.media_clip_options({"path": "x.mp4", "outputFormat": " MP3 ", "audioCodec": "libmp3lame", "audioBitrate": "192k"})
        self.assertEqual(options["outputFormat"], "mp3")
        self.assertEqual(options["audioBitrate"], "192k")

    def test_segments_without_format_select_copy_and_require_format_for_encoding(self) -> None:
        payload = {"path": "x.mp4", "segments": [{"startSeconds": 1, "endSeconds": 2}]}
        options = agent.media_clip_options(payload)
        self.assertIsNone(options["outputFormat"])
        self.assertEqual(options["cutMode"], "copy")
        for extra in ({"audioBitrate": "192k"}, {"outputFormat": None}, {"cutMode": "copy"}, {"segments": None}):
            with self.assertRaises(agent.AgentApiError):
                agent.media_clip_options({**payload, **extra})

    def test_publication_never_overwrites_existing_file(self) -> None:
        target, temporary = agent.WORKSPACE_PATH / "kept.mp3", agent.WORKSPACE_PATH / ".tmp.mp3"
        target.write_bytes(b"existing")
        temporary.write_bytes(b"new")
        with self.assertRaises(agent.AgentApiError) as error:
            agent.media_clip_publish_without_overwrite(temporary, target)
        self.assertEqual(error.exception.code, "DESTINATION_EXISTS")
        self.assertEqual(target.read_bytes(), b"existing")

    def test_audio_output_does_not_report_an_unmapped_source_video_stream(self) -> None:
        streams = [
            {"index": 0, "codec_type": "video", "codec_name": "h264"},
            {"index": 1, "codec_type": "audio", "codec_name": "aac"},
        ]
        payload = {
            "outputFormat": "m4a", "videoStreamIndex": None,
            "audioStreamIndex": None, "includeAudio": True,
        }
        video_stream, audio_stream = agent.media_clip_select_output_streams(streams, payload, {"video": False, "audio": True})
        self.assertIsNone(video_stream)
        self.assertEqual(audio_stream, streams[1])

    def test_cancellation_during_probe_never_publishes_an_unreported_clip(self) -> None:
        source_path = agent.WORKSPACE_PATH / "inputs" / "example.mp4"
        source_path.parent.mkdir(parents=True)
        source_path.write_bytes(b"source")
        source = agent.WorkspacePathResolver().resolve_existing("inputs/example.mp4", field_name="path", expected_type="file")
        output_directory = agent.WorkspacePathResolver().resolve_destination("clips", field_name="outputDir", error_code="MEDIA_CLIP_INVALID")
        output_directory.physical_path.mkdir()
        task = agent.MediaClipTask(
            "clip_cancel", {
                "path": "inputs/example.mp4", "outputFormat": "m4a", "cutMode": "copy", "formatInfo": {"muxer": "ipod", "mimeType": "audio/mp4"},
            }, agent.utc_now(), agent.utc_now(), total_clips=1,
        )

        async def create_process(*command: str, **_kwargs: object) -> _SuccessfulClipProcess:
            Path(command[-1]).write_bytes(b"completed temporary clip")
            return _SuccessfulClipProcess()

        async def cancel_during_probe(path: Path, _executable: str) -> tuple[list[dict[str, object]], float | None]:
            self.assertTrue(path.name.startswith("."), "ffprobe must inspect the unpublished temporary file")
            visible_files = [item for item in output_directory.physical_path.iterdir() if not item.name.startswith(".")]
            self.assertEqual(visible_files, [])
            raise asyncio.CancelledError

        async def exercise() -> None:
            with patch.object(agent.asyncio, "create_subprocess_exec", side_effect=create_process), patch.object(agent, "media_clip_probe_file", side_effect=cancel_during_probe):
                with self.assertRaises(asyncio.CancelledError):
                    await agent.MediaClipTaskManager().create_one_clip(
                        task, source, output_directory, "ffmpeg", "ffprobe", None,
                        {"index": 1, "codec_type": "audio", "codec_name": "aac"},
                        {"startSeconds": 0.0, "endSeconds": 3.0}, 0,
                    )

        asyncio.run(exercise())
        self.assertEqual(list(output_directory.physical_path.iterdir()), [])

    def test_ffmpeg_progress_is_combined_across_intervals(self) -> None:
        manager = agent.MediaClipTaskManager()
        task = agent.MediaClipTask(
            "clip_test", {"path": "inputs/example.mp4", "outputFormat": "mp4", "cutMode": "copy"},
            agent.utc_now(), agent.utc_now(), total_clips=2,
        )
        task.process = _ProgressProcess([b"frame=1\n", b"out_time_us=2000000\n", b"progress=continue\n"])
        asyncio.run(manager.read_progress(task, segment_index=1, segment_duration=4.0))
        self.assertEqual(task.progress_percent, 75.0)
        self.assertEqual(task.status_message, "Creating clip 2 of 2: 50%.")

    def test_agent_task_log_suffix_reports_percentage(self) -> None:
        suffix = agent.response_log_suffix(
            "/tasks/media-clip/clip_test",
            {"taskId": "clip_test", "progressPercent": 37.5},
        )
        self.assertEqual(suffix, " 37.5%")

    def test_cancel_compatibility_check_kills_child_and_removes_header(self) -> None:
        class WaitingProcess:
            returncode = None
            killed = False
            async def communicate(self):
                if not self.killed:
                    raise asyncio.CancelledError
                return b"", b""
            def kill(self):
                self.killed, self.returncode = True, -9
        process, headers = WaitingProcess(), []
        async def create_process(*command, **_kwargs):
            header = Path(command[-1])
            header.write_bytes(b"private probe header")
            headers.append(header)
            return process
        async def exercise():
            with patch.object(agent.asyncio, "create_subprocess_exec", side_effect=create_process):
                with self.assertRaises(asyncio.CancelledError):
                    await agent.media_clip_can_copy_stream(Path("source.mp4"), {"index": 1}, "ipod", "ffmpeg")
        asyncio.run(exercise())
        self.assertTrue(process.killed)
        self.assertFalse(headers[0].parent.exists())


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "real FFmpeg/ffprobe unavailable")
class MediaConversionIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.old_workspace = agent.WORKSPACE_PATH
        agent.WORKSPACE_PATH = Path(self.temp.name)
        self.ffmpeg, self.ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
        self.source = agent.WORKSPACE_PATH / "source.mp4"
        subprocess.run([self.ffmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10",
                        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "3",
                        "-c:v", "mpeg4", "-c:a", "aac", str(self.source)], check=True)
        self.original = (hashlib.sha256(self.source.read_bytes()).hexdigest(), self.source.stat().st_mtime_ns)
        self.manager = agent.MediaClipTaskManager()

    async def asyncTearDown(self) -> None:
        await self.manager.shutdown()
        self.assertEqual((hashlib.sha256(self.source.read_bytes()).hexdigest(), self.source.stat().st_mtime_ns), self.original)
        agent.WORKSPACE_PATH = self.old_workspace
        self.temp.cleanup()

    async def convert(self, payload: dict[str, object]) -> dict[str, object]:
        def find(name: str, _unused: object) -> SimpleNamespace:
            return SimpleNamespace(executable=self.ffmpeg if name == "ffmpeg" else self.ffprobe, error=None)
        with patch.object(agent, "find_component", side_effect=find):
            initial = await self.manager.create(payload)
            self.assertEqual(initial["status"], "working")
            self.assertEqual(initial["outputFormat"], payload.get("outputFormat"))
            task = self.manager.get(initial["taskId"])
            await task.runner
            return self.manager.snapshot(task)

    async def test_audio_formats_and_ordered_video_conversion(self) -> None:
        for output_format in ("mp3", "wav", "flac", "m4a", "opus", "ogg", "aac"):
            with self.subTest(format=output_format):
                result = await self.convert({"path": "source.mp4", "outputFormat": output_format})
                self.assertEqual(result["status"], "completed", result.get("error"))
                self.assertEqual(result["progressPercent"], 100)
                clip = result["clips"][0]
                self.assertEqual(clip["outputKind"], "audio")
                self.assertIsNone(clip["selectedVideoStreamIndex"])
                self.assertEqual(clip["reencoded"], output_format not in {"m4a", "aac"})
                streams, duration = await agent.media_clip_probe_file(agent.WORKSPACE_PATH / clip["workspacePath"], self.ffprobe)
                self.assertEqual({stream["codec_type"] for stream in streams}, {"audio"})
                self.assertAlmostEqual(duration, 3, delta=0.2)
        for output_format in ("mp4", "webm", "mkv"):
            with self.subTest(format=output_format):
                result = await self.convert({"path": "source.mp4", "outputFormat": output_format,
                    "segments": [{"startSeconds": 2, "endSeconds": 2.8}, {"startSeconds": 0.2, "endSeconds": 1}]})
                self.assertEqual(result["status"], "completed", result.get("error"))
                self.assertEqual([clip["startSeconds"] for clip in result["clips"]], [2, 0.2])
                self.assertEqual(result["completedClips"], 2)
                for clip in result["clips"]:
                    self.assertTrue(clip["hasAudio"])
                    self.assertEqual(clip["format"], output_format)
                    if clip["reencoded"]:
                        self.assertAlmostEqual(clip["durationSeconds"], 0.8, delta=0.2)
                    else:
                        self.assertGreaterEqual(clip["durationSeconds"], 0.7)

    async def test_audio_only_source_in_video_container_and_explicit_encoding(self) -> None:
        first = await self.convert({"path": "source.mp4", "outputFormat": "wav"})
        result = await self.convert({"path": first["clips"][0]["workspacePath"], "outputFormat": "mp4"})
        self.assertEqual(result["status"], "completed", result.get("error"))
        self.assertEqual(result["clips"][0]["outputKind"], "audio")
        self.assertEqual(result["clips"][0]["mimeType"], "audio/mp4")
        result = await self.convert({"path": "source.mp4", "outputFormat": "mp3", "audioCodec": "libmp3lame", "audioBitrate": "192k"})
        self.assertEqual(result["status"], "completed", result.get("error"))
        result = await self.convert({"path": "source.mp4", "outputFormat": "mp4", "includeAudio": False})
        self.assertEqual(result["status"], "completed", result.get("error"))
        self.assertFalse(result["clips"][0]["hasAudio"])

    async def test_copy_by_omitting_format_and_unsupported_format_failures(self) -> None:
        result = await self.convert({"path": "source.mp4", "segments": [{"startSeconds": 0, "endSeconds": 1}]})
        self.assertEqual(result["status"], "completed", result.get("error"))
        self.assertEqual(result["outputFormat"], "mp4")
        self.assertEqual(result["cutMode"], "copy")
        self.assertFalse(result["clips"][0]["reencoded"])
        streams, _ = await agent.media_clip_probe_file(agent.WORKSPACE_PATH / result["clips"][0]["workspacePath"], self.ffprobe)
        self.assertEqual([stream["codec_name"] for stream in streams], ["mpeg4", "aac"])
        first = await self.convert({"path": "source.mp4", "outputFormat": "ogv"})
        self.assertEqual(first["status"], "completed", first.get("error"))
        ogg_source = agent.WORKSPACE_PATH / "video.ogg"
        shutil.copyfile(agent.WORKSPACE_PATH / first["clips"][0]["workspacePath"], ogg_source)
        result = await self.convert({"path": "video.ogg", "segments": [{"startSeconds": 0, "endSeconds": 1}]})
        self.assertEqual(result["status"], "completed", result.get("error"))
        self.assertEqual(result["clips"][0]["outputKind"], "video")
        self.assertEqual(result["clips"][0]["mimeType"], "video/ogg")
        for payload, code in (({"outputFormat": "no_such_format"}, "MEDIA_CLIP_FORMAT_UNSUPPORTED"),
                              ({"outputFormat": "mp3", "videoStreamIndex": 0}, "MEDIA_CLIP_INVALID")):
            result = await self.convert({"path": "source.mp4", **payload})
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["error"]["code"], code)
            self.assertEqual(result["clips"], [])
            self.assertNotIn(self.temp.name, str(result))
        self.assertFalse(any(path.name.startswith(".") for path in (agent.WORKSPACE_PATH / "clips").iterdir()))

    def packet_hashes(self, path: Path, selector: str) -> list[str]:
        import json
        document = json.loads(subprocess.check_output([
            self.ffprobe, "-v", "error", "-select_streams", selector, "-show_packets",
            "-show_data_hash", "sha256", "-of", "json", str(path),
        ]))
        return [packet["data_hash"] for packet in document["packets"]]

    def decoded_audio(self, path: Path, codec: str = "pcm_f32le", fmt: str = "f32le") -> bytes:
        return subprocess.check_output([self.ffmpeg, "-v", "error", "-i", str(path), "-map", "0:a:0",
                                        "-c:a", codec, "-f", fmt, "pipe:1"])

    def decoded_frames(self, path: Path) -> list[str]:
        output = subprocess.check_output([self.ffmpeg, "-v", "error", "-i", str(path), "-map", "0:v:0",
                                          "-f", "framehash", "pipe:1"]).decode()
        return [line.rsplit(",", 1)[-1].strip() for line in output.splitlines() if not line.startswith("#")]

    async def test_aac_and_opus_extraction_preserves_every_encoded_packet(self) -> None:
        result = await self.convert({"path": "source.mp4", "outputFormat": "m4a"})
        self.assertEqual(result["status"], "completed", result.get("error"))
        self.assertFalse(result["clips"][0]["reencoded"])
        self.assertEqual(self.packet_hashes(self.source, "a"),
                         self.packet_hashes(agent.WORKSPACE_PATH / result["clips"][0]["workspacePath"], "a"))
        webm = await self.convert({"path": "source.mp4", "outputFormat": "webm"})
        webm_path = webm["clips"][0]["workspacePath"]
        result = await self.convert({"path": webm_path, "outputFormat": "opus"})
        self.assertEqual(result["status"], "completed", result.get("error"))
        self.assertFalse(result["clips"][0]["reencoded"])
        self.assertEqual(self.packet_hashes(agent.WORKSPACE_PATH / webm_path, "a"),
                         self.packet_hashes(agent.WORKSPACE_PATH / result["clips"][0]["workspacePath"], "a"))

    async def test_lossless_video_encoding_copies_compatible_audio(self) -> None:
        result = await self.convert({"path": "source.mp4", "outputFormat": "mp4", "videoCodec": "libx264"})
        self.assertEqual(result["status"], "completed", result.get("error"))
        output = agent.WORKSPACE_PATH / result["clips"][0]["workspacePath"]
        self.assertTrue(result["clips"][0]["reencoded"])
        streams, _ = await agent.media_clip_probe_file(output, self.ffprobe)
        self.assertEqual([stream["codec_name"] for stream in streams], ["h264", "aac"])
        self.assertEqual(self.decoded_frames(self.source), self.decoded_frames(output))
        self.assertEqual(self.packet_hashes(self.source, "a"), self.packet_hashes(output, "a"))
        webm = await self.convert({"path": "source.mp4", "outputFormat": "webm"})
        self.assertEqual(webm["status"], "completed", webm.get("error"))
        self.assertEqual(self.decoded_frames(self.source),
                         self.decoded_frames(agent.WORKSPACE_PATH / webm["clips"][0]["workspacePath"]))

    async def test_pcm_conversion_preserves_float_and_integer_precision(self) -> None:
        result = await self.convert({"path": "source.mp4", "outputFormat": "wav"})
        self.assertEqual(result["status"], "completed", result.get("error"))
        output = agent.WORKSPACE_PATH / result["clips"][0]["workspacePath"]
        streams, _ = await agent.media_clip_probe_file(output, self.ffprobe)
        self.assertEqual(streams[0]["codec_name"], "pcm_f32le")
        self.assertEqual(self.decoded_audio(self.source), self.decoded_audio(output))
        source = agent.WORKSPACE_PATH / "high-depth.wav"
        subprocess.run([self.ffmpeg, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=731:sample_rate=48000",
                        "-t", "1", "-c:a", "pcm_s32le", str(source)], check=True)
        result = await self.convert({"path": source.name, "outputFormat": "flac"})
        self.assertEqual(result["status"], "completed", result.get("error"))
        self.assertEqual(self.decoded_audio(source, "pcm_s32le", "s32le"),
                         self.decoded_audio(agent.WORKSPACE_PATH / result["clips"][0]["workspacePath"], "pcm_s32le", "s32le"))

    async def test_explicit_bitrate_overrides_quality_and_encodes_only_selected_stream(self) -> None:
        result = await self.convert({"path": "source.mp4", "outputFormat": "m4a", "audioBitrate": "192k"})
        self.assertEqual(result["status"], "completed", result.get("error"))
        self.assertTrue(result["clips"][0]["reencoded"])
        self.assertNotEqual(self.packet_hashes(self.source, "a"),
                            self.packet_hashes(agent.WORKSPACE_PATH / result["clips"][0]["workspacePath"], "a"))
        result = await self.convert({"path": "source.mp4", "outputFormat": "mp3", "audioBitrate": "192k"})
        self.assertEqual(result["status"], "completed", result.get("error"))
        streams, _ = await agent.media_clip_probe_file(agent.WORKSPACE_PATH / result["clips"][0]["workspacePath"], self.ffprobe)
        self.assertEqual(int(streams[0]["bit_rate"]), 192000)

    async def test_raw_audio_formats_have_the_requested_codec(self) -> None:
        for fmt in ("mp2", "ac3", "eac3", "aac"):
            with self.subTest(format=fmt):
                result = await self.convert({"path": "source.mp4", "outputFormat": fmt})
                self.assertEqual(result["status"], "completed", result.get("error"))
                streams, _ = await agent.media_clip_probe_file(agent.WORKSPACE_PATH / result["clips"][0]["workspacePath"], self.ffprobe)
                self.assertEqual(streams[0]["codec_name"], fmt)
                self.assertEqual(result["clips"][0]["reencoded"], fmt != "aac")


if __name__ == "__main__":
    unittest.main()
