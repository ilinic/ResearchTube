"""In-memory asynchronous timers with independent duration and calendar clocks."""
from __future__ import annotations

import asyncio
import ctypes
import io
import json
import math
import os
import re
import secrets
import time
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

INTERNET_PROVIDER = "timeapi.io"
INTERNET_URL = "https://timeapi.io/api/Time/current/zone?timeZone=UTC"
SYNC_SECONDS = 60
MAX_SAMPLE_AGE_SECONDS = 300
CLOCK_SHIFT_TOLERANCE_SECONDS = 1
SUSPEND_TOLERANCE_SECONDS = 0.5
EXECUTION_GAP_SECONDS = 5
MAX_WARNINGS = 20
UNTIL_PATTERN = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?"


def utc_text(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def load_zone(name):
    # Ship the small IANA database so Windows needs no pip installation.
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_+.-]+(?:/[A-Za-z0-9_+.-]+)*", name) or any(p in {".", ".."} for p in name.split("/")):
        raise ValueError("timeZone must name an IANA time zone, for example Pacific/Auckland or UTC.")
    bundle = Path(__file__).parent / "tools" / "timezones" / "zoneinfo.zip"
    try:
        with zipfile.ZipFile(bundle) as archive:
            return ZoneInfo.from_file(io.BytesIO(archive.read(name)), key=name)
    except (OSError, KeyError, zipfile.BadZipFile, ValueError):
        try:
            return ZoneInfo(name)
        except (ValueError, ZoneInfoNotFoundError) as error:
            raise ValueError("timeZone is not an available IANA time zone.") from error


def parse_until(value, zone, explicit_zone):
    if not isinstance(value, str) or not re.fullmatch(UNTIL_PATTERN, value):
        raise ValueError("until must contain a complete ISO date and time, including seconds, with optional Z or UTC offset.")
    local = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if local.tzinfo is not None:
        if explicit_zone and not value.endswith("Z") and local.astimezone(zone).utcoffset() != local.utcoffset():
            raise ValueError("The until UTC offset conflicts with timeZone at the requested instant.")
        return local.timestamp()
    choices = {local.replace(tzinfo=zone, fold=fold).timestamp() for fold in (0, 1)
               if local.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None) == local}
    if not choices:
        raise ValueError("until names a nonexistent local time during a time-zone transition.")
    if len(choices) != 1:
        raise ValueError("until is ambiguous during a time-zone transition; include an explicit UTC offset.")
    return choices.pop()


@dataclass(frozen=True)
class ClockReading:
    utc: float
    monotonic: float
    including_sleep: float | None = None
    awake: float | None = None
    local_zone: str = ""


def read_clock():
    utc, mono = time.time(), time.monotonic()
    including_sleep = awake = None
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        ticks = kernel.GetTickCount64
        ticks.restype = ctypes.c_ulonglong
        unbiased = ctypes.c_ulonglong()
        query = kernel.QueryUnbiasedInterruptTime
        query.argtypes = [ctypes.POINTER(ctypes.c_ulonglong)]
        query.restype = ctypes.c_int
        if query(ctypes.byref(unbiased)):
            including_sleep, awake = ticks() / 1000, unbiased.value / 10_000_000
    elif hasattr(time, "CLOCK_BOOTTIME"):
        including_sleep = time.clock_gettime(time.CLOCK_BOOTTIME)
        awake = mono
    local = datetime.now().astimezone()
    return ClockReading(utc, mono, including_sleep, awake, f"{local.tzname()}:{local.utcoffset()}")


@dataclass(frozen=True)
class InternetSample:
    utc: float
    monotonic: float
    round_trip_ms: float
    uncertainty_ms: float


def fetch_internet_time():
    started = time.monotonic()
    request = Request(INTERNET_URL + "&_=" + secrets.token_urlsafe(7), headers={
        "Accept": "application/json", "Cache-Control": "no-cache", "User-Agent": "ResearchTube-Timer/1"})
    with urlopen(request, timeout=5) as response:
        if response.status != 200 or response.headers.get("Age", "0") not in {"0", ""}:
            raise ValueError("The time provider returned an unsuccessful or cached response.")
        raw = response.read(16_385)
    ended = time.monotonic()
    if len(raw) > 16_384:
        raise ValueError("The time provider returned an oversized response.")
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get("timeZone") != "UTC" or not isinstance(data.get("dateTime"), str):
        raise ValueError("The time provider returned invalid UTC metadata.")
    # TimeAPI returns up to seven fractional digits and a zone-less UTC field.
    text = re.sub(r"(\.\d{6})\d+(?=Z|[+-]|$)", r"\1", data["dateTime"])
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    if parsed.utcoffset().total_seconds() != 0:
        raise ValueError("The time provider returned a non-UTC timestamp.")
    rtt = ended - started
    # An estimate, not an atomic-clock precision guarantee.
    return InternetSample(parsed.timestamp() + rtt / 2, ended, rtt * 1000, rtt * 500 + 1)


@dataclass
class TimerTask:
    task_id: str
    mode: str
    clock_source: str
    zone: ZoneInfo
    duration: float | None
    target: float | None
    created_utc: float
    previous_clock: ClockReading
    status: str = "working"
    phase: str = "preparing"
    started_utc: float | None = None
    started_monotonic: float | None = None
    finished_utc: float | None = None
    progress: float = 0
    warnings: list = field(default_factory=list)
    warning_count: int = 0
    error: dict | None = None
    final_snapshot: dict | None = None
    runner: asyncio.Task | None = None
    next_poll_monotonic: float = 0


class TimerService:
    def __init__(self, host, clock=read_clock, internet=fetch_internet_time):
        self.host, self.clock, self.internet = host, clock, internet
        self.tasks = host.TaskHistory(host.configured_task_history_limit)
        self.internet_sample = None
        self.internet_lock = asyncio.Lock()
        self.last_sync_attempt = -math.inf

    def invalid(self, message):
        raise self.host.AgentApiError("TIMER_INVALID", message)

    def options(self, payload):
        if not isinstance(payload, dict) or set(payload) - {"duration", "unit", "until", "timeZone", "clockSource", "localTimeZone"}:
            self.invalid("Timer input contains unsupported fields.")
        if ("duration" in payload) == ("until" in payload):
            self.invalid("Specify exactly one of duration or until.")
        source = payload.get("clockSource", "system")
        if not isinstance(source, str) or source not in {"system", "internet"}:
            self.invalid("clockSource must be system or internet.")
        try:
            zone = load_zone(payload.get("timeZone", payload.get("localTimeZone", "UTC")))
            if "until" in payload:
                if "unit" in payload:
                    self.invalid("unit is only valid with duration.")
                return "until", source, zone, None, parse_until(payload["until"], zone, "timeZone" in payload)
        except (ValueError, OverflowError, OSError) as error:
            self.invalid(str(error))
        unit = payload.get("unit", "seconds")
        factors = {"seconds": 1, "minutes": 60, "hours": 3600}
        value = payload["duration"]
        if not isinstance(unit, str) or unit not in factors or isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 or value > 253_402_300_000:
            self.invalid("duration must be a finite nonnegative number; unit must be seconds, minutes or hours.")
        duration = value * factors[unit]
        try:
            if not math.isfinite(duration):
                raise ValueError()
            utc_text(self.clock().utc + duration)
        except (ValueError, OverflowError, OSError):
            self.invalid("duration exceeds the supported calendar range.")
        return "duration", source, zone, duration, None

    def get(self, timer_task_id):
        if not isinstance(timer_task_id, str) or not re.fullmatch(r"tsk_[A-Za-z0-9_-]{10}", timer_task_id):
            self.invalid("taskId must be an unchanged timer task ID returned by timer_start.")
        self.tasks.prune()
        if timer_task_id not in self.tasks:
            raise self.host.AgentApiError("TIMER_NOT_FOUND", "This timer is unavailable. Its ID may be invalid, its history may have been cleared, or the Agent/computer may have restarted. Timers exist only in Agent memory.")
        return self.tasks[timer_task_id]

    def warning(self, task, code, message, reading, shift=None, gap=None):
        task.warning_count += 1
        task.warnings.append({"code": code, "message": message, "observedAtUtc": utc_text(reading.utc),
                              "shiftSeconds": shift, "gapSeconds": gap})
        del task.warnings[:-MAX_WARNINGS]

    def observe(self, task, reading):
        previous = task.previous_clock
        mono_delta = reading.monotonic - previous.monotonic
        total_delta = mono_delta
        if reading.including_sleep is not None and previous.including_sleep is not None:
            total_delta = reading.including_sleep - previous.including_sleep
        shift = reading.utc - previous.utc - total_delta
        if abs(shift) >= CLOCK_SHIFT_TOLERANCE_SECONDS:
            self.warning(task, "SYSTEM_CLOCK_CHANGED", "System calendar time changed; relative duration is unaffected.", reading, shift=round(shift, 3))
        if reading.local_zone != previous.local_zone:
            self.warning(task, "SYSTEM_LOCAL_TIME_CHANGED", "The computer's local time-zone name or UTC offset changed; the timer's selected time zone remains fixed.", reading)
        suspended = False
        if reading.awake is not None and previous.awake is not None and reading.including_sleep is not None and previous.including_sleep is not None:
            asleep = total_delta - (reading.awake - previous.awake)
            if asleep >= SUSPEND_TOLERANCE_SECONDS:
                suspended = True
                self.warning(task, "SYSTEM_SUSPEND_DETECTED", "The system was suspended during this timer.", reading, gap=round(asleep, 3))
        if not suspended and mono_delta > EXECUTION_GAP_SECONDS:
            self.warning(task, "EXECUTION_GAP_DETECTED", "Timer execution had a long gap; this does not prove that the computer slept.", reading, gap=round(mono_delta, 3))
        task.previous_clock = reading
        return suspended

    def selected_utc(self, task, reading):
        if task.clock_source == "system":
            return reading.utc
        sample = self.internet_sample
        return None if sample is None else sample.utc + reading.monotonic - sample.monotonic

    async def sync(self):
        async with self.internet_lock:
            reading = self.clock()
            if self.internet_sample is not None and reading.monotonic - self.internet_sample.monotonic < SYNC_SECONDS:
                return True
            if reading.monotonic - self.last_sync_attempt < 10:
                return False
            self.last_sync_attempt = reading.monotonic
            try:
                sample = await asyncio.wait_for(asyncio.to_thread(self.internet), timeout=6)
                if not isinstance(sample, InternetSample) or not all(math.isfinite(v) for v in (sample.utc, sample.monotonic, sample.round_trip_ms, sample.uncertainty_ms)) or sample.round_trip_ms < 0 or sample.uncertainty_ms < 0:
                    raise ValueError("Invalid internet sample.")
                self.internet_sample = sample
                return True
            except (Exception, asyncio.CancelledError) as error:
                if isinstance(error, asyncio.CancelledError):
                    raise
                return False

    def prepare(self, task, reading):
        now = self.selected_utc(task, reading)
        if task.mode == "until":
            if task.target <= now:
                self.invalid("until must be later than the selected clock's current time.")
            task.duration = task.target - now
        else:
            task.target = now + task.duration
        # Validate also the local rendering at the target (near datetime bounds).
        datetime.fromtimestamp(task.target, timezone.utc).astimezone(task.zone)
        task.started_utc, task.started_monotonic = now, reading.monotonic
        task.phase = "waiting"

    def metrics(self, task, reading):
        now = self.selected_utc(task, reading)
        elapsed = None if task.started_monotonic is None else max(0, reading.monotonic - task.started_monotonic)
        remaining = None
        if elapsed is not None:
            if task.mode == "duration":
                # Calendar target is an estimate; elapsed duration stays monotonic.
                task.target = now + task.duration - elapsed
            remaining = max(0, task.duration - elapsed) if task.mode == "duration" else max(0, task.target - now)
            fraction = 100 if task.duration == 0 else max(0, min(100, (task.duration - remaining) / task.duration * 100))
            task.progress = max(task.progress, fraction)
            if task.status == "working":
                task.progress = min(task.progress, 99.999)
        return now, elapsed, remaining

    def snapshot(self, task, reading=None):
        if task.final_snapshot is not None:
            return json.loads(json.dumps(task.final_snapshot))
        reading = reading or self.clock()
        now, elapsed, remaining = self.metrics(task, reading)
        def local(epoch):
            return None if epoch is None else datetime.fromtimestamp(epoch, timezone.utc).astimezone(task.zone).isoformat(timespec="milliseconds")
        def offset(epoch):
            return None if epoch is None else int(datetime.fromtimestamp(epoch, timezone.utc).astimezone(task.zone).utcoffset().total_seconds())
        sample = self.internet_sample if task.clock_source == "internet" else None
        age = None if sample is None else max(0, reading.monotonic - sample.monotonic)
        poll = 250 if remaining is None or remaining <= 10 else 1000 if remaining <= 60 else 5000 if remaining <= 3600 else 30000
        result = {
            "taskId": task.task_id, "status": task.status, "phase": task.phase, "mode": task.mode,
            "clockSource": task.clock_source, "timeZone": task.zone.key,
            "createdAtUtc": utc_text(task.created_utc), "startedAtUtc": None if task.started_utc is None else utc_text(task.started_utc),
            "currentUtc": None if now is None else utc_text(now), "targetUtc": None if task.target is None else utc_text(task.target),
            "startedAtLocal": local(task.started_utc), "currentLocal": local(now), "targetLocal": local(task.target),
            "currentUtcOffsetSeconds": offset(now), "targetUtcOffsetSeconds": offset(task.target),
            "durationSeconds": task.duration, "elapsedSeconds": None if elapsed is None else round(elapsed, 3),
            "remainingSeconds": None if remaining is None else round(remaining, 3), "progressPercent": round(task.progress, 3),
            "pollIntervalMs": poll, "completedAtUtc": None if task.finished_utc is None else utc_text(task.finished_utc),
            "latenessSeconds": None if task.status != "completed" else round(max(0, elapsed - task.duration) if task.mode == "duration" else max(0, now - task.target), 3),
            "sleepDetection": "systemCounters" if reading.including_sleep is not None and reading.awake is not None else "executionGapOnly",
            "warnings": list(task.warnings), "warningCount": task.warning_count, "error": task.error,
            "clockSync": {"provider": INTERNET_PROVIDER, "sampledAtUtc": utc_text(sample.utc), "sampleAgeSeconds": round(age, 3),
                "roundTripMs": round(sample.round_trip_ms, 3), "estimatedUncertaintyMs": round(sample.uncertainty_ms, 3),
                "systemClockOffsetSeconds": round(now - reading.utc, 3), "stale": age >= SYNC_SECONDS} if sample else None}
        return result

    def finish(self, task, status, reading, error=None):
        self.metrics(task, reading)
        task.status = task.phase = status
        task.finished_utc = self.selected_utc(task, reading)
        task.error = error
        if status == "completed":
            task.progress = 100
        task.final_snapshot = self.snapshot(task, reading)
        self.host.log(f"timer {task.task_id} {status} {task.progress:.1f}%")

    def tick(self, task, reading):
        if task.status != "working":
            return
        # Check interruption before completion, including the first post-wake tick.
        if self.observe(task, reading):
            self.finish(task, "failed", reading, {"code": "TIMER_SYSTEM_SUSPENDED", "message": "The timer was interrupted by system suspend and was not resumed."})
            return
        if task.clock_source == "internet" and task.phase == "waiting" and reading.monotonic - self.internet_sample.monotonic >= MAX_SAMPLE_AGE_SECONDS:
            self.finish(task, "failed", reading, {"code": "TIMER_INTERNET_UNAVAILABLE", "message": "The internet-clock sample is too old; no system-clock fallback was used."})
            return
        if task.phase == "waiting" and self.metrics(task, reading)[2] <= 0:
            self.finish(task, "completed", reading)

    async def create(self, payload):
        mode, source, zone, duration, target = self.options(payload)
        reading = self.clock()
        timer_task_id = "tsk_" + secrets.token_urlsafe(7)
        while timer_task_id in self.tasks:
            timer_task_id = "tsk_" + secrets.token_urlsafe(7)
        task = TimerTask(timer_task_id, mode, source, zone, duration, target, reading.utc, reading)
        if source == "system":
            try:
                self.prepare(task, reading)
            except (ValueError, OverflowError, OSError):
                self.invalid("The requested target is outside the supported local calendar range.")
        self.tasks[timer_task_id] = task
        task.runner = asyncio.create_task(self.run(task), name=f"researchtube-timer-{timer_task_id}")
        return self.snapshot(task, reading)

    async def run(self, task):
        try:
            if task.phase == "preparing":
                if not await self.sync():
                    self.finish(task, "failed", self.clock(), {"code": "TIMER_INTERNET_UNAVAILABLE", "message": "The internet clock could not be read. No system-clock fallback was used."})
                    return
                reading = self.clock()
                if self.observe(task, reading):
                    self.finish(task, "failed", reading, {"code": "TIMER_SYSTEM_SUSPENDED", "message": "The timer was interrupted by system suspend."})
                    return
                self.prepare(task, reading)
            while task.status == "working":
                reading = self.clock()
                self.tick(task, reading)
                if task.status != "working":
                    break
                if task.clock_source == "internet" and reading.monotonic - self.internet_sample.monotonic >= SYNC_SECONDS:
                    ok = await self.sync()
                    reading = self.clock()
                    self.tick(task, reading)
                    if task.status != "working":
                        break
                    if not ok:
                        if not any(w["code"] == "INTERNET_CLOCK_STALE" for w in task.warnings):
                            self.warning(task, "INTERNET_CLOCK_STALE", "Internet synchronization failed; time is extrapolated from the last sample.", reading)
                        if reading.monotonic - self.internet_sample.monotonic >= MAX_SAMPLE_AGE_SECONDS:
                            self.finish(task, "failed", reading, {"code": "TIMER_INTERNET_UNAVAILABLE", "message": "The internet-clock sample is too old; no system-clock fallback was used."})
                            break
                        await asyncio.sleep(1)
                remaining = self.metrics(task, self.clock())[2]
                await asyncio.sleep(min(0.25, max(0.001, remaining)))
        except asyncio.CancelledError:
            if task.status == "working":
                self.finish(task, "cancelled", self.clock())
        except self.host.AgentApiError as error:
            self.finish(task, "failed", self.clock(), {"code": error.code, "message": str(error)})
        except Exception:
            self.finish(task, "failed", self.clock(), {"code": "TIMER_FAILED", "message": "The timer could not continue."})

    async def status(self, timer_task_id):
        task = self.get(timer_task_id)
        if task.status == "working":
            wait = min(1, max(0, task.next_poll_monotonic - self.clock().monotonic))
            if wait:
                await asyncio.sleep(wait)
        self.tick(task, self.clock())
        result = self.snapshot(task)
        task.next_poll_monotonic = self.clock().monotonic + result["pollIntervalMs"] / 1000
        return result

    async def cancel(self, timer_task_id):
        task = self.get(timer_task_id)
        self.tick(task, self.clock())
        cancelled = task.status == "working"
        if cancelled:
            self.finish(task, "cancelled", self.clock())
            task.runner.cancel()
            await asyncio.gather(task.runner, return_exceptions=True)
        return {"task": self.snapshot(task), "cancelled": cancelled}

    async def shutdown(self):
        runners = [t.runner for t in self.tasks.values() if t.runner is not None and not t.runner.done()]
        for runner in runners:
            runner.cancel()
        await asyncio.gather(*runners, return_exceptions=True)
