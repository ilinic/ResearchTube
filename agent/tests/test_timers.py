"""Timer time semantics, interruption detection, retention and HTTP contract."""
import asyncio
import json
import math
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from datetime import datetime, timezone

from agent import researchtube_agent as agent
from agent.timers import TimerService, ClockReading, InternetSample, fetch_internet_time, load_zone, parse_until
from agent.task_history import TaskHistory


class FakeClock:
    def __init__(self):
        self.utc = datetime(2026, 10, 6, tzinfo=timezone.utc).timestamp()
        self.mono = self.total = self.awake = 100
        self.zone = "NZDT:+13"

    def __call__(self):
        return ClockReading(self.utc, self.mono, self.total, self.awake, self.zone)

    def advance(self, seconds, shift=0, asleep=0):
        self.utc += seconds + shift
        self.mono += seconds
        self.total += seconds
        self.awake += seconds - asleep


class TimerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.clock = FakeClock()
        self.service = TimerService(agent, clock=self.clock, internet=lambda: InternetSample(self.clock.utc + 120, self.clock.mono, 20, 11))

    async def asyncTearDown(self):
        await self.service.shutdown()

    async def test_duration_units_zone_progress_and_frozen_terminal_snapshot(self):
        start = await self.service.create({"duration": 0.1, "unit": "minutes", "localTimeZone": "Pacific/Auckland"})
        self.assertRegex(start["taskId"], r"^tsk_[A-Za-z0-9_-]{10}$")
        self.assertEqual(start["durationSeconds"], 6)
        self.assertTrue(start["currentLocal"].endswith("+13:00"))
        self.clock.advance(3)
        middle = await self.service.status(start["taskId"])
        self.assertEqual(middle["progressPercent"], 50)
        self.assertEqual(middle["remainingSeconds"], 3)
        self.clock.advance(3)
        final = await self.service.status(start["taskId"])
        self.assertEqual((final["status"], final["progressPercent"], final["remainingSeconds"]), ("completed", 100, 0))
        self.clock.advance(100)
        self.assertEqual(final, await self.service.status(start["taskId"]))
        self.assertFalse((await self.service.cancel(start["taskId"]))["cancelled"])

    async def test_relative_timer_ignores_clock_jump_but_reports_warning(self):
        start = await self.service.create({"duration": 10})
        self.clock.advance(2, shift=3600)
        status = await self.service.status(start["taskId"])
        self.assertEqual((status["elapsedSeconds"], status["remainingSeconds"]), (2, 8))
        self.assertEqual(status["warnings"][0]["code"], "SYSTEM_CLOCK_CHANGED")
        self.assertEqual(status["warnings"][0]["shiftSeconds"], 3600)
        self.clock.advance(2)
        self.assertEqual((await self.service.status(start["taskId"]))["warningCount"], 1)

    async def test_until_follows_calendar_and_progress_never_decreases(self):
        target = datetime.fromtimestamp(self.clock.utc + 100, timezone.utc).isoformat()
        start = await self.service.create({"until": target})
        self.clock.advance(2, shift=48)
        first = await self.service.status(start["taskId"])
        self.assertEqual(first["progressPercent"], 50)
        self.clock.advance(2, shift=-40)
        second = await self.service.status(start["taskId"])
        self.assertEqual(second["progressPercent"], 50)
        self.assertEqual(second["remainingSeconds"], 88)
        self.clock.advance(1, shift=100)
        self.assertEqual((await self.service.status(start["taskId"]))["status"], "completed")

    async def test_suspend_fails_before_would_be_completion(self):
        start = await self.service.create({"duration": 2})
        self.clock.advance(30, asleep=29)
        status = await self.service.status(start["taskId"])
        self.assertEqual(status["status"], "failed")
        self.assertEqual(status["error"]["code"], "TIMER_SYSTEM_SUSPENDED")
        self.assertEqual(status["warnings"][0]["code"], "SYSTEM_SUSPEND_DETECTED")
        self.assertFalse(any(w["code"] == "SYSTEM_CLOCK_CHANGED" for w in status["warnings"]))

    async def test_execution_gap_warns_without_claiming_sleep(self):
        start = await self.service.create({"duration": 100})
        self.clock.advance(20)
        result = await self.service.status(start["taskId"])
        self.assertEqual(result["status"], "working")
        self.assertEqual(result["warnings"][0]["code"], "EXECUTION_GAP_DETECTED")

    async def test_local_zone_change_is_separate_from_utc_jump(self):
        start = await self.service.create({"duration": 10, "timeZone": "Pacific/Auckland"})
        self.clock.advance(1)
        self.clock.zone = "UTC:+0"
        result = await self.service.status(start["taskId"])
        self.assertEqual(result["warnings"][0]["code"], "SYSTEM_LOCAL_TIME_CHANGED")
        self.assertEqual(result["timeZone"], "Pacific/Auckland")

    async def test_cancel_is_idempotent_and_records_are_memory_only(self):
        start = await self.service.create({"duration": 100})
        result = await self.service.cancel(start["taskId"])
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["task"]["status"], "cancelled")
        self.assertFalse((await self.service.cancel(start["taskId"]))["cancelled"])
        restarted = TimerService(agent, self.clock)
        with self.assertRaises(agent.AgentApiError) as error:
            await restarted.status(start["taskId"])
        self.assertEqual(error.exception.code, "TIMER_NOT_FOUND")
        self.assertIn("restarted", str(error.exception))

    async def test_internet_initialization_real_offset_and_no_fallback(self):
        start = await self.service.create({"duration": 10, "clockSource": "internet"})
        self.assertEqual(start["phase"], "preparing")
        self.assertIsNone(start["currentUtc"])
        for _ in range(50):
            await asyncio.sleep(.002)
            if self.service.get(start["taskId"]).phase == "waiting":
                break
        result = await self.service.status(start["taskId"])
        self.assertEqual(result["phase"], "waiting")
        self.assertEqual(result["clockSync"]["systemClockOffsetSeconds"], 120)
        self.clock.advance(2, shift=3600)
        result = await self.service.status(start["taskId"])
        self.assertEqual(result["remainingSeconds"], 8)
        self.assertEqual(result["clockSource"], "internet")
        self.assertEqual(result["clockSync"]["provider"], "timeapi.io")

    async def test_internet_failure_and_over_age_sample(self):
        def unavailable():
            raise OSError("private provider details must not escape")
        service = TimerService(agent, self.clock, unavailable)
        start = await service.create({"duration": 10, "clockSource": "internet"})
        await service.get(start["taskId"]).runner
        result = await service.status(start["taskId"])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "TIMER_INTERNET_UNAVAILABLE")
        self.assertIsNone(result["clockSync"])
        self.assertNotIn("private", json.dumps(result))
        await service.shutdown()
        self.service.internet_sample = InternetSample(self.clock.utc, self.clock.mono, 10, 6)
        start = await self.service.create({"duration": 1000, "clockSource": "internet"})
        await asyncio.sleep(.01)
        self.clock.advance(301)
        result = await self.service.status(start["taskId"])
        self.assertEqual(result["error"]["code"], "TIMER_INTERNET_UNAVAILABLE")

    async def test_invalid_inputs_and_past_targets(self):
        for value in [{}, {"duration": 1, "until": "2026-10-06T00:00:00Z"}, {"duration": True}, {"duration": math.nan}, {"duration": -1}, {"duration": math.inf}, {"duration": 10**1000}, {"duration": 1, "unit": "days"}, {"duration": 1, "clockSource": {}}, {"until": "18:00"}, {"until": "2026-10-06T01:00:00", "unit": "seconds"}, {"duration": 1, "timeZone": "../bad"}, {"duration": 1, "unknown": True}, {"until": "2026-10-05T00:00:00Z"}]:
            with self.subTest(value=str(value)[:90]):
                with self.assertRaises(agent.AgentApiError) as error:
                    await self.service.create(value)
                self.assertEqual(error.exception.code, "TIMER_INVALID")

    async def test_local_absolute_target_and_utc_display(self):
        start = await self.service.create({"until": "2026-10-06T14:00:00", "timeZone": "Pacific/Auckland"})
        self.assertEqual(start["targetUtc"], "2026-10-06T01:00:00.000Z")
        self.assertEqual(start["durationSeconds"], 3600)
        other = await self.service.create({"until": "2026-10-06T01:00:00Z", "timeZone": "Pacific/Auckland"})
        self.assertEqual(other["targetLocal"], "2026-10-06T14:00:00.000+13:00")

    async def test_real_short_timer_and_status_rate_guard(self):
        service = TimerService(agent)
        started = time.monotonic()
        task = await service.create({"duration": .12})
        await service.status(task["taskId"])
        final = await service.status(task["taskId"])
        self.assertGreaterEqual(time.monotonic() - started, .12)
        self.assertEqual(final["status"], "completed")
        await service.shutdown()


class CalendarTests(unittest.TestCase):
    def test_dst_gap_fold_and_explicit_offset(self):
        zone = load_zone("Europe/Berlin")
        for text in ["2026-03-29T02:30:00", "2026-10-25T02:30:00"]:
            with self.assertRaises(ValueError):
                parse_until(text, zone, True)
        first = parse_until("2026-10-25T02:30:00+02:00", zone, True)
        second = parse_until("2026-10-25T02:30:00+01:00", zone, True)
        self.assertEqual(second - first, 3600)
        with self.assertRaises(ValueError):
            parse_until("2026-10-25T02:30:00+03:00", zone, True)

    def test_http_time_response_parsing_and_bounds(self):
        class Response:
            status = 200
            headers = {"Age": "0"}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, maximum):
                return json.dumps({"timeZone": "UTC", "dateTime": "2026-10-06T00:00:00.1234567"}).encode()
        with patch("agent.timers.urlopen", return_value=Response()) as request, patch("agent.timers.time.monotonic", side_effect=[100, 100.02]):
            sample = fetch_internet_time()
        self.assertAlmostEqual(sample.round_trip_ms, 20)
        self.assertEqual(sample.monotonic, 100.02)
        self.assertTrue(request.call_args.args[0].full_url.startswith("https://timeapi.io/"))
        self.assertEqual(request.call_args.kwargs["timeout"], 5)


class HistoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_evicts_oldest_terminal_only_and_limit_changes(self):
        cap = [2]
        history = TaskHistory(lambda: cap[0])
        for key in ["a", "b", "c"]:
            history[key] = SimpleNamespace(status="completed", runner=None, result={"path": "preserved.mp4"})
        history["active"] = SimpleNamespace(status="working", runner=None)
        self.assertEqual(set(history), {"b", "c", "active"})
        cap[0] = 1
        history.prune()
        self.assertEqual(set(history), {"c", "active"})
        self.assertEqual(history["c"].result["path"], "preserved.mp4")

    async def test_never_removes_runner_before_final_publication(self):
        history = TaskHistory(lambda: 1)
        gate = asyncio.Event()
        async def run(): await gate.wait()
        old = SimpleNamespace(status="completed", runner=asyncio.create_task(run()))
        history["old"] = old
        history["new"] = SimpleNamespace(status="completed", runner=None)
        history.prune()
        self.assertIn("old", history)
        await asyncio.sleep(0)
        gate.set()
        await old.runner
        await asyncio.sleep(0)
        self.assertEqual(set(history), {"old"}, "old runner actually completed last")

    async def test_completion_callback_bounds_quiet_manager(self):
        history = TaskHistory(lambda: 2)
        async def run(task):
            await asyncio.sleep(0)
            task.status = "completed"
        for i in range(10):
            task = SimpleNamespace(status="working", runner=None)
            history[str(i)] = task
            task.runner = asyncio.create_task(run(task))
        await asyncio.gather(*(t.runner for t in list(history.values())))
        await asyncio.sleep(0)
        self.assertEqual(len(history), 2)

    async def test_all_agent_managers_have_retention(self):
        for manager in [agent.TASKS, agent.SPEECH_TASKS, agent.CAPTURE_FRAME_TASKS, agent.MEDIA_CLIP_TASKS, agent.CAMERA_RECORD_TASKS, agent.VISUAL_MAP_TASKS, agent.STORYBOARD_TASKS, agent.TIMER_TASKS]:
            self.assertIsInstance(manager.tasks, TaskHistory)

    async def test_config_comments_and_limit_validation(self):
        config = json.loads(agent.CONFIG_PATH.read_text())
        self.assertEqual(config["limits"]["completedTaskHistoryLimit"]["value"], 2000)
        entries = [value for key, value in config.items() if key != "limits"] + list(config["limits"].values())
        for entry in entries:
            self.assertEqual(set(entry), {"value", "comment"})
            self.assertTrue(entry["comment"].strip())
        self.assertTrue(agent.configured_new_tools_default())


class TimerHttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_live_loopback_start_status_cancel_and_not_found(self):
        service = TimerService(agent)
        with patch.object(agent, "TIMER_TASKS", service):
            server = await asyncio.start_server(agent.handle_client, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            async def request(method, path, payload=None):
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                body = json.dumps(payload).encode() if payload is not None else b""
                writer.write(f"{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
                await writer.drain()
                response = await reader.read()
                writer.close(); await writer.wait_closed()
                header, raw = response.split(b"\r\n\r\n", 1)
                return header, json.loads(raw)
            try:
                _, start = await request("POST", "/timer/start", {"duration": .05, "localTimeZone": "Pacific/Auckland"})
                await asyncio.sleep(.07)
                _, final = await request("GET", "/tasks/timer/" + start["taskId"])
                self.assertEqual(final["status"], "completed")
                _, second = await request("POST", "/timer/start", {"duration": 20})
                _, cancelled = await request("POST", "/tasks/timer/" + second["taskId"] + "/cancel", {})
                self.assertTrue(cancelled["cancelled"])
                header, missing = await request("GET", "/tasks/timer/tsk_abcdefghij")
                self.assertIn(b"404", header)
                self.assertEqual(missing["error"]["code"], "TIMER_NOT_FOUND")
            finally:
                server.close(); await server.wait_closed()
                await service.shutdown()
