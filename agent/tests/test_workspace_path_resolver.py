#!/usr/bin/env python3
"""Security and privacy checks for the shared workspace path foundation."""

from __future__ import annotations

import asyncio
import json
import os
import struct
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

    def test_widget_image_url_resolves_only_a_workspace_image(self) -> None:
        image = agent.WORKSPACE_PATH / "captures" / "frame.png"
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(b"png")
        physical, mime_type = agent.widget_image_file("captures/frame.png")
        self.assertEqual(physical, image)
        self.assertEqual(mime_type, "image/png")
        with self.assertRaises(agent.AgentApiError) as raised:
            agent.widget_image_file("../outside.png")
        self.assertEqual(raised.exception.code, "WORKSPACE_PATH_INVALID")

    def test_workspace_image_metadata_does_not_read_or_return_image_bytes(self) -> None:
        image = agent.WORKSPACE_PATH / "captures" / "frame.png"
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(b"image-bytes")
        _item, metadata = agent.workspace_image_metadata({"path": "captures/frame.png"})
        self.assertEqual(metadata, {"path": "captures/frame.png", "mediaKind": "image", "mimeType": "image/png", "sizeBytes": 11})
        self.assertNotIn("inlineImageBase64", metadata)

    def test_workspace_media_metadata_accepts_camera_video_and_audio(self) -> None:
        video = agent.WORKSPACE_PATH / "webcamera" / "C922 2026-09-24T01_11_26Z [cam_abcdefghij].mp4"
        audio = agent.WORKSPACE_PATH / "sound" / "C922 2026-09-24T01_11_26Z [cam_abcdefghij].m4a"
        video.parent.mkdir(parents=True, exist_ok=True)
        audio.parent.mkdir(parents=True, exist_ok=True)
        video.write_bytes(b"video")
        audio.write_bytes(b"audio")
        _item, video_metadata = agent.workspace_image_metadata({"path": "webcamera/C922 2026-09-24T01_11_26Z [cam_abcdefghij].mp4"})
        _item, audio_metadata = agent.workspace_image_metadata({"path": "sound/C922 2026-09-24T01_11_26Z [cam_abcdefghij].m4a"})
        self.assertEqual(video_metadata, {"path": "webcamera/C922 2026-09-24T01_11_26Z [cam_abcdefghij].mp4", "mediaKind": "video", "mimeType": "video/mp4", "sizeBytes": 5})
        self.assertEqual(audio_metadata, {"path": "sound/C922 2026-09-24T01_11_26Z [cam_abcdefghij].m4a", "mediaKind": "audio", "mimeType": "audio/mp4", "sizeBytes": 5})

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
        with patch.object(agent, "log", side_effect=lambda message, error=False, color=None: messages.append(message)):
            agent.log_startup_health({
                "interfaceVersion": 1,
                "platform": {"operatingSystem": "Windows", "release": "11", "version": "10.0", "architecture": "AMD64"},
                "workspace": {"status": "available", "availableBytes": 1}, "components": {},
            }, 17843)
        self.assertIn(
            "Agent interface version: 1 — it must match the ResearchTube Extension interface version.",
            messages,
        )

    def test_library_store_files_resolves_workspace_images_only(self) -> None:
        captures = agent.WORKSPACE_PATH / "captures"
        captures.mkdir(parents=True)
        image = captures / "frame.png"
        image.write_bytes(b"png")
        resolved = agent.library_store_files({"files": [{"workspacePath": "captures/frame.png"}]})
        self.assertEqual(resolved["files"][0]["workspacePath"], "captures/frame.png")
        self.assertEqual(Path(resolved["files"][0]["localPath"]), image.resolve())
        with self.assertRaises(agent.AgentApiError) as raised:
            agent.library_store_files({"files": [{"workspacePath": "captures/missing.png"}]})
        self.assertEqual(raised.exception.code, "FILE_NOT_FOUND")


class VisualMapContractTests(unittest.TestCase):
    def test_visual_map_task_snapshot_reports_compact_progress(self) -> None:
        manager = agent.VisualMapTaskManager()
        task = agent.VisualMapTask("vismap_example", {}, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
        manager.update_progress(task, "extractingFrames", 42.5, "Extracting video frames.", 3, 6, 0, 1)
        snapshot = manager.snapshot(task)
        self.assertEqual(snapshot["taskId"], "vismap_example")
        self.assertEqual(snapshot["phase"], "extractingFrames")
        self.assertEqual(snapshot["progressPercent"], 42.5)
        self.assertEqual(snapshot["completedFrames"], 3)
        self.assertEqual(agent.response_log_suffix("/tasks/visual-map/vismap_example", snapshot), " 42.5%")

    def test_visual_map_cancel_marks_a_running_task_for_cancellation(self) -> None:
        async def check() -> None:
            manager = agent.VisualMapTaskManager()
            task = agent.VisualMapTask("vismap_cancel", {}, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
            task.runner = asyncio.create_task(asyncio.sleep(60))
            manager.tasks[task.task_id] = task
            await manager.cancel(task.task_id)
            await asyncio.sleep(0)
            self.assertTrue(task.runner.cancelled())
            self.assertEqual(task.status_message, "Visual-map cancellation requested.")

        asyncio.run(check())

    def test_uniform_timestamps_use_range_boundaries(self) -> None:
        self.assertEqual(agent.uniform_visual_map_timestamps(1, 10, 4), [1, 4, 7, 10])
        self.assertEqual(agent.uniform_visual_map_timestamps(1, 10, 1), [1])

    def test_timestamp_labels_are_readable_without_unnecessary_hours(self) -> None:
        self.assertEqual(agent.visual_map_timestamp_label(8), "0:08")
        self.assertEqual(agent.visual_map_timestamp_label(185), "3:05")
        self.assertEqual(agent.visual_map_timestamp_label(3729), "1:02:09")

    def test_final_visual_map_sample_stays_on_the_video_track(self) -> None:
        self.assertLess(agent.visual_map_extract_timestamp(634.566667, 634.566667, 60), 634.55)
        self.assertGreater(agent.visual_map_extract_timestamp(634.566667, 634.566667, 60), 634.54)

    def test_visual_map_default_name_uses_short_tag(self) -> None:
        path = agent.visual_map_default_path("downloads/video.mp4", 1, "abcde")
        self.assertIn("[vismap_abcde_001].png", path)

    def test_timestamp_filter_uses_an_explicit_font_file(self) -> None:
        with patch.object(agent, "visual_map_font_file", return_value=Path("/agent/tools/fonts/DejaVuSans.ttf")):
            filter_value = agent.visual_map_label_filter("3:05", "bottomRight", 144)
        self.assertIn("fontfile='/agent/tools/fonts/DejaVuSans.ttf'", filter_value)
        self.assertIn("text='3\\:05'", filter_value)
        self.assertIn("box=1", filter_value)

    def test_timestamp_font_must_be_a_font_filename(self) -> None:
        with patch.object(agent, "CONFIG_PATH") as config_path:
            config_path.read_text.return_value = '{"visualMapTimestampFont":"../Arial.ttf"}'
            with self.assertRaises(agent.AgentApiError) as raised:
                agent.configured_visual_map_timestamp_font()
        self.assertEqual(raised.exception.code, "VISUAL_MAP_TIMESTAMP_FONT_INVALID")

    def test_scene_detect_keeps_the_strongest_candidates_two_seconds_apart_then_sorts_them(self) -> None:
        candidates = [
            agent.VisualMapSceneCandidate(1.0, 12.0),
            agent.VisualMapSceneCandidate(2.5, 22.0),
            agent.VisualMapSceneCandidate(4.4, 18.0),
            agent.VisualMapSceneCandidate(8.0, 30.0),
            agent.VisualMapSceneCandidate(12.0, 16.0),
        ]
        selected = agent.select_visual_map_scene_candidates(candidates, 3)
        self.assertEqual([(candidate.timestamp_seconds, candidate.delta) for candidate in selected], [(2.5, 22.0), (8.0, 30.0), (12.0, 16.0)])

    def test_scene_detect_parses_only_valid_ffmpeg_scene_metadata_in_the_requested_range(self) -> None:
        metadata = b"frame:0 pts:1500 pts_time:1.5\nlavfi.scd.mafd=54.000\nlavfi.scd.score=12.500\nlavfi.scd.time=1.5\nframe:1 pts:9000 pts_time:9\nlavfi.scd.score=25.000\nlavfi.scd.time=9\nframe:2 pts:12000 pts_time:12\nlavfi.scd.score=99.000\nlavfi.scd.time=12\n"
        candidates = agent.visual_map_scene_candidates(metadata, 1, 10)
        self.assertEqual(candidates, [agent.VisualMapSceneCandidate(1.5, 12.5), agent.VisualMapSceneCandidate(9.0, 25.0)])

    def test_scene_detect_filter_uses_native_scdet_percentage_threshold(self) -> None:
        self.assertEqual(
            agent.visual_map_scene_detect_filter(1, 10, 12.5),
            "trim=start=1.000000000:end=10.000000000,scdet=threshold=12.500000:sc_pass=1,metadata=print:file=-:direct=1",
        )

    def test_hybrid_selects_strongest_scene_per_interval_or_its_midpoint(self) -> None:
        timestamps = agent.hybrid_visual_map_timestamps([
            agent.VisualMapSceneCandidate(2.0, 15.0),
            agent.VisualMapSceneCandidate(12.0, 20.0),
            agent.VisualMapSceneCandidate(18.0, 12.0),
            agent.VisualMapSceneCandidate(35.0, 16.0),
        ], 0, 40, 4)
        self.assertEqual(timestamps, [2.0, 12.0, 25.0, 35.0])

    def test_visual_map_options_support_scene_detect_and_reject_other_selection_modes(self) -> None:
        scene_detect = agent.visual_map_options({"workspacePath": "downloads/video.mp4", "columns": 3, "rows": 2, "maxTotalFrames": 6, "selection": "sceneDetect"})
        self.assertEqual(scene_detect["selection"], "sceneDetect")
        self.assertEqual(scene_detect["sceneDetectThreshold"], 10.0)
        self.assertEqual(agent.visual_map_options({"workspacePath": "downloads/video.mp4", "columns": 3, "rows": 2, "maxTotalFrames": 6, "selection": "sceneDetect", "sceneDetectThreshold": 15.5})["sceneDetectThreshold"], 15.5)
        hybrid = agent.visual_map_options({"workspacePath": "downloads/video.mp4", "columns": 3, "rows": 2, "maxTotalFrames": 6, "selection": "hybrid"})
        self.assertEqual(hybrid["sceneDetectThreshold"], 10.0)
        with self.assertRaises(agent.AgentApiError) as raised:
            agent.visual_map_options({"workspacePath": "downloads/video.mp4", "columns": 3, "rows": 2, "maxTotalFrames": 6, "selection": "scdet"})
        self.assertEqual(raised.exception.code, "VISUAL_MAP_INVALID")
        with self.assertRaises(agent.AgentApiError):
            agent.visual_map_options({"workspacePath": "downloads/video.mp4", "columns": 3, "rows": 2, "maxTotalFrames": 6, "selection": "sceneDetect", "sceneDetectThreshold": 100.1})
        with self.assertRaises(agent.AgentApiError):
            agent.visual_map_options({"workspacePath": "downloads/video.mp4", "columns": 3, "rows": 2, "maxTotalFrames": 6, "sceneDetectThreshold": 10})

    def test_visual_map_options_default_to_uniform_and_timestamp_labels(self) -> None:
        result = agent.visual_map_options({"workspacePath": "downloads/video.mp4", "columns": 3, "rows": 2, "maxTotalFrames": 6})
        self.assertEqual(result["selection"], "uniform")
        self.assertIsNone(result["sceneDetectThreshold"])
        self.assertEqual(result["frameTimestampPosition"], "bottomRight")
        self.assertEqual(result["startSeconds"], 0)

    def test_visual_map_downscales_but_never_upscales(self) -> None:
        self.assertEqual(agent.visual_map_thumbnail_size(1920, 1080, 2, 2, 4096), (1920, 1080))
        self.assertEqual(agent.visual_map_thumbnail_size(1920, 1080, 6, 4, 4096), (682, 384))


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
    def test_capture_title_preserves_cyrillic_while_replacing_windows_invalid_characters(self) -> None:
        self.assertEqual(
            agent.safe_capture_title('Народу было много,строили долго."(С)Официальные историки'),
            "Народу было много,строили долго._(С)Официальные историки",
        )

    async def asyncSetUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.old_workspace = agent.WORKSPACE_PATH
        agent.WORKSPACE_PATH = self.root / "workspace"
        self.media = agent.WORKSPACE_PATH / "downloads" / "sample.mp4"
        self.media.parent.mkdir(parents=True)
        self.media.write_bytes(b"media")
        self.source_image = agent.WORKSPACE_PATH / "captures" / "source.png"
        self.source_image.parent.mkdir(parents=True, exist_ok=True)
        self.source_image.write_bytes(b"source-image")
        self.ffprobe_calls = 0

    async def asyncTearDown(self) -> None:
        agent.WORKSPACE_PATH = self.old_workspace
        self.temp.cleanup()

    async def test_widget_image_post_copies_the_resolved_logical_path(self) -> None:
        target = agent.WORKSPACE_PATH / "captures" / "widget.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"png")
        copied = AsyncMock(return_value={"success": True, "type": "text", "revision": "cb_test"})
        with patch.object(agent, "clipboard_set", new=copied):
            result = await agent.copy_widget_workspace_path("captures/widget.png")
        self.assertEqual(result, {"success": True})
        copied.assert_awaited_once_with({"text": "captures/widget.png"})

    def test_default_capture_name_keeps_video_title_and_id_but_not_task_id(self) -> None:
        path = agent.capture_default_workspace_path(
            "downloads/Big Buck Bunny 60fps [yt_aqz-KE-bpKQ] [tsk_JD8tamsp3A].mp4",
            2.0,
            "png",
        )
        self.assertRegex(
            path,
            r"^captures/Big Buck Bunny 60fps \[yt_aqz-KE-bpKQ\] \[t_2\.000\] \[cap_[A-Za-z0-9_-]{8}\]\.png$",
        )
        self.assertNotIn("tsk_JD8tamsp3A", path)

    def test_default_capture_name_preserves_partial_provenance(self) -> None:
        path = agent.capture_default_workspace_path(
            "downloads/Big Buck Bunny [yt_aqz-KE-bpKQ] [partial_12.500_47.250] [tsk_JD8tamsp3A].mp4",
            2.0,
            "png",
        )
        self.assertRegex(path, r"^captures/Big Buck Bunny \[yt_aqz-KE-bpKQ\] \[partial_12\.500_47\.250\] \[t_2\.000\] \[cap_[A-Za-z0-9_-]{8}\]\.png$")

    def test_screen_capture_defaults_to_a_workspace_screenshots_png(self) -> None:
        options = agent.screen_capture_options({})
        self.assertEqual(options["image"], {"format": "png", "quality": None})
        self.assertRegex(options["outputPath"], r"^screenshots/screenshot_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[A-Za-z0-9_-]+\.png$")

    def test_screen_capture_validates_matching_output_extension(self) -> None:
        self.assertEqual(agent.screen_capture_options({"outputPath": "screenshots/desktop.jpg", "image": {"format": "jpeg", "quality": 85}})["outputPath"], "screenshots/desktop.jpg")
        with self.assertRaisesRegex(agent.AgentApiError, "extension must match"):
            agent.screen_capture_options({"outputPath": "screenshots/desktop.png", "image": {"format": "jpeg"}})

    def test_clipboard_dib_metadata_validates_a_small_bitmap_without_accessing_clipboard(self) -> None:
        dib = struct.pack("<IiiHHIIiiII", 40, 2, 3, 1, 24, 0, 24, 0, 0, 0, 0) + (b"\0" * 24)
        self.assertEqual(agent.clipboard_dib_metadata(dib), {"width": 2, "height": 3, "pixelOffset": 40})
        self.assertTrue(agent.clipboard_bmp_from_dib(dib).startswith(b"BM"))

    def test_clipboard_tools_reject_non_windows_without_reading_any_data(self) -> None:
        if os.name == "nt":
            self.skipTest("This platform-neutral guard is covered by Windows integration tests.")
        with self.assertRaisesRegex(agent.AgentApiError, "System clipboard access") as context:
            agent.clipboard_status({})
        self.assertEqual(context.exception.code, "CLIPBOARD_UNAVAILABLE")

    async def test_linux_screen_capture_requires_x11_display_without_python_dependency(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(agent.AgentApiError, "requires an X11 DISPLAY") as context:
                await agent.capture_screen_x11({})
        self.assertEqual(context.exception.code, "SCREEN_CAPTURE_UNAVAILABLE")

    def test_youtube_capture_name_sanitizes_the_ytdlp_title(self) -> None:
        path = agent.youtube_capture_default_workspace_path('A: title / with * invalid?', "aqz-KE-bpKQ", 2.0, "png")
        self.assertRegex(path, r"^captures/A_ title _ with _ invalid_ \[yt_aqz-KE-bpKQ\] \[t_2\.000\] \[cap_[A-Za-z0-9_-]{8}\]\.png$")

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
        self.assertRegex(result["image"]["workspacePath"], r"^captures/sample \[t_12\.500\] \[cap_[A-Za-z0-9_-]{8}\]\.png$")
        self.assertTrue((agent.WORKSPACE_PATH / "captures").is_dir())
        self.assertEqual((agent.WORKSPACE_PATH / result["image"]["workspacePath"]).read_bytes(), b"image-bytes")
        self.assertNotIn("inlineImageBase64", result)
        self.assertNotIn(str(self.root), json.dumps(result))

    async def test_windows_screen_capture_uses_ffmpeg_gdigrab_and_reports_virtual_desktop(self) -> None:
        commands: list[tuple[str, ...]] = []

        async def windows_subprocess(*command, **_kwargs):
            commands.append(command)
            if command[0] == "/private/ffmpeg":
                Path(command[-1]).write_bytes(b"screen-image")
                return type("Process", (), {"returncode": 0, "communicate": staticmethod(lambda: _bytes_result(b"", b""))})()
            if command[0] == "/private/ffprobe":
                payload = json.dumps({"streams": [{"index": 0, "codec_type": "video", "width": 3200, "height": 1080}]}).encode("utf-8")
                return type("Process", (), {"returncode": 0, "communicate": staticmethod(lambda: _bytes_result(payload, b""))})()
            raise AssertionError(command)

        virtual_desktop = {"left": -1280, "top": 0, "width": 3200, "height": 1080}
        with patch.object(agent, "windows_virtual_desktop", return_value=(virtual_desktop, 2)), patch.object(agent, "find_component", side_effect=self.discovery), patch.object(asyncio, "create_subprocess_exec", side_effect=windows_subprocess):
            result = await agent.capture_screen_windows({"outputPath": "screenshots/windows.png"})
        self.assertEqual(result["virtualDesktop"], virtual_desktop)
        self.assertEqual(result["monitorCount"], 2)
        self.assertEqual(result["width"], 3200)
        self.assertEqual(result["height"], 1080)
        self.assertEqual(result["workspacePath"], "screenshots/windows.png")
        self.assertEqual(commands[0][commands[0].index("-f") + 1], "gdigrab")
        self.assertEqual(commands[0][commands[0].index("-offset_x") + 1], "-1280")
        self.assertEqual(commands[0][commands[0].index("-video_size") + 1], "3200x1080")
        self.assertIn("desktop", commands[0])

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

    async def test_image_crop_creates_a_new_workspace_image_without_overwriting_source(self) -> None:
        with patch.object(agent, "find_component", side_effect=self.discovery), patch.object(asyncio, "create_subprocess_exec", side_effect=self.subprocess):
            result = await agent.image_crop({
                "path": "captures/source.png",
                "crop": {"x": 4, "y": 2, "width": 200, "height": 100},
                "image": {"format": "webp", "quality": 75},
                "outputPath": "crops/selected.webp",
            })
        self.assertEqual(result["sourcePath"], "captures/source.png")
        self.assertEqual(result["sourceWidth"], 640)
        self.assertEqual(result["sourceHeight"], 360)
        self.assertEqual(result["crop"], {"x": 4, "y": 2, "width": 200, "height": 100})
        self.assertEqual(result["image"], {
            "format": "webp", "mimeType": "image/webp", "width": 200, "height": 100,
            "imageSizeBytes": 11, "workspacePath": "crops/selected.webp",
        })
        self.assertEqual(self.source_image.read_bytes(), b"source-image")
        self.assertEqual((agent.WORKSPACE_PATH / "crops" / "selected.webp").read_bytes(), b"image-bytes")
        self.assertNotIn(str(self.root), json.dumps(result))

    async def test_image_crop_rejects_a_rectangle_outside_the_source_image(self) -> None:
        with patch.object(agent, "find_component", side_effect=self.discovery), patch.object(asyncio, "create_subprocess_exec", side_effect=self.subprocess):
            with self.assertRaisesRegex(agent.AgentApiError, "completely within") as raised:
                await agent.image_crop({
                    "path": "captures/source.png",
                    "crop": {"x": 500, "y": 2, "width": 200, "height": 100},
                })
        self.assertEqual(raised.exception.code, "IMAGE_CROP_INVALID")

    async def test_capture_frame_can_download_only_a_youtube_time_section(self) -> None:
        capture_commands: list[tuple[str, ...]] = []

        async def youtube_subprocess(*command, **kwargs):
            if command[0] != "/private/ytDlp":
                return await self.subprocess(*command, **kwargs)
            if "--dump-single-json" in command:
                formats = {"formats": [{"format_id": "136", "vcodec": "avc1", "acodec": "none", "ext": "mp4", "width": 1280, "height": 720}]}
                return type("Process", (), {"returncode": 0, "communicate": staticmethod(lambda: _bytes_result(json.dumps(formats).encode(), b""))})()
            capture_commands.append(command)
            directory = Path(command[command.index("--paths") + 1])
            partial = directory / "partial [yt_aqz-KE-bpKQ] [cap_test].mp4"
            directory.mkdir(parents=True, exist_ok=True)
            partial.write_bytes(b"partial-media")
            stdout = f'__RESEARCHTUBE_CAPTURE_TITLE__:Народу было много,строили долго."(С)Официальные историки\n__RESEARCHTUBE_CAPTURE_PARTIAL__:{partial}\n'.encode()
            return type("Process", (), {"returncode": 0, "communicate": staticmethod(lambda: _bytes_result(stdout, b""))})()

        with patch.object(agent, "PUBLIC_TUNNEL_URL", "https://example.trycloudflare.com"), patch.object(agent, "find_component", side_effect=self.discovery), patch.object(agent, "youtube_pot_provider_status", return_value={"state": "ready", "provider": "bgutil"}), patch.object(asyncio, "create_subprocess_exec", side_effect=youtube_subprocess):
            result = await agent.capture_frame({
                "youtube": {"videoId": "aqz-KE-bpKQ", "formatId": "136"}, "timestampSeconds": 24.0,
                "image": {"format": "png"},
            })
        self.assertEqual(result["sourcePath"], "youtube:aqz-KE-bpKQ")
        self.assertEqual(result["sourceVideoFormatId"], "136")
        self.assertEqual(result["sourceTitle"], 'Народу было много,строили долго."(С)Официальные историки')
        self.assertEqual(result["partialDownload"], {"startSeconds": 12.0, "endSeconds": 27.0})
        self.assertEqual(result["actualTimestampSeconds"], 24.5)
        self.assertTrue(result["image"]["workspacePath"].startswith("captures/Народу было много,строили долго._(С)Официальные историки [yt_aqz-KE-bpKQ] [t_24.000] [cap_"))
        self.assertNotIn("--windows-filenames", capture_commands[0])
        self.assertIn("--encoding", capture_commands[0])
        self.assertIn("utf-8", capture_commands[0])
        self.assertFalse((agent.WORKSPACE_PATH / ".researchtube-capture-tmp").exists())

    async def test_youtube_batch_downloads_each_partial_section_independently(self) -> None:
        commands: list[tuple[str, ...]] = []

        async def youtube_subprocess(*command, **_kwargs):
            commands.append(command)
            directory = Path(command[command.index("--paths") + 1])
            template = command[command.index("--output") + 1]
            partial = directory / template.replace("%(ext)s", "mp4")
            directory.mkdir(parents=True, exist_ok=True)
            partial.write_bytes(b"partial-media")
            stdout = f"__RESEARCHTUBE_CAPTURE_TITLE__:Example video\n__RESEARCHTUBE_CAPTURE_PARTIAL__:{partial}\n".encode()
            return type("Process", (), {"returncode": 0, "communicate": staticmethod(lambda: _bytes_result(stdout, b""))})()

        extracted = AsyncMock(side_effect=lambda options: {
            "actualTimestampSeconds": options["timestampSeconds"],
            "image": {"workspacePath": f"captures/frame-{options['timestampSeconds']}.png"},
        })
        progress: list[tuple[int, int]] = []
        options = agent.capture_frames_options({
            "youtube": {"videoId": "aqz-KE-bpKQ", "formatId": "136"},
            "timestampsSeconds": [30, 130], "image": {"format": "png"},
        })
        formats = {"downloadFormats": {"combined": [], "video": [{"formatId": "136"}], "audio": []}}
        with patch.object(agent, "find_component", side_effect=self.discovery), patch.object(agent, "youtube_pot_provider_status", return_value={"state": "ready", "provider": "bgutil"}), patch.object(agent, "youtube_download_formats", new=AsyncMock(return_value=formats)), patch.object(agent, "capture_frame_from_workspace_options", new=extracted), patch.object(asyncio, "create_subprocess_exec", side_effect=youtube_subprocess), patch.object(asyncio, "sleep", new=AsyncMock()):
            results = await agent.capture_youtube_frames(options, lambda completed, total, _frame: progress.append((completed, total)), {})
        self.assertEqual(len(commands), 2)
        self.assertEqual([command[command.index("--download-sections") + 1] for command in commands], ["*18.000-33.000", "*118.000-133.000"])
        self.assertTrue(all(command.count("--download-sections") == 1 for command in commands))
        self.assertEqual(progress, [(1, 2), (2, 2)])
        self.assertEqual([result["requestedTimestampSeconds"] for result in results], [30, 130])

    def test_youtube_batch_merges_nearby_windows_but_caps_one_section_at_sixty_seconds(self) -> None:
        sections = agent.youtube_capture_sections([30, 50, 70, 80, 230])
        self.assertEqual(sections, [
            (18.0, 73.0, [30, 50, 70]),
            (68.0, 83.0, [80]),
            (218.0, 233.0, [230]),
        ])
        self.assertTrue(all(end - start <= 60 for start, end, _timestamps in sections))

    def test_youtube_batch_merges_a_gap_of_ten_seconds_but_not_more(self) -> None:
        self.assertEqual(agent.youtube_capture_sections([30, 55]), [(18.0, 58.0, [30, 55])])
        self.assertEqual(agent.youtube_capture_sections([30, 56]), [(18.0, 33.0, [30]), (44.0, 59.0, [56])])

    def test_youtube_section_progress_parses_ytdlp_and_ffmpeg_output(self) -> None:
        self.assertEqual(agent.youtube_section_download_progress(b"[download]  42.7% of 10.00MiB", 15.0), 42.7)
        self.assertAlmostEqual(agent.youtube_section_download_progress(b"frame=  42 fps=0.0 time=00:00:07.50 bitrate=0.0kbits/s", 15.0), 50.0)
        self.assertIsNone(agent.youtube_section_download_progress(b"unrelated output", 15.0))

    def test_youtube_section_size_estimate_uses_advertised_bitrate(self) -> None:
        self.assertEqual(agent.youtube_section_expected_bytes({"bitrateBps": 800_000}, 15.0), 1_500_000)
        self.assertIsNone(agent.youtube_section_expected_bytes({"bitrateBps": None}, 15.0))

    def test_speech_options_and_task_snapshot_are_compact(self) -> None:
        self.assertEqual(agent.speech_options({"text": "Привет", "voiceId": None}), {"text": "Привет", "voiceId": None})
        self.assertEqual(agent.WINDOWS_SPEECH_SCRIPT_PATH.name, "researchtube_speech.py")
        self.assertEqual(agent.normalize_speech_voice({"voiceId": "id", "name": "Voice", "language": "ru-RU", "gender": "unknown", "isDefault": False})["gender"], "neutral")
        with self.assertRaises(agent.AgentApiError) as error:
            agent.speech_options({"text": ""})
        self.assertEqual(error.exception.code, "SPEECH_INVALID")
        manager = agent.SpeechTaskManager()
        task = agent.SpeechTask("tsk_abcdefghij", "Hello", None, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
        self.assertEqual(manager.snapshot(task)["status"], "working")
        self.assertEqual(manager.snapshot(task)["phase"], "preparing")

    async def test_youtube_batch_retries_only_the_failed_section(self) -> None:
        commands: list[tuple[str, ...]] = []

        async def youtube_subprocess(*command, **_kwargs):
            commands.append(command)
            if len(commands) == 1:
                return type("Process", (), {"returncode": 1, "communicate": staticmethod(lambda: _bytes_result(b"", b"ERROR: ffmpeg exited with code 1"))})()
            directory = Path(command[command.index("--paths") + 1])
            partial = directory / command[command.index("--output") + 1].replace("%(ext)s", "mp4")
            directory.mkdir(parents=True, exist_ok=True)
            partial.write_bytes(b"partial-media")
            stdout = f"__RESEARCHTUBE_CAPTURE_TITLE__:Example video\n__RESEARCHTUBE_CAPTURE_PARTIAL__:{partial}\n".encode()
            return type("Process", (), {"returncode": 0, "communicate": staticmethod(lambda: _bytes_result(stdout, b""))})()

        options = agent.capture_frames_options({"youtube": {"videoId": "aqz-KE-bpKQ", "formatId": "136"}, "timestampsSeconds": [130], "image": {"format": "png"}})
        formats = {"downloadFormats": {"combined": [], "video": [{"formatId": "136"}], "audio": []}}
        extracted = AsyncMock(return_value={"actualTimestampSeconds": 12.0, "image": {"workspacePath": "captures/frame.png"}})
        sleeper = AsyncMock()
        diagnostics: dict[str, object] = {}
        with patch.object(agent, "find_component", side_effect=self.discovery), patch.object(agent, "youtube_pot_provider_status", return_value={"state": "ready", "provider": "bgutil"}), patch.object(agent, "youtube_download_formats", new=AsyncMock(return_value=formats)), patch.object(agent, "capture_frame_from_workspace_options", new=extracted), patch.object(asyncio, "create_subprocess_exec", side_effect=youtube_subprocess), patch.object(asyncio, "sleep", new=sleeper):
            results = await agent.capture_youtube_frames(options, lambda *_args: None, diagnostics)
        self.assertEqual(len(commands), 2)
        self.assertEqual([command[command.index("--download-sections") + 1] for command in commands], ["*118.000-133.000", "*118.000-133.000"])
        sleeper.assert_awaited_once_with(3.0)
        self.assertEqual(len(results), 1)
        self.assertNotIn("failedSection", diagnostics["youtube"])

    def test_failed_frame_task_snapshot_preserves_completed_frames_and_section(self) -> None:
        manager = agent.CaptureFrameTaskManager()
        task = agent.CaptureFrameTask("frame_test", {}, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", total_frames=9)
        task.status = "failed"
        task.completed_frames = 4
        task.frames = [{"sourcePath": "youtube:example"}] * 4
        task.error = {"code": "YOUTUBE_CAPTURE_FRAME_FAILED", "message": "yt-dlp could not download a required frame section."}
        task.failed_section = {"sectionIndex": 5, "startSeconds": 418, "endSeconds": 433, "frameCount": 1, "attemptCount": 3}
        snapshot = manager.snapshot(task)
        self.assertEqual(snapshot["completedFrames"], 4)
        self.assertEqual(snapshot["failedSection"], task.failed_section)

    async def test_workspace_image_metadata_never_returns_encoded_bytes(self) -> None:
        image = agent.WORKSPACE_PATH / "captures" / "frame.png"
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(b"image-bytes")
        _item, result = agent.workspace_image_metadata({"path": "captures/frame.png"})
        self.assertEqual(result, {"path": "captures/frame.png", "mediaKind": "image", "mimeType": "image/png", "sizeBytes": 11})
        self.assertNotIn(str(self.root), json.dumps(result))
        self.assertNotIn("base64", json.dumps(result).lower())

    async def test_inspect_workspace_image_returns_verified_metadata_without_host_path(self) -> None:
        image = agent.WORKSPACE_PATH / "crops" / "selection.png"
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(b"image-bytes")
        streams = [{"codec_type": "video", "codec_name": "png", "width": 200, "height": 120}]
        with patch.object(agent, "find_component", return_value=agent.ComponentDiscovery("local", "/private/ffprobe")), patch.object(agent, "ffprobe_streams_for_file", new=AsyncMock(return_value=streams)):
            result = await agent.inspect_workspace_image({"path": "crops/selection.png"})
        self.assertEqual(result, {"workspacePath": "crops/selection.png", "format": "png", "mimeType": "image/png", "width": 200, "height": 120, "imageSizeBytes": 11})
        self.assertNotIn(str(self.root), json.dumps(result))

    async def test_inspect_workspace_image_rejects_mismatched_content(self) -> None:
        image = agent.WORKSPACE_PATH / "crops" / "selection.png"
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(b"not-png")
        streams = [{"codec_type": "video", "codec_name": "mjpeg", "width": 200, "height": 120}]
        with patch.object(agent, "find_component", return_value=agent.ComponentDiscovery("local", "/private/ffprobe")), patch.object(agent, "ffprobe_streams_for_file", new=AsyncMock(return_value=streams)):
            with self.assertRaises(agent.AgentApiError) as raised:
                await agent.inspect_workspace_image({"path": "crops/selection.png"})
        self.assertEqual(raised.exception.code, "INVALID_IMAGE")

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
        self.old_file = agent.PUBLIC_SHARE_FILE
        self.old_file_types = agent.PUBLIC_SHARE_FILE_TYPES
        self.old_tunnel_url = agent.PUBLIC_TUNNEL_URL
        agent.PUBLIC_SHARE_FOLDER = self.folder
        agent.PUBLIC_SHARE_FILE = None
        agent.PUBLIC_SHARE_FILE_TYPES = ("images",)
        agent.PUBLIC_TUNNEL_URL = "https://example.trycloudflare.com"

    def tearDown(self) -> None:
        agent.WORKSPACE_PATH = self.old_workspace
        agent.PUBLIC_SHARE_FOLDER = self.old_folder
        agent.PUBLIC_SHARE_FILE = self.old_file
        agent.PUBLIC_SHARE_FILE_TYPES = self.old_file_types
        agent.PUBLIC_TUNNEL_URL = self.old_tunnel_url
        self.temp.cleanup()

    def test_public_share_repeats_its_selected_folder_in_the_url_path(self) -> None:
        image, mime_type = agent.public_share_file("/captures/Bird.webp")
        self.assertEqual(image.read_bytes(), b"webp-bytes")
        self.assertEqual(mime_type, "image/webp")
        self.assertEqual(agent.public_share_base_url(), "https://example.trycloudflare.com/captures/")

    def test_public_share_folder_has_a_browseable_directory_listing(self) -> None:
        listing = agent.public_share_directory_listing("/captures/")
        self.assertIsNotNone(listing)
        self.assertIn(b"Bird.webp", listing or b"")
        self.assertNotIn(b"notes.txt", listing or b"")

    def test_public_share_single_file_exposes_only_that_file(self) -> None:
        shared_file = agent.WorkspacePathResolver().resolve_existing("captures/Bird.webp", field_name="file", expected_type="file")
        agent.PUBLIC_SHARE_FOLDER = None
        agent.PUBLIC_SHARE_FILE = shared_file
        image, mime_type = agent.public_share_file("/captures/Bird.webp")
        self.assertEqual(image.read_bytes(), b"webp-bytes")
        self.assertEqual(mime_type, "image/webp")
        self.assertIsNone(agent.public_share_directory_listing("/captures/"))
        with self.assertRaises(agent.AgentApiError):
            agent.public_share_file("/captures/notes.txt")

    def test_public_share_rejects_traversal_and_filtered_file_types(self) -> None:
        for path in ("/%2e%2e/Bird.webp", "/notes.txt", "/Bird.webp", "/captures/notes.txt", "/"):
            with self.subTest(path=path), self.assertRaises(agent.AgentApiError) as raised:
                agent.public_share_file(path)
            self.assertEqual(raised.exception.code, "PUBLIC_SHARE_NOT_FOUND")

    def test_workspace_share_options_accepts_only_the_documented_selectors(self) -> None:
        options = agent.workspace_share_options({"folder": "captures", "fileTypes": ["images", "documents"]})
        self.assertEqual(options.folder.logical_path if options.folder else None, "captures")
        self.assertEqual(options.file_types, ("images", "documents"))
        single_file = agent.workspace_share_options({"file": "captures/Bird.webp", "verifyExternal": True})
        self.assertEqual(single_file.file.logical_path if single_file.file else None, "captures/Bird.webp")
        self.assertTrue(single_file.verify_external)
        with self.assertRaises(agent.AgentApiError):
            agent.workspace_share_options({"folder": "captures", "fileTypes": ["all", "images"]})
        with self.assertRaises(agent.AgentApiError):
            agent.workspace_share_options({"folder": "captures", "fileTypes": ["images"], "verifyExternal": True})


async def _bytes_result(stdout: bytes, stderr: bytes):
    return stdout, stderr

if __name__ == "__main__":
    unittest.main()
