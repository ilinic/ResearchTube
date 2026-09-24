#!/usr/bin/env python3
"""Unit checks for camera metadata and task contracts without real hardware."""

from __future__ import annotations

import re
import unittest
from unittest.mock import patch

from agent import researchtube_agent as agent


class CameraContractTests(unittest.TestCase):
    def test_mode_parser_selects_largest_safe_mode(self) -> None:
        modes = agent.camera_modes_from_lines([
            "pixel_format=mjpeg min s=640x480 fps=5 max s=1280x720 fps=30",
            "[0] 1920x1080@30.000000fps",
        ])
        self.assertEqual((modes[0].width, modes[0].height), (1920, 1080))
        self.assertTrue(any(mode.width == 1280 and mode.height == 720 for mode in modes))

    def test_selection_prefers_60fps_before_resolution_then_30fps(self) -> None:
        self.assertEqual(
            agent.select_camera_mode((
                agent.CameraMode(2304, 1536, 2), agent.CameraMode(1920, 1080, 30), agent.CameraMode(1280, 720, 60.0002),
            )),
            agent.CameraMode(1280, 720, 60.0002),
        )
        self.assertEqual(
            agent.select_camera_mode((agent.CameraMode(2304, 1536, 2), agent.CameraMode(1920, 1080, 30))),
            agent.CameraMode(1920, 1080, 30),
        )

    def test_public_camera_document_advertises_recording_tradeoffs_without_native_identity(self) -> None:
        device = agent.CameraDevice("cam_test", "Example Camera", "v4l2", "/dev/video99", None, (agent.CameraMode(2304, 1536, 2), agent.CameraMode(1920, 1080, 30), agent.CameraMode(1280, 720, 60.0002)), agent.CameraMode(1280, 720, 60.0002))
        document = agent.camera_public_device(device)
        self.assertEqual(document["cameraId"], "cam_test")
        self.assertNotIn("/dev/video99", str(document))
        self.assertFalse(document["audioAvailable"])
        self.assertEqual(document["videoModes"], {
            "30": {"width": 1920, "height": 1080, "fps": 30},
            "60": {"width": 1280, "height": 720, "fps": 60.0002},
        })

    def test_target_fps_mode_requires_a_matching_rate(self) -> None:
        modes = (agent.CameraMode(1920, 1080, 30), agent.CameraMode(1280, 720, 60.0002))
        self.assertEqual(agent.camera_mode_for_target_fps(modes, 30), agent.CameraMode(1920, 1080, 30))
        self.assertEqual(agent.camera_mode_for_target_fps(modes, 60), agent.CameraMode(1280, 720, 60.0002))
        self.assertIsNone(agent.camera_mode_for_target_fps(modes, 24))

    def test_camera_task_uses_shared_task_identifier_shape(self) -> None:
        manager = agent.CameraRecordTaskManager()
        task_id = manager.new_task_id()
        self.assertRegex(task_id, r"^tsk_[A-Za-z0-9_-]{10}$")

    def test_dshow_ffmpeg_9_entry_format_is_recognized(self) -> None:
        async def lines(_command: list[str], *, operation: str) -> list[str]:
            self.assertEqual(operation, "list-dshow-devices")
            return [
                '[in#0] "C922 Pro Stream Webcam" (video)',
                '[in#0]   Alternative name "@device_pnp_webcam"',
                '[in#0] "Microphone (C922 Pro Stream Webcam)" (audio)',
                '[in#0]   Alternative name "@device_cm_microphone"',
            ]

        with patch.object(agent, "camera_ffmpeg_lines", lines), patch.object(agent.platform, "system", return_value="Windows"):
            candidates = __import__("asyncio").run(agent.enumerate_camera_candidates("ffmpeg.exe"))
        self.assertEqual(candidates, [("dshow", "C922 Pro Stream Webcam", "@device_pnp_webcam", "@device_cm_microphone")])
