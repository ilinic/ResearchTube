#!/usr/bin/env python3
"""Local tools layout discovery checks."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent import researchtube_agent as agent


class ComponentDiscoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.old_root = agent.ROOT
        self.old_tools = agent.TOOLS_PATH
        agent.ROOT = self.root
        agent.TOOLS_PATH = self.root / "tools"

    def tearDown(self) -> None:
        agent.ROOT = self.old_root
        agent.TOOLS_PATH = self.old_tools
        self.temp.cleanup()

    def touch_tool(self, relative: str) -> Path:
        path = agent.TOOLS_PATH / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("placeholder", encoding="utf-8")
        return path

    def test_finds_direct_ytdlp_deno_and_extracted_ffmpeg_bin(self) -> None:
        yt_dlp = self.touch_tool("yt-dlp/yt-dlp.exe")
        deno = self.touch_tool("deno/deno-v2.6.1/windows/x64/bin/deno.exe")
        ffmpeg = self.touch_tool("ffmpeg/ffmpeg-release-essentials/bin/ffmpeg.exe")
        ffprobe = self.touch_tool("ffmpeg/ffmpeg-release-essentials/bin/ffprobe.exe")
        self.assertEqual(agent.find_component("ytDlp", ("yt-dlp.exe",)).executable, str(yt_dlp.resolve()))
        self.assertEqual(agent.find_component("deno", ("deno.exe",)).executable, str(deno.resolve()))
        self.assertEqual(agent.find_component("ffmpeg", ("ffmpeg.exe",)).executable, str(ffmpeg.resolve()))
        self.assertEqual(agent.find_component("ffprobe", ("ffprobe.exe",)).executable, str(ffprobe.resolve()))

    def test_rejects_multiple_extracted_ffmpeg_packages(self) -> None:
        self.touch_tool("ffmpeg/build-one/bin/ffmpeg.exe")
        self.touch_tool("ffmpeg/build-two/bin/ffmpeg.exe")
        result = agent.find_component("ffmpeg", ("ffmpeg.exe",))
        self.assertIsNone(result.executable)
        self.assertIn("Multiple ffmpeg executables", result.error or "")

    def test_ignores_executable_beside_agent(self) -> None:
        adjacent = agent.ROOT / "ffmpeg.exe"
        adjacent.write_text("obsolete location", encoding="utf-8")
        with patch.object(agent.shutil, "which", return_value=None):
            result = agent.find_component("ffmpeg", ("ffmpeg.exe",))
        self.assertIsNone(result.executable)
        self.assertIsNone(result.source)


if __name__ == "__main__":
    unittest.main()
