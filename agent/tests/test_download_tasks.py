#!/usr/bin/env python3
"""Focused lifecycle checks for the Local Agent download worker."""

from __future__ import annotations

import asyncio
import os
import re
import stat
import tempfile
import unittest
from pathlib import Path

from agent import researchtube_agent as agent


@unittest.skipIf(os.name == "nt", "The fake yt-dlp fixture is a POSIX script.")
class DownloadTaskTests(unittest.IsolatedAsyncioTestCase):
    def test_generated_task_id_is_readable_and_compact(self) -> None:
        manager = agent.DownloadTaskManager()
        task_ids = {manager.new_task_id() for _ in range(100)}
        self.assertEqual(len(task_ids), 100)
        self.assertTrue(all(re.fullmatch(r"tsk_[A-Za-z0-9_-]{10}", task_id) for task_id in task_ids))
        self.assertTrue(all(len(task_id) == len("yt_aqz-KE-bpKQ") for task_id in task_ids))

    async def asyncSetUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.old_workspace = agent.WORKSPACE_PATH
        self.old_find_component = agent.find_component
        self.old_create_subprocess_exec = asyncio.create_subprocess_exec
        agent.WORKSPACE_PATH = self.root / "workspace"
        self.executable = self.root / "fake-yt-dlp"
        self.executable.write_text(
            """#!/usr/bin/env python3
import pathlib, re, sys, time
args = sys.argv[1:]
if args[args.index('--format') + 1] == '999':
    print('ERROR: [youtube] Requested format is not available. Use --list-formats for a list of available formats', file=sys.stderr, flush=True)
    raise SystemExit(1)
directory = pathlib.Path(args[args.index('--paths') + 1])
template = args[args.index('--output') + 1]
task_id = re.search(r'\\[([^]]+)\\]\\.', template).group(1)
output = directory / f'Test Video [yt_abc123] [{task_id}].mp4'
directory.mkdir(parents=True, exist_ok=True)
sys.stdout.write('[download]  10.0% of 1.00GiB at 10.00MiB/s ETA 01:30\\r')
sys.stdout.flush()
time.sleep(0.12)
print('[download]  80.0% of 1.00GiB at 10.00MiB/s ETA 00:20', flush=True)
print('[Merger] Merging formats into "test.mp4"', flush=True)
output.write_bytes(b'test mp4')
print(f'researchtube_file:{output}', flush=True)
""",
            encoding="utf-8",
        )
        self.executable.chmod(self.executable.stat().st_mode | stat.S_IXUSR)
        agent.find_component = lambda _name, _candidates: agent.ComponentDiscovery("local", str(self.executable))
        self.command: tuple[str, ...] | None = None

        async def capture_command(*args: str, **kwargs: object):
            self.command = args
            return await self.old_create_subprocess_exec(*args, **kwargs)

        asyncio.create_subprocess_exec = capture_command

    async def asyncTearDown(self) -> None:
        asyncio.create_subprocess_exec = self.old_create_subprocess_exec
        agent.find_component = self.old_find_component
        agent.WORKSPACE_PATH = self.old_workspace
        self.temp.cleanup()

    async def test_progress_and_final_mp4(self) -> None:
        manager = agent.DownloadTaskManager()
        started = await manager.create_download({"videoId": "abc123", "selection": {"video": "best", "audio": "best"}})
        self.assertIsNone(started["progressPercent"])
        self.assertEqual(started["phase"], "preparing")
        task = manager.get(started["taskId"])
        await asyncio.sleep(0.06)
        current = manager.snapshot(task)
        self.assertEqual(current["status"], "working", current)
        self.assertEqual(current["phase"], "downloadingVideo")
        self.assertGreaterEqual(current["progressPercent"], 10.0)
        await task.runner
        completed = manager.snapshot(task)
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["progressPercent"], 100.0)
        self.assertTrue(completed["result"]["filePath"].endswith(".mp4"))
        self.assertTrue((agent.WORKSPACE_PATH / completed["result"]["filePath"]).is_file())
        self.assertIn("--format", self.command)
        self.assertIn("bestvideo+bestaudio", self.command)
        self.assertIn("--merge-output-format", self.command)
        self.assertIn("mp4", self.command)
        self.assertIn("--progress", self.command)
        progress_delta_index = self.command.index("--progress-delta")
        self.assertEqual(self.command[progress_delta_index + 1], "1")
        self.assertIn("--no-js-runtimes", self.command)
        deno_runtime_index = self.command.index("--js-runtimes")
        self.assertEqual(self.command[deno_runtime_index + 1], f"deno:{self.executable}")
        self.assertNotIn("--extractor-args", self.command)
        ffmpeg_location_index = self.command.index("--ffmpeg-location")
        self.assertEqual(self.command[ffmpeg_location_index + 1], str(self.executable.parent))

    async def test_custom_progress_marker_still_updates_percentage(self) -> None:
        task = agent.DownloadTask(
            task_id="test-task", url="https://www.youtube.com/watch?v=abc123", video_id="abc123",
            selection=agent.DownloadSelection(video="best", audio="best"),
            output_directory=agent.WORKSPACE_PATH / "downloads", output_directory_relative="downloads",
            created_at="2026-09-19T00:00:00.000Z", last_updated_at="2026-09-19T00:00:00.000Z",
        )
        manager = agent.DownloadTaskManager()
        manager.consume_output_line(task, "researchtube_progress: 37.4%", source="test")
        self.assertEqual(task.progress_percent, 37.4)
        self.assertEqual(task.phase, "downloadingVideo")
        manager.consume_output_line(task, "researchtube_progress: 99.6%", source="test")
        manager.consume_output_line(task, "researchtube_progress: 40.8%", source="test")
        self.assertEqual(task.phase, "downloadingAudio")
        self.assertEqual(task.progress_percent, 40.8)
        manager.consume_output_line(task, "[Merger] Merging formats", source="test")
        self.assertEqual(task.phase, "merging")
        self.assertIsNone(task.progress_percent)

    async def test_combined_track_does_not_require_ffmpeg(self) -> None:
        manager = agent.DownloadTaskManager()
        started = await manager.create_download({"videoId": "abc123", "selection": {"combined": "22"}})
        task = manager.get(started["taskId"])
        await task.runner
        self.assertEqual(task.status, "completed")
        self.assertIn("22", self.command)
        self.assertNotIn("--merge-output-format", self.command)

    async def test_unavailable_exact_format_has_structured_error(self) -> None:
        manager = agent.DownloadTaskManager()
        started = await manager.create_download({"videoId": "abc123", "selection": {"video": "999"}})
        task = manager.get(started["taskId"])
        await task.runner
        self.assertEqual(task.status, "failed")
        self.assertEqual(task.error, {
            "code": "FORMAT_NOT_AVAILABLE",
            "message": "The selected YouTube format is no longer available to yt-dlp.",
        })

    def test_format_selection_rejects_mixed_combined_and_tracks(self) -> None:
        with self.assertRaisesRegex(agent.AgentApiError, "do not mix"):
            agent.parse_download_selection({"combined": "22", "video": "137"})


if __name__ == "__main__":
    unittest.main()
