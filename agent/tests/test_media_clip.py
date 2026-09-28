#!/usr/bin/env python3
"""Contracts for asynchronous local video/audio clipping."""

from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from agent import researchtube_agent as agent


class _ProgressReader:
    def __init__(self, lines: list[bytes]) -> None:
        self.lines = iter(lines)

    async def readline(self) -> bytes:
        return next(self.lines, b"")


class _ProgressProcess:
    def __init__(self, lines: list[bytes]) -> None:
        self.stdout = _ProgressReader(lines)


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
            "outputKind": "video",
            "segments": [
                {"startSeconds": 20, "endSeconds": 25.5},
                {"startSeconds": 2, "endSeconds": 4},
            ],
        })
        self.assertEqual(options["segments"], [
            {"startSeconds": 20.0, "endSeconds": 25.5},
            {"startSeconds": 2.0, "endSeconds": 4.0},
        ])
        self.assertEqual(options["cutMode"], "copy")
        self.assertTrue(options["includeAudio"])
        self.assertEqual(options["outputDir"], "clips")

    def test_options_allow_whole_source_audio_extraction(self) -> None:
        options = agent.media_clip_options({"path": "inputs/example.mp4", "outputKind": "audio"})
        self.assertIsNone(options["segments"])
        self.assertEqual(options["outputKind"], "audio")

    def test_options_reject_duplicates_and_cross_field_conflicts(self) -> None:
        with self.assertRaises(agent.AgentApiError) as duplicate:
            agent.media_clip_options({
                "path": "inputs/example.mp4", "outputKind": "audio",
                "segments": [
                    {"startSeconds": 1, "endSeconds": 2},
                    {"startSeconds": 1, "endSeconds": 2},
                ],
            })
        self.assertEqual(duplicate.exception.code, "MEDIA_CLIP_INVALID")
        with self.assertRaises(agent.AgentApiError):
            agent.media_clip_options({"path": "inputs/example.mp4", "outputKind": "audio", "includeAudio": True})
        with self.assertRaises(agent.AgentApiError):
            agent.media_clip_options({"path": "inputs/example.mp4", "outputKind": "video", "includeAudio": False, "audioStreamIndex": 1})

    def test_copy_extensions_preserve_common_native_codecs(self) -> None:
        self.assertEqual(agent.media_clip_audio_extension("opus", "copy"), "opus")
        self.assertEqual(agent.media_clip_audio_extension("aac", "copy"), "m4a")
        self.assertEqual(agent.media_clip_audio_extension("opus", "accurate"), "m4a")
        self.assertEqual(agent.media_clip_video_extension(Path("source.webm"), "copy"), "webm")
        self.assertEqual(agent.media_clip_video_extension(Path("source.webm"), "accurate"), "mp4")

    def test_ffmpeg_progress_is_combined_across_intervals(self) -> None:
        manager = agent.MediaClipTaskManager()
        task = agent.MediaClipTask(
            "clip_test", {"path": "inputs/example.mp4", "outputKind": "video", "cutMode": "copy"},
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


if __name__ == "__main__":
    unittest.main()
