#!/usr/bin/env python3
"""Security and privacy checks for the shared workspace path foundation."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from agent import researchtube_agent as agent


class WorkspacePathResolverTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.old_workspace = agent.WORKSPACE_PATH
        agent.WORKSPACE_PATH = self.root / "workspace"

    def tearDown(self) -> None:
        agent.WORKSPACE_PATH = self.old_workspace
        self.temp.cleanup()

    def test_accepts_logical_posix_output_directory(self) -> None:
        physical, logical = agent.resolve_output_directory("downloads/task-contract-test")
        self.assertEqual(logical, "downloads/task-contract-test")
        self.assertTrue(agent.path_is_within(physical, agent.WORKSPACE_PATH.resolve()))

    def test_rejects_foreign_and_traversal_path_syntax(self) -> None:
        rejected = [
            "../secret", "downloads/../../secret", "/etc/passwd", "\\server\\share",
            "C:\\Windows", "C:Windows", "downloads\\..\\secret", "foo/./bar", "foo//bar",
        ]
        for value in rejected:
            with self.subTest(value=value):
                with self.assertRaises(agent.AgentApiError) as raised:
                    agent.resolve_output_directory(value)
                self.assertEqual(raised.exception.code, "OUTPUT_DIR_INVALID")

    def test_rejects_symlink_escape_for_new_destination(self) -> None:
        workspace = agent.WORKSPACE_PATH
        workspace.mkdir(parents=True, exist_ok=True)
        outside = self.root / "outside"
        outside.mkdir()
        link = workspace / "external"
        try:
            os.symlink(outside, link, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"symlink creation is unavailable: {error.__class__.__name__}")
        with self.assertRaises(agent.AgentApiError) as raised:
            agent.resolve_output_directory("external/new-download")
        self.assertEqual(raised.exception.code, "OUTPUT_DIR_INVALID")

    def test_workspace_file_tools_use_logical_paths_and_conservative_delete(self) -> None:
        workspace = agent.WORKSPACE_PATH
        downloads = workspace / "downloads"
        downloads.mkdir(parents=True)
        source = downloads / "sample.mp4"
        source.write_bytes(b"media")

        listed = agent.workspace_list({"path": "", "limit": 10})
        self.assertEqual(listed["path"], "")
        self.assertEqual(listed["entries"][0]["path"], "downloads")
        self.assertNotIn(str(workspace), json.dumps(listed))

        stat = agent.workspace_stat({"path": "downloads/sample.mp4"})
        self.assertEqual(stat["type"], "file")
        self.assertEqual(stat["size"], 5)
        created = agent.workspace_mkdir({"path": "selected/videos"})
        self.assertEqual(created["path"], "selected/videos")
        moved = agent.workspace_move({"source": "downloads/sample.mp4", "destination": "selected/videos/sample.mp4"})
        self.assertEqual(moved["destination"], "selected/videos/sample.mp4")
        deleted = agent.workspace_delete({"path": "selected/videos/sample.mp4"})
        self.assertTrue(deleted["deleted"])
        with self.assertRaises(agent.AgentApiError) as raised:
            agent.workspace_delete({"path": "selected"})
        self.assertEqual(raised.exception.code, "DIRECTORY_NOT_EMPTY")

    def test_workspace_file_tools_reject_invalid_paths_and_symlink_escape(self) -> None:
        invalid = ["../outside", "downloads/../../outside", "C:\\Windows", "downloads\\..\\outside", "foo/./bar"]
        for path in invalid:
            with self.subTest(path=path):
                with self.assertRaises(agent.AgentApiError) as raised:
                    agent.workspace_mkdir({"path": path})
                self.assertEqual(raised.exception.code, "WORKSPACE_PATH_INVALID")

        workspace = agent.WORKSPACE_PATH
        workspace.mkdir(parents=True, exist_ok=True)
        outside = self.root / "outside"
        outside.mkdir()
        try:
            os.symlink(outside, workspace / "external", target_is_directory=True)
        except OSError as error:
            self.skipTest(f"symlink creation is unavailable: {error.__class__.__name__}")
        with self.assertRaises(agent.AgentApiError) as raised:
            agent.workspace_list({"path": "external"})
        self.assertEqual(raised.exception.code, "WORKSPACE_PATH_INVALID")

    def test_health_serialization_omits_host_paths(self) -> None:
        snapshot = {
            "status": "ok", "agentVersion": "0.5.0", "interfaceVersion": 1, "workspace": {"status": "available"},
            "components": {
                "ytDlp": {"status": "available", "version": "x", "source": "local", "privatePath": "C:/private/yt-dlp.exe", "message": None},
                "deno": {"status": "available", "version": "x", "source": "local", "privatePath": "C:/private/deno.exe", "message": None},
                "ffmpeg": {"status": "available", "version": "x", "source": "local", "privatePath": "C:/private/ffmpeg.exe", "message": None},
                "ffprobe": {"status": "missing", "version": None, "source": None, "privatePath": None, "message": None},
            },
        }
        serialized = json.dumps(agent.public_health_document(snapshot))
        self.assertNotIn("C:/private", serialized)
        self.assertNotIn("privatePath", serialized)
        self.assertIn('"interfaceVersion": 1', serialized)

    def test_startup_log_explains_interface_version_requirement(self) -> None:
        messages: list[str] = []
        with patch.object(agent, "log", side_effect=lambda message, error=False: messages.append(message)):
            agent.log_startup_health({"interfaceVersion": 1, "workspace": {"status": "available"}, "components": {}}, 17843)
        self.assertIn(
            "Agent interface version: 1 — it must match the ResearchTube Extension interface version.",
            messages,
        )


class MediaProbeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.old_workspace = agent.WORKSPACE_PATH
        agent.WORKSPACE_PATH = self.root / "workspace"
        media = agent.WORKSPACE_PATH / "downloads" / "sample.mp4"
        media.parent.mkdir(parents=True)
        media.write_bytes(b"media")
        self.media = media

    async def asyncTearDown(self) -> None:
        agent.WORKSPACE_PATH = self.old_workspace
        self.temp.cleanup()

    async def test_media_probe_normalizes_ffprobe_output_without_host_path(self) -> None:
        class Process:
            returncode = 0

            async def communicate(self):
                return (json.dumps({
                    "format": {"duration": "1.5", "format_name": "mov,mp4,m4a,3gp,3g2,mj2", "bit_rate": "4000"},
                    "streams": [
                        {"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "avg_frame_rate": "30000/1001"},
                        {"codec_type": "audio", "codec_name": "aac", "sample_rate": "48000", "channels": 2, "bit_rate": "128000"},
                    ],
                }).encode("utf-8"), b"")

        with patch.object(agent, "find_component", return_value=agent.ComponentDiscovery("local", "/private/ffprobe")), patch.object(asyncio, "create_subprocess_exec", new=AsyncMock(return_value=Process())):
            result = await agent.media_probe({"path": "downloads/sample.mp4"})
        self.assertEqual(result["path"], "downloads/sample.mp4")
        self.assertEqual(result["container"], "mp4")
        self.assertEqual(result["video"], {"codec": "h264", "width": 1920, "height": 1080, "fps": 30000 / 1001})
        self.assertEqual(result["audio"]["sampleRate"], 48000)
        self.assertNotIn("/private", json.dumps(result))

    async def test_media_probe_reports_missing_ffprobe(self) -> None:
        with patch.object(agent, "find_component", return_value=agent.ComponentDiscovery(None, None)):
            with self.assertRaises(agent.AgentApiError) as raised:
                await agent.media_probe({"path": "downloads/sample.mp4"})
        self.assertEqual(raised.exception.code, "FFPROBE_NOT_AVAILABLE")

if __name__ == "__main__":
    unittest.main()
