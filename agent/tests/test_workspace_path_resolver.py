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
            "status": "ok", "agentVersion": "0.5.0", "interfaceVersion": 1,
            "platform": {"operatingSystem": "Windows", "release": "11", "version": "10.0.26100", "architecture": "AMD64"},
            "workspace": {"status": "available", "availableBytes": 123456789},
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
        self.assertIn('"operatingSystem": "Windows"', serialized)
        self.assertIn('"availableBytes": 123456789', serialized)

    def test_workspace_health_reports_available_space_without_a_path(self) -> None:
        health = agent.workspace_health()
        self.assertEqual(health["status"], "available")
        self.assertIsInstance(health["availableBytes"], int)
        self.assertGreaterEqual(health["availableBytes"], 0)

    def test_startup_log_explains_interface_version_requirement(self) -> None:
        messages: list[str] = []
        with patch.object(agent, "log", side_effect=lambda message, error=False: messages.append(message)):
            agent.log_startup_health({
                "interfaceVersion": 1,
                "platform": {"operatingSystem": "Windows", "release": "11", "version": "10.0", "architecture": "AMD64"},
                "workspace": {"status": "available", "availableBytes": 1}, "components": {},
            }, 17843)
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

    async def test_media_probe_returns_full_requested_metadata_without_host_filename(self) -> None:
        class Process:
            returncode = 0

            async def communicate(self):
                return (json.dumps({
                    "format": {
                        "filename": "/private/workspace/downloads/sample.mp4", "duration": "1.5", "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
                        "bit_rate": "4000", "size": "4", "tags": {"artist": "Example author", "location": "+12.345-45.678/"},
                    },
                    "streams": [
                        {"index": 0, "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "avg_frame_rate": "30000/1001", "tags": {"title": "Video"}},
                        {"index": 1, "codec_type": "audio", "codec_name": "aac", "sample_rate": "48000", "channels": 2, "bit_rate": "128000", "tags": {"language": "eng"}},
                    ],
                    "chapters": [{"id": 0, "start_time": "0.000000", "end_time": "1.500000", "tags": {"title": "Intro"}}],
                    "programs": [],
                }).encode("utf-8"), b"")

        create = AsyncMock(return_value=Process())
        with patch.object(agent, "find_component", return_value=agent.ComponentDiscovery("local", "/private/ffprobe")), patch.object(asyncio, "create_subprocess_exec", new=create):
            result = await agent.media_probe({"path": "downloads/sample.mp4"})
        self.assertEqual(result["path"], "downloads/sample.mp4")
        self.assertEqual(result["fileSizeBytes"], 5)
        self.assertEqual(result["ffprobeFileSizeBytes"], 4)
        self.assertEqual(result["sections"], ["format", "streams", "chapters", "programs"])
        self.assertEqual(result["probe"]["format"]["tags"]["location"], "+12.345-45.678/")
        self.assertEqual(result["probe"]["streams"][1]["tags"]["language"], "eng")
        self.assertNotIn("filename", result["probe"]["format"])
        self.assertNotIn("size", result["probe"]["format"])
        self.assertNotIn("/private", json.dumps(result))
        command = create.await_args.args
        self.assertIn("-show_format", command)
        self.assertIn("-show_streams", command)
        self.assertIn("-show_chapters", command)
        self.assertIn("-show_programs", command)

    async def test_media_probe_accepts_selected_sections_only(self) -> None:
        class Process:
            returncode = 0

            async def communicate(self):
                return json.dumps({"format": {"filename": "/private/workspace/downloads/sample.mp4", "size": "5", "tags": {"artist": "Example"}}}).encode("utf-8"), b""

        with patch.object(agent, "find_component", return_value=agent.ComponentDiscovery("local", "/private/ffprobe")), patch.object(asyncio, "create_subprocess_exec", new=AsyncMock(return_value=Process())):
            result = await agent.media_probe({"path": "downloads/sample.mp4", "sections": ["format"]})
        self.assertEqual(result["sections"], ["format"])
        self.assertEqual(result["probe"], {"format": {"tags": {"artist": "Example"}}})
        self.assertEqual(result["ffprobeFileSizeBytes"], 5)

    async def test_media_probe_rejects_invalid_sections(self) -> None:
        with self.assertRaises(agent.AgentApiError) as raised:
            await agent.media_probe({"path": "downloads/sample.mp4", "sections": ["packets"]})
        self.assertEqual(raised.exception.code, "MEDIA_PROBE_SECTIONS_INVALID")

    async def test_media_probe_reports_missing_ffprobe(self) -> None:
        with patch.object(agent, "find_component", return_value=agent.ComponentDiscovery(None, None)):
            with self.assertRaises(agent.AgentApiError) as raised:
                await agent.media_probe({"path": "downloads/sample.mp4"})
        self.assertEqual(raised.exception.code, "FFPROBE_NOT_AVAILABLE")


class CaptureFrameTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.old_workspace = agent.WORKSPACE_PATH
        agent.WORKSPACE_PATH = self.root / "workspace"
        self.media = agent.WORKSPACE_PATH / "downloads" / "sample.mp4"
        self.media.parent.mkdir(parents=True)
        self.media.write_bytes(b"media")
        self.ffprobe_calls = 0

    async def asyncTearDown(self) -> None:
        agent.WORKSPACE_PATH = self.old_workspace
        self.temp.cleanup()

    def test_default_capture_name_keeps_video_title_and_id_but_not_task_id(self) -> None:
        path = agent.capture_default_workspace_path(
            "downloads/Big Buck Bunny 60fps [yt_aqz-KE-bpKQ] [tsk_JD8tamsp3A].mp4",
            2.0,
            "png",
        )
        self.assertRegex(
            path,
            r"^captures/Big Buck Bunny 60fps \[yt_aqz-KE-bpKQ\] \[t_2\.000\] \[cap_[A-Za-z0-9_-]+\]\.png$",
        )
        self.assertNotIn("tsk_JD8tamsp3A", path)

    def test_youtube_capture_name_sanitizes_the_ytdlp_title(self) -> None:
        path = agent.youtube_capture_default_workspace_path('A: title / with * invalid?', "aqz-KE-bpKQ", 2.0, "png")
        self.assertRegex(path, r"^captures/A title with invalid \[yt_aqz-KE-bpKQ\] \[t_2\.000\] \[cap_[A-Za-z0-9_-]+\]\.png$")

    def discovery(self, name, _candidates):
        return agent.ComponentDiscovery("local", f"/private/{name}")

    async def subprocess(self, *command, **_kwargs):
        executable = command[0]
        if executable == "/private/ffprobe":
            self.ffprobe_calls += 1
            if self.ffprobe_calls == 1:
                document = {"streams": [
                    {"index": 0, "codec_type": "video", "width": 640, "height": 360,
                     "side_data_list": [{"rotation": 90}]},
                    {"index": 1, "codec_type": "audio"},
                    {"index": 2, "codec_type": "video", "width": 1920, "height": 1080},
                ]}
            else:
                document = {"streams": [{"index": 0, "codec_type": "video", "width": 200, "height": 100}]}
            payload = json.dumps(document).encode("utf-8")
            return type("Process", (), {"returncode": 0, "communicate": staticmethod(lambda: _bytes_result(payload, b""))})()
        if executable == "/private/ffmpeg":
            Path(command[-1]).write_bytes(b"image-bytes")
            return type("Process", (), {"returncode": 0, "communicate": staticmethod(lambda: _bytes_result(b"", b"[Parsed_showinfo_0] n:0 pts: 0 pts_time:12.500000\\n"))})()
        raise AssertionError(command)

    async def test_capture_frame_always_materializes_a_workspace_image(self) -> None:
        with patch.object(agent, "find_component", side_effect=self.discovery), patch.object(asyncio, "create_subprocess_exec", side_effect=self.subprocess):
            result = await agent.capture_frame({
                "path": "downloads/sample.mp4", "timestampSeconds": 12.5, "videoStreamIndex": 2,
                "crop": {"x": 4, "y": 2, "width": 200, "height": 100},
                "image": {"format": "png", "compressionLevel": 0},
            })
        self.assertEqual(result["sourcePath"], "downloads/sample.mp4")
        self.assertEqual(result["actualTimestampSeconds"], 12.5)
        self.assertEqual(result["selectedVideoStreamIndex"], 2)
        self.assertFalse(result["displayRotationApplied"])
        self.assertEqual(result["image"], {
            "format": "png", "mimeType": "image/png", "width": 200, "height": 100,
            "imageSizeBytes": 11, "workspacePath": result["image"]["workspacePath"],
        })
        self.assertRegex(result["image"]["workspacePath"], r"^captures/sample \[t_12\.500\] \[cap_[A-Za-z0-9_-]+\]\.png$")
        self.assertTrue((agent.WORKSPACE_PATH / "captures").is_dir())
        self.assertEqual((agent.WORKSPACE_PATH / result["image"]["workspacePath"]).read_bytes(), b"image-bytes")
        self.assertNotIn("inlineImageBase64", result)
        self.assertNotIn(str(self.root), json.dumps(result))

    async def test_capture_frame_honours_explicit_workspace_output_without_public_url(self) -> None:
        with patch.object(agent, "find_component", side_effect=self.discovery), patch.object(asyncio, "create_subprocess_exec", side_effect=self.subprocess):
            result = await agent.capture_frame({
                "path": "downloads/sample.mp4", "timestampSeconds": 0,
                "outputPath": "captures/custom.webp",
                "image": {"format": "webp", "quality": 75},
            })
        self.assertEqual(result["image"]["workspacePath"], "captures/custom.webp")
        self.assertNotIn("publicUrl", result["image"])
        self.assertNotIn("inlineImageBase64", result)
        self.assertEqual((agent.WORKSPACE_PATH / "captures" / "custom.webp").read_bytes(), b"image-bytes")

    async def test_capture_frame_can_download_only_a_youtube_time_section(self) -> None:
        async def youtube_subprocess(*command, **kwargs):
            if command[0] != "/private/ytDlp":
                return await self.subprocess(*command, **kwargs)
            if "--dump-single-json" in command:
                formats = {"formats": [{"format_id": "136", "vcodec": "avc1", "acodec": "none", "ext": "mp4", "width": 1280, "height": 720}]}
                return type("Process", (), {"returncode": 0, "communicate": staticmethod(lambda: _bytes_result(json.dumps(formats).encode(), b""))})()
            directory = Path(command[command.index("--paths") + 1])
            partial = directory / "partial [yt_aqz-KE-bpKQ] [cap_test].mp4"
            directory.mkdir(parents=True, exist_ok=True)
            partial.write_bytes(b"partial-media")
            stdout = f"__RESEARCHTUBE_CAPTURE_TITLE__:Correct: YouTube / title\n__RESEARCHTUBE_CAPTURE_PARTIAL__:{partial}\n".encode()
            return type("Process", (), {"returncode": 0, "communicate": staticmethod(lambda: _bytes_result(stdout, b""))})()

        with patch.object(agent, "PUBLIC_TUNNEL_URL", "https://example.trycloudflare.com"), patch.object(agent, "find_component", side_effect=self.discovery), patch.object(asyncio, "create_subprocess_exec", side_effect=youtube_subprocess):
            result = await agent.capture_frame({
                "youtube": {"videoId": "aqz-KE-bpKQ", "formatId": "136"}, "timestampSeconds": 24.0,
                "image": {"format": "png"},
            })
        self.assertEqual(result["sourcePath"], "youtube:aqz-KE-bpKQ")
        self.assertEqual(result["sourceVideoFormatId"], "136")
        self.assertEqual(result["sourceTitle"], "Correct: YouTube / title")
        self.assertEqual(result["partialDownload"], {"startSeconds": 12.0, "endSeconds": 27.0})
        self.assertEqual(result["actualTimestampSeconds"], 24.5)
        self.assertRegex(result["image"]["workspacePath"], r"^captures/Correct YouTube title \[yt_aqz-KE-bpKQ\] \[t_24\.000\] \[cap_[A-Za-z0-9_-]+\]\.png$")
        self.assertFalse((agent.WORKSPACE_PATH / ".researchtube-capture-tmp").exists())

    async def test_workspace_image_returns_encoded_bytes_without_host_path(self) -> None:
        image = agent.WORKSPACE_PATH / "captures" / "frame.png"
        image.parent.mkdir(parents=True)
        image.write_bytes(b"image-bytes")
        result = agent.workspace_image({"path": "captures/frame.png"})
        self.assertEqual(result["path"], "captures/frame.png")
        self.assertEqual(result["mimeType"], "image/png")
        self.assertEqual(result["imageSizeBytes"], 11)
        self.assertNotIn(str(self.root), json.dumps(result))
        self.assertEqual(result["inlineImageBase64"], "aW1hZ2UtYnl0ZXM=")

    async def test_capture_frame_rejects_invalid_transform_before_starting_processes(self) -> None:
        with self.assertRaises(agent.AgentApiError) as raised:
            await agent.capture_frame({
                "path": "downloads/sample.mp4", "timestampSeconds": 1,
                "resize": {"width": 100, "padColor": "red"},
            })
        self.assertEqual(raised.exception.code, "CAPTURE_FRAME_INVALID")


class PublicWorkspaceShareTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.old_workspace = agent.WORKSPACE_PATH
        agent.WORKSPACE_PATH = self.root / "workspace"
        image = agent.WORKSPACE_PATH / "captures" / "Bird.webp"
        image.parent.mkdir(parents=True)
        image.write_bytes(b"webp-bytes")
        (image.parent / "notes.txt").write_text("notes", encoding="utf-8")
        self.folder = agent.WorkspacePathResolver().resolve_existing("captures", field_name="folder", expected_type="directory")
        self.old_folder = agent.PUBLIC_SHARE_FOLDER
        self.old_file_types = agent.PUBLIC_SHARE_FILE_TYPES
        self.old_tunnel_url = agent.PUBLIC_TUNNEL_URL
        agent.PUBLIC_SHARE_FOLDER = self.folder
        agent.PUBLIC_SHARE_FILE_TYPES = ("images",)
        agent.PUBLIC_TUNNEL_URL = "https://example.trycloudflare.com"

    def tearDown(self) -> None:
        agent.WORKSPACE_PATH = self.old_workspace
        agent.PUBLIC_SHARE_FOLDER = self.old_folder
        agent.PUBLIC_SHARE_FILE_TYPES = self.old_file_types
        agent.PUBLIC_TUNNEL_URL = self.old_tunnel_url
        self.temp.cleanup()

    def test_public_share_repeats_its_selected_folder_in_the_url_path(self) -> None:
        image, mime_type = agent.public_share_file("/captures/Bird.webp")
        self.assertEqual(image.read_bytes(), b"webp-bytes")
        self.assertEqual(mime_type, "image/webp")
        self.assertEqual(agent.public_share_base_url(), "https://example.trycloudflare.com/captures/")

    def test_public_share_rejects_traversal_and_filtered_file_types(self) -> None:
        for path in ("/%2e%2e/Bird.webp", "/notes.txt", "/Bird.webp", "/captures/notes.txt", "/"):
            with self.subTest(path=path), self.assertRaises(agent.AgentApiError) as raised:
                agent.public_share_file(path)
            self.assertEqual(raised.exception.code, "PUBLIC_SHARE_NOT_FOUND")

    def test_workspace_share_options_accepts_only_the_documented_selectors(self) -> None:
        folder, file_types = agent.workspace_share_options({"folder": "captures", "fileTypes": ["images", "documents"]})
        self.assertEqual(folder.logical_path, "captures")
        self.assertEqual(file_types, ("images", "documents"))
        with self.assertRaises(agent.AgentApiError):
            agent.workspace_share_options({"folder": "captures", "fileTypes": ["all", "images"]})


async def _bytes_result(stdout: bytes, stderr: bytes):
    return stdout, stderr

if __name__ == "__main__":
    unittest.main()
