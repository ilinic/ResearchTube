#!/usr/bin/env python3
"""Security and privacy checks for the shared workspace path foundation."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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
        workspace.mkdir(parents=True)
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

if __name__ == "__main__":
    unittest.main()
