#!/usr/bin/env python3
"""ResearchTube Local Agent — Iteration 2 download Task service.

The Agent is a loopback-only HTTP service. Browser code owns the public MCP
contract; this process owns executable discovery, workspace sandboxing, and
independent yt-dlp subprocesses.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import secrets
import shutil
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

AGENT_VERSION = "0.8.5"
INTERFACE_VERSION = 6
DEFAULT_PORT = 17843
MAX_REQUEST_BODY_BYTES = 64 * 1024
TASK_POLL_INTERVAL_MS = 1_000
TASK_HEARTBEAT_SECONDS = 5
MAX_DIAGNOSTIC_LINES = 20
MAX_DIAGNOSTIC_LINE_LENGTH = 240
ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "agent-config.json"
WORKSPACE_PATH = ROOT / "workspace"
TOOLS_PATH = ROOT / "tools"
DEFAULT_DOWNLOAD_DIRECTORY = "downloads"
MAX_LOGICAL_PATH_LENGTH = 1_024
MAX_LOGICAL_COMPONENT_LENGTH = 240
WINDOWS_INVALID_FILENAME_CHARACTERS = frozenset('<>:"|?*')
WINDOWS_RESERVED_BASENAMES = frozenset({
    "CON", "PRN", "AUX", "NUL", *(f"COM{index}" for index in range(1, 10)), *(f"LPT{index}" for index in range(1, 10)),
})
YTDLP_FORMAT_PROBE_TIMEOUT_SECONDS = 45
MAX_FORMATS_PER_KIND = 100


class AgentApiError(Exception):
    def __init__(self, code: str, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.code, self.message, self.detail = code, message, detail


def executable_names(name: str) -> tuple[str, ...]:
    return (f"{name}.exe", name) if os.name == "nt" else (name, f"{name}.exe")


COMPONENTS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "ytDlp": (executable_names("yt-dlp"), ("--version",)),
    "deno": (executable_names("deno"), ("--version",)),
    "ffmpeg": (executable_names("ffmpeg"), ("-version",)),
    "ffprobe": (executable_names("ffprobe"), ("-version",)),
}
COMPONENT_LABELS = {"ytDlp": "yt-dlp", "deno": "Deno", "ffmpeg": "ffmpeg", "ffprobe": "ffprobe"}
COMPONENT_TOOL_DIRECTORIES = {"ytDlp": "yt-dlp", "deno": "deno", "ffmpeg": "ffmpeg", "ffprobe": "ffmpeg"}


@dataclass(frozen=True)
class ComponentDiscovery:
    source: str | None
    executable: str | None
    error: str | None = None


def log(message: str, *, error: bool = False) -> None:
    prefix = datetime.now().strftime("[%H:%M:%S]")
    print(f"{prefix} {'ERROR ' if error else ''}{message}", file=sys.stderr if error else sys.stdout, flush=True)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def configured_port() -> int:
    try:
        port = json.loads(CONFIG_PATH.read_text(encoding="utf-8")).get("port")
        if isinstance(port, int) and 1 <= port <= 65535:
            return port
    except (OSError, json.JSONDecodeError, AttributeError):
        pass
    return DEFAULT_PORT


def workspace_health() -> dict[str, str]:
    try:
        WORKSPACE_PATH.mkdir(parents=True, exist_ok=True)
        return {"status": "available"}
    except OSError as error:
        log(f"workspace health check failed at {WORKSPACE_PATH}: {error.__class__.__name__}", error=True)
        return {"status": "error"}


def local_executable(path: Path, root: Path) -> Path | None:
    """Accept a file only when it stays inside the designated Agent directory."""
    try:
        resolved = path.resolve(strict=True)
        resolved.relative_to(root.resolve())
        return resolved if resolved.is_file() else None
    except (OSError, ValueError):
        return None


def unique_local_matches(paths: list[Path], root: Path) -> list[Path]:
    matches: dict[str, Path] = {}
    for path in paths:
        resolved = local_executable(path, root)
        if resolved is not None:
            matches[str(resolved)] = resolved
    return [matches[key] for key in sorted(matches)]


def find_component(name: str, candidates: tuple[str, ...]) -> ComponentDiscovery:
    """Resolve the known local tools layout before PATH.

    Supplied archives may keep their own top-level directories. Search only the
    designated component directory under tools/, recursively. This supports
    ordinary extracted archives without ever searching the user's disk. Each
    resolved file is also checked to remain inside tools/; symlinks cannot turn
    the bounded traversal into a path escape.
    """
    tool_directory = TOOLS_PATH / COMPONENT_TOOL_DIRECTORIES[name]
    direct_paths = [tool_directory / candidate for candidate in candidates]
    bin_paths = [tool_directory / "bin" / candidate for candidate in candidates]
    package_paths: list[Path] = []
    try:
        packages = sorted(item for item in tool_directory.iterdir() if item.is_dir() and not item.is_symlink())
    except OSError:
        packages = []
    for package in packages:
        package_paths.extend(package / candidate for candidate in candidates)
        package_paths.extend(package / "bin" / candidate for candidate in candidates)

    recursive_paths: list[Path] = []
    try:
        for candidate in candidates:
            recursive_paths.extend(tool_directory.rglob(candidate))
    except OSError:
        pass

    for paths in (direct_paths, bin_paths, package_paths, recursive_paths):
        matches = unique_local_matches(paths, TOOLS_PATH)
        if len(matches) == 1:
            return ComponentDiscovery("local", str(matches[0]))
        if len(matches) > 1:
            return ComponentDiscovery(
                "local", None,
                f"Multiple {COMPONENT_LABELS[name]} executables were found in the local tools folder. Keep one package there.",
            )

    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return ComponentDiscovery("path", str(Path(resolved).resolve()))
    return ComponentDiscovery(None, None)


def resolve_deno_runtime() -> str | None:
    """Return one explicitly configured local/PATH Deno executable, if any.

    Deno is optional for the Agent itself. When present, yt-dlp receives the
    resolved executable explicitly rather than relying on its own process PATH.
    An ambiguous local tools folder is a configuration error, never a reason to
    choose an arbitrary executable.
    """
    discovery = find_component("deno", COMPONENTS["deno"][0])
    if discovery.error:
        raise AgentApiError("DENO_DISCOVERY_ERROR", "Deno discovery is ambiguous.", discovery.error)
    return discovery.executable


def yt_dlp_js_runtime_arguments(deno_executable: str | None) -> list[str]:
    """Build deterministic yt-dlp JS-runtime arguments for resolved Deno."""
    if not deno_executable:
        return []
    # Select the resolved local Deno even if another runtime is present on PATH.
    return ["--no-js-runtimes", "--js-runtimes", f"deno:{deno_executable}"]


def empty_yt_dlp_formats(message: str) -> dict[str, Any]:
    """Return the public diagnostic shape without leaking yt-dlp internals."""
    return {
        "available": False,
        "source": "ytDlp",
        "message": message,
        "combined": [],
        "video": [],
        "audio": [],
    }


def nullable_nonnegative_int(value: Any) -> int | None:
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def nullable_nonnegative_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def yt_dlp_codec(value: Any) -> str | None:
    return value if isinstance(value, str) and value and value != "none" else None


def normalize_yt_dlp_format(format_data: Any) -> dict[str, Any] | None:
    """Map one yt-dlp format record to the same URL-free public schema.

    A raw -J record contains ephemeral media URLs, headers and other playback
    data.  This allowlist deliberately retains only the stable attributes that
    are useful for comparing itags with the browser's YouTube snapshot.
    """
    if not isinstance(format_data, dict):
        return None
    format_id = str(format_data.get("format_id") or "").strip()
    video_codec = yt_dlp_codec(format_data.get("vcodec"))
    audio_codec = yt_dlp_codec(format_data.get("acodec"))
    # The public download contract deliberately accepts YouTube itags only.
    # Skip yt-dlp's generated/non-itag representations so this diagnostic can
    # be compared one-for-one with the browser's numeric format snapshot.
    if not re.fullmatch(r"[0-9]+", format_id) or (video_codec is None and audio_codec is None):
        return None
    kind = "combined" if video_codec and audio_codec else "video" if video_codec else "audio"
    bitrate_kbps = nullable_nonnegative_float(format_data.get("tbr"))
    if bitrate_kbps is None:
        bitrate_kbps = nullable_nonnegative_float(format_data.get("vbr" if video_codec else "abr"))
    bitrate_bps = round(bitrate_kbps * 1_000) if bitrate_kbps is not None else None
    size_bytes = nullable_nonnegative_int(format_data.get("filesize"))
    if size_bytes is None:
        size_bytes = nullable_nonnegative_int(format_data.get("filesize_approx"))
    return {
        "formatId": format_id,
        "kind": kind,
        "container": format_data.get("ext") if isinstance(format_data.get("ext"), str) else None,
        "videoCodec": video_codec,
        "audioCodec": audio_codec,
        "width": nullable_nonnegative_int(format_data.get("width")) if video_codec else None,
        "height": nullable_nonnegative_int(format_data.get("height")) if video_codec else None,
        "fps": nullable_nonnegative_float(format_data.get("fps")) if video_codec else None,
        "bitrateBps": bitrate_bps,
        "audioSampleRateHz": nullable_nonnegative_int(format_data.get("asr")) if audio_codec else None,
        "audioChannels": nullable_nonnegative_int(format_data.get("audio_channels")) if audio_codec else None,
        "qualityLabel": format_data.get("format_note") if isinstance(format_data.get("format_note"), str) else None,
        "sizeBytes": size_bytes,
    }


def compare_yt_dlp_formats(item: dict[str, Any]) -> tuple[int, int, int, str]:
    return (
        -(item["height"] or 0),
        -round(item["fps"] or 0),
        -(item["bitrateBps"] or 0),
        item["formatId"],
    )


def public_yt_dlp_formats(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or not isinstance(payload.get("formats"), list):
        return empty_yt_dlp_formats("yt-dlp did not return a usable format list for this video.")
    groups: dict[str, list[dict[str, Any]]] = {"combined": [], "video": [], "audio": []}
    seen: set[str] = set()
    for raw_format in payload["formats"]:
        item = normalize_yt_dlp_format(raw_format)
        if item is None or item["formatId"] in seen:
            continue
        seen.add(item["formatId"])
        if len(groups[item["kind"]]) < MAX_FORMATS_PER_KIND:
            groups[item["kind"]].append(item)
    for group in groups.values():
        group.sort(key=compare_yt_dlp_formats)
    if not seen:
        return empty_yt_dlp_formats("yt-dlp did not report downloadable media formats for this video.")
    return {"available": True, "source": "ytDlp", "message": None, **groups}


def yt_dlp_format_probe_debug(command: list[str], exit_code: int | None, stdout: bytes = b"", stderr: bytes = b"") -> dict[str, Any]:
    """Full local diagnostic data, returned only after explicit debug opt-in."""
    return {
        "command": command,
        "exitCode": exit_code,
        "stdout": stdout.decode("utf-8", errors="replace"),
        "stderr": stderr.decode("utf-8", errors="replace"),
    }


async def yt_dlp_format_probe(video_id: Any, *, debug: bool = False) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Inspect yt-dlp's current view of public formats without downloading.

    This endpoint is diagnostic only.  It uses precisely the runtime and
    YouTube client passed to downloads, but it never feeds this list back into
    youtube_get_video. Raw execution output is returned only when the caller
    explicitly requests the local debug mode.
    """
    stable_video_id = validate_video_id(video_id)
    yt_dlp = find_component("ytDlp", COMPONENTS["ytDlp"][0])
    if yt_dlp.error:
        raise AgentApiError("YTDLP_DISCOVERY_ERROR", "yt-dlp discovery is ambiguous.", yt_dlp.error)
    if not yt_dlp.executable:
        raise AgentApiError("YTDLP_NOT_AVAILABLE", "yt-dlp is not available. Place it in tools/yt-dlp or install it on PATH.")
    deno_executable = resolve_deno_runtime()
    command = [
        yt_dlp.executable,
        *yt_dlp_js_runtime_arguments(deno_executable),
        "--no-playlist",
        "--skip-download",
        "--no-warnings",
        "--dump-single-json",
        f"https://www.youtube.com/watch?v={stable_video_id}",
    ]
    try:
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    except OSError as error:
        log(f"yt-dlp format probe could not start for {stable_video_id}: {error.__class__.__name__}", error=True)
        raw = yt_dlp_format_probe_debug(command, None, stderr=str(error).encode("utf-8", errors="replace"))
        return empty_yt_dlp_formats("yt-dlp could not be started for this format diagnostic."), raw if debug else None
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=YTDLP_FORMAT_PROBE_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        process.kill()
        stdout, stderr = await process.communicate()
        log(f"yt-dlp format probe timed out for {stable_video_id}", error=True)
        raw = yt_dlp_format_probe_debug(command, process.returncode, stdout, stderr)
        return empty_yt_dlp_formats("yt-dlp format diagnostic timed out."), raw if debug else None
    if process.returncode != 0:
        log(f"yt-dlp format probe failed for {stable_video_id} (exit {process.returncode})", error=True)
        raw = yt_dlp_format_probe_debug(command, process.returncode, stdout, stderr)
        return empty_yt_dlp_formats("yt-dlp could not retrieve format information for this video."), raw if debug else None
    try:
        document = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        log(f"yt-dlp format probe returned invalid JSON for {stable_video_id}", error=True)
        raw = yt_dlp_format_probe_debug(command, process.returncode, stdout, stderr)
        return empty_yt_dlp_formats("yt-dlp returned invalid format information for this video."), raw if debug else None
    raw = yt_dlp_format_probe_debug(command, process.returncode, stdout, stderr)
    return public_yt_dlp_formats(document), raw if debug else None


async def component_health(name: str, definition: tuple[tuple[str, ...], tuple[str, ...]]) -> tuple[str, dict[str, str | None]]:
    candidates, version_args = definition
    discovery = find_component(name, candidates)
    if discovery.error:
        return name, {"status": "error", "version": None, "source": discovery.source, "privatePath": None, "message": discovery.error}
    if not discovery.executable:
        return name, {"status": "missing", "version": None, "source": None, "privatePath": None, "message": None}
    try:
        process = await asyncio.create_subprocess_exec(discovery.executable, *version_args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=3)
        output = (stdout or stderr).decode("utf-8", errors="replace").strip().splitlines()
        if process.returncode == 0:
            return name, {"status": "available", "version": output[0] if output else None, "source": discovery.source, "privatePath": discovery.executable, "message": None}
        return name, {"status": "error", "version": None, "source": discovery.source, "privatePath": discovery.executable, "message": "Version probe returned a non-zero exit code."}
    except (OSError, asyncio.TimeoutError):
        return name, {"status": "error", "version": None, "source": discovery.source, "privatePath": discovery.executable, "message": "Version probe could not be completed."}


async def health_snapshot() -> dict[str, Any]:
    results = await asyncio.gather(*(component_health(name, definition) for name, definition in COMPONENTS.items()))
    return {
        "status": "ok", "agentVersion": AGENT_VERSION, "interfaceVersion": INTERFACE_VERSION,
        "workspace": workspace_health(), "components": dict(results),
    }


def public_health_document(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Remove host paths before the loopback HTTP/MCP boundary."""
    components = {
        name: {
            "status": component["status"], "version": component["version"],
            "source": component["source"], "message": component["message"],
        }
        for name, component in snapshot["components"].items()
    }
    return {
        "status": snapshot["status"], "agentVersion": snapshot["agentVersion"], "interfaceVersion": snapshot["interfaceVersion"],
        "workspace": {"status": snapshot["workspace"]["status"]}, "components": components,
    }


def log_startup_health(health: dict[str, Any], port: int) -> None:
    log(f"ResearchTube Agent {AGENT_VERSION} started")
    log(f"Agent interface version: {health['interfaceVersion']} — it must match the ResearchTube Extension interface version.")
    log(f"Listening on 127.0.0.1:{port}")
    log(f"Workspace: {WORKSPACE_PATH} ({health['workspace']['status']})")
    for name, component in health["components"].items():
        label = COMPONENT_LABELS[name]
        if component["status"] == "available":
            origin = "PATH" if component["source"] == "path" else "local"
            log(f"{label}: {component['version'] or 'available'} ({origin}: {component['privatePath']})")
        elif component["status"] == "missing":
            log(f"{label}: missing")
        else:
            log(f"{label}: {component['message'] or 'version probe failed'} ({component['source']}: {component['privatePath']})", error=True)


def path_is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def validate_video_id(value: Any) -> str:
    """Accept only the stable public video identifier at the Agent boundary."""
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{6,}", value):
        raise AgentApiError("INVALID_VIDEO_ID", "videoId must be one public YouTube video ID.")
    return value


@dataclass(frozen=True)
class DownloadSelection:
    """A deliberately small, safe subset of yt-dlp's format-selector syntax.

    The Extension publishes format IDs obtained from YouTube.  The Agent never
    accepts an arbitrary yt-dlp selector or command-line fragment.
    """

    combined: str | None = None
    video: str | None = None
    audio: str | None = None

    @property
    def requires_merge(self) -> bool:
        return self.video is not None and self.audio is not None

    def format_selector(self) -> str:
        if self.combined is not None:
            return "best" if self.combined == "best" else self.combined
        parts: list[str] = []
        if self.video is not None:
            parts.append("bestvideo" if self.video == "best" else self.video)
        if self.audio is not None:
            parts.append("bestaudio" if self.audio == "best" else self.audio)
        return "+".join(parts)


def parse_download_selection(value: Any) -> DownloadSelection:
    if not isinstance(value, dict):
        raise AgentApiError("FORMAT_SELECTION_INVALID", "selection must describe one combined track or video and/or audio tracks.")
    unknown = set(value) - {"combined", "video", "audio"}
    if unknown:
        raise AgentApiError("FORMAT_SELECTION_INVALID", "selection contains an unsupported field.")

    def parse_value(name: str) -> str | None:
        candidate = value.get(name)
        if candidate is None:
            return None
        if not isinstance(candidate, str) or not re.fullmatch(r"(?:best|[0-9]+)", candidate):
            raise AgentApiError("FORMAT_SELECTION_INVALID", f"selection.{name} must be 'best', a numeric YouTube formatId, or null.")
        return candidate

    selection = DownloadSelection(parse_value("combined"), parse_value("video"), parse_value("audio"))
    if selection.combined is not None and (selection.video is not None or selection.audio is not None):
        raise AgentApiError("FORMAT_SELECTION_INVALID", "Select either one combined track or video/audio tracks; do not mix them.")
    if selection.combined is None and selection.video is None and selection.audio is None:
        raise AgentApiError("FORMAT_SELECTION_INVALID", "Select a combined, video, or audio track.")
    return selection


@dataclass(frozen=True)
class ResolvedWorkspacePath:
    logical_path: str
    physical_path: Path


class WorkspacePathResolver:
    """One logical POSIX path gate for built-in workspace operations.

    It deliberately rejects rather than normalizes foreign or traversal syntax.
    Physical paths are created only after logical validation and resolved
    containment checks against the workspace root.
    """

    def __init__(self) -> None:
        try:
            WORKSPACE_PATH.mkdir(parents=True, exist_ok=True)
            self.root = WORKSPACE_PATH.resolve(strict=True)
        except OSError as error:
            log(f"workspace resolver could not initialize at {WORKSPACE_PATH}: {error.__class__.__name__}", error=True)
            raise AgentApiError("WORKSPACE_UNAVAILABLE", "The Agent workspace is unavailable.") from error

    @staticmethod
    def logical_parts(value: Any, *, field_name: str, error_code: str) -> tuple[tuple[str, ...], str]:
        if not isinstance(value, str) or not value or value != value.strip():
            raise AgentApiError(error_code, f"{field_name} must be a non-empty logical workspace-relative path.")
        if len(value) > MAX_LOGICAL_PATH_LENGTH or "\x00" in value or "\\" in value or value.startswith("/") or re.match(r"^[A-Za-z]:", value):
            raise AgentApiError(error_code, f"{field_name} must use a safe POSIX-style workspace-relative path.")
        parts = value.split("/")
        if any(not part or part in {".", ".."} for part in parts):
            raise AgentApiError(error_code, f"{field_name} contains an invalid workspace path component.")
        for part in parts:
            reserved_basename = part.split(".", 1)[0].upper()
            if (
                len(part) > MAX_LOGICAL_COMPONENT_LENGTH
                or any(character in WINDOWS_INVALID_FILENAME_CHARACTERS for character in part)
                or part[-1] in {".", " "}
                or reserved_basename in WINDOWS_RESERVED_BASENAMES
            ):
                raise AgentApiError(error_code, f"{field_name} contains a non-portable workspace path component.")
        return tuple(parts), "/".join(parts)

    def resolve_destination(self, value: Any, *, field_name: str, error_code: str) -> ResolvedWorkspacePath:
        parts, logical_path = self.logical_parts(value, field_name=field_name, error_code=error_code)
        candidate = self.root.joinpath(*parts)
        try:
            resolved_candidate = candidate.resolve(strict=False)
        except OSError as error:
            log(f"workspace resolver could not resolve a candidate: {error.__class__.__name__}", error=True)
            raise AgentApiError("WORKSPACE_UNAVAILABLE", "The Agent workspace is unavailable.") from error
        if not path_is_within(resolved_candidate, self.root):
            raise AgentApiError(error_code, f"{field_name} must stay inside the ResearchTube workspace.")
        return ResolvedWorkspacePath(logical_path, resolved_candidate)

    def logical_existing_file(self, physical_path: Path, *, error_code: str) -> str:
        try:
            resolved = physical_path.resolve(strict=True)
        except OSError as error:
            raise AgentApiError(error_code, "The expected workspace output file is unavailable.") from error
        if not path_is_within(resolved, self.root) or not resolved.is_file():
            raise AgentApiError(error_code, "The expected workspace output file is unavailable.")
        relative = resolved.relative_to(self.root).as_posix()
        self.logical_parts(relative, field_name="workspace output", error_code=error_code)
        return relative


def resolve_output_directory(value: Any) -> tuple[Path, str]:
    resolver = WorkspacePathResolver()
    resolved = resolver.resolve_destination(
        DEFAULT_DOWNLOAD_DIRECTORY if value is None else value,
        field_name="outputDir", error_code="OUTPUT_DIR_INVALID",
    )
    return resolved.physical_path, resolved.logical_path


def bounded_line(value: str) -> str:
    return value.strip().replace("\x00", "")[:MAX_DIAGNOSTIC_LINE_LENGTH]


@dataclass
class DownloadTask:
    task_id: str
    url: str
    video_id: str
    selection: DownloadSelection
    output_directory: Path
    output_directory_relative: str
    created_at: str
    last_updated_at: str
    status: str = "working"
    status_message: str = "Starting YouTube download."
    phase: str = "preparing"
    progress_percent: float | None = None
    result: dict[str, Any] | None = None
    error: dict[str, str] | None = None
    process: asyncio.subprocess.Process | None = None
    runner: asyncio.Task[None] | None = None
    cancel_requested: bool = False
    diagnostics: list[str] = field(default_factory=list)
    output_file: Path | None = None

    def touch(self, message: str | None = None) -> None:
        self.last_updated_at = utc_now()
        if message is not None:
            self.status_message = message


class DownloadTaskManager:
    """In-memory task state: no queue and no artificial concurrency ceiling."""

    def __init__(self) -> None:
        self.tasks: dict[str, DownloadTask] = {}

    async def create_download(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise AgentApiError("INVALID_REQUEST", "The JSON body must be an object.")
        video_id = validate_video_id(payload.get("videoId"))
        selection = parse_download_selection(payload.get("selection"))
        # yt-dlp requires a URL, but URL construction is private Agent work.
        url = f"https://www.youtube.com/watch?v={video_id}"
        output_directory, output_directory_relative = resolve_output_directory(payload.get("outputDir"))
        yt_dlp = find_component("ytDlp", COMPONENTS["ytDlp"][0])
        if yt_dlp.error:
            raise AgentApiError("YTDLP_DISCOVERY_ERROR", "yt-dlp discovery is ambiguous.", yt_dlp.error)
        if not yt_dlp.executable:
            raise AgentApiError("YTDLP_NOT_AVAILABLE", "yt-dlp is not available. Place it in tools/yt-dlp or install it on PATH.")
        deno_executable = resolve_deno_runtime()
        ffmpeg_executable: str | None = None
        if selection.requires_merge:
            ffmpeg = find_component("ffmpeg", COMPONENTS["ffmpeg"][0])
            if ffmpeg.error:
                raise AgentApiError("FFMPEG_DISCOVERY_ERROR", "ffmpeg discovery is ambiguous.", ffmpeg.error)
            if not ffmpeg.executable:
                raise AgentApiError(
                    "FFMPEG_NOT_AVAILABLE",
                    "ffmpeg is required when selected video and audio tracks must be merged. Extract it under tools/ffmpeg or install it on PATH.",
                )
            ffmpeg_executable = ffmpeg.executable
        now = utc_now()
        task = DownloadTask(self.new_task_id(), url, video_id, selection, output_directory, output_directory_relative, now, now)
        # Store before responding: returned IDs are immediately pollable.
        self.tasks[task.task_id] = task
        task.runner = asyncio.create_task(
            self.run_download(task, yt_dlp.executable, ffmpeg_executable, deno_executable),
            name=f"researchtube-download-{task.task_id}",
        )
        return self.snapshot(task)

    def new_task_id(self) -> str:
        """Return a short opaque ID with the same length as yt_<videoId>."""
        while True:
            task_id = f"tsk_{secrets.token_urlsafe(7)}"
            if task_id not in self.tasks:
                return task_id

    def get(self, task_id: str) -> DownloadTask:
        if not isinstance(task_id, str) or not task_id or task_id not in self.tasks:
            raise AgentApiError("TASK_NOT_FOUND", "The requested task does not exist.")
        return self.tasks[task_id]

    def snapshot(self, task: DownloadTask) -> dict[str, Any]:
        document: dict[str, Any] = {
            "taskId": task.task_id, "status": task.status, "statusMessage": task.status_message,
            "createdAt": task.created_at, "lastUpdatedAt": task.last_updated_at, "ttlMs": None,
            "pollIntervalMs": TASK_POLL_INTERVAL_MS, "phase": task.phase, "progressPercent": task.progress_percent,
        }
        if task.result is not None:
            document["result"] = task.result
        if task.error is not None:
            document["error"] = task.error
        return document

    async def cancel(self, task_id: str) -> None:
        task = self.get(task_id)
        if task.status in {"completed", "failed", "cancelled"}:
            return
        task.cancel_requested = True
        task.touch("Cancellation requested.")
        if task.process is None:
            if task.runner and not task.runner.done():
                task.runner.cancel()
            task.status = "cancelled"
            task.phase = "cancelled"
            task.touch("Download cancelled.")
            return
        await self.terminate_process(task, task.process)

    async def terminate_process(self, task: DownloadTask, process: asyncio.subprocess.Process) -> None:
        if process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                await process.wait()
        task.status = "cancelled"
        task.phase = "cancelled"
        task.touch("Download cancelled.")

    async def run_download(self, task: DownloadTask, executable: str, ffmpeg: str | None, deno: str | None) -> None:
        heartbeat: asyncio.Task[None] | None = None
        try:
            if task.cancel_requested:
                task.status = "cancelled"
                task.phase = "cancelled"
                task.touch("Download cancelled.")
                return
            task.output_directory.mkdir(parents=True, exist_ok=True)
            output_template = f"%(title)s [yt_%(id)s] [{task.task_id}].%(ext)s"
            command = [
                # --print below is required for the final workspace file path,
                # but yt-dlp documents that it implies --quiet.  Re-enable
                # progress explicitly so the progress template is emitted.
                executable, *yt_dlp_js_runtime_arguments(deno),
                "--no-playlist", "--windows-filenames", "--trim-filenames", "180", "--newline", "--progress", "--progress-delta", "1",
                "--format", task.selection.format_selector(),
            ]
            if task.selection.requires_merge:
                # No re-encode: yt-dlp/ffmpeg remux the exact selected tracks.
                command.extend(["--merge-output-format", "mp4", "--ffmpeg-location", str(Path(ffmpeg).parent)])
            command.extend([
                "--progress-template", "download:researchtube_progress:%(progress._percent_str)s",
                "--progress-template", "postprocess:researchtube_postprocess:%(progress.status)s",
                "--print", "after_move:researchtube_file:%(filepath)s", "--paths", str(task.output_directory),
                "--output", output_template, task.url,
            ])
            task.touch("Preparing yt-dlp download.")
            task.process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout_task = asyncio.create_task(self.consume_stream(task, task.process.stdout, source="stdout"))
            stderr_task = asyncio.create_task(self.consume_stream(task, task.process.stderr, source="stderr"))
            heartbeat = asyncio.create_task(self.heartbeat(task))
            await asyncio.gather(stdout_task, stderr_task, task.process.wait())
            if task.cancel_requested:
                task.status = "cancelled"
                task.phase = "cancelled"
                task.touch("Download cancelled.")
                return
            if task.process.returncode != 0:
                detail = " | ".join(task.diagnostics[-5:]) or None
                task.status = "failed"
                task.phase = "failed"
                if any("requested format is not available" in line.lower() for line in task.diagnostics):
                    task.error = {
                        "code": "FORMAT_NOT_AVAILABLE",
                        "message": "The selected YouTube format is no longer available to yt-dlp.",
                    }
                else:
                    task.error = {"code": "DOWNLOAD_FAILED", "message": "yt-dlp could not download this video."}
                if detail and task.error["code"] == "DOWNLOAD_FAILED":
                    task.error["detail"] = detail
                task.touch("Download failed.")
                return
            output_file = self.valid_output_file(task)
            if output_file is None:
                task.status = "failed"
                task.phase = "failed"
                task.error = {"code": "OUTPUT_FILE_NOT_FOUND", "message": "yt-dlp completed without reporting a workspace output file."}
                task.touch("Download failed.")
                return
            relative_file = WorkspacePathResolver().logical_existing_file(output_file, error_code="OUTPUT_FILE_NOT_FOUND")
            task.result = {"videoId": task.video_id, "filePath": relative_file, "fileName": output_file.name, "outputDir": task.output_directory_relative}
            task.status = "completed"
            task.phase = "completed"
            task.progress_percent = 100.0
            task.touch("Download completed.")
        except asyncio.CancelledError:
            task.status = "cancelled"
            task.phase = "cancelled"
            task.touch("Download cancelled.")
            self.remove_task_artifacts(task)
        except FileNotFoundError:
            task.status = "failed"
            task.phase = "failed"
            task.error = {"code": "YTDLP_NOT_AVAILABLE", "message": "yt-dlp is no longer available."}
            task.touch("Download failed.")
        except OSError as error:
            task.status = "failed"
            task.phase = "failed"
            task.error = {"code": "DOWNLOAD_START_FAILED", "message": "yt-dlp could not be started.", "detail": bounded_line(str(error))}
            task.touch("Download failed.")
        except Exception as error:
            log(f"download task {task.task_id} failed unexpectedly: {error.__class__.__name__}", error=True)
            task.status = "failed"
            task.phase = "failed"
            task.error = {"code": "DOWNLOAD_INTERNAL_ERROR", "message": "The download task encountered an unexpected error."}
            task.touch("Download failed.")
        finally:
            if heartbeat is not None:
                heartbeat.cancel()
                await asyncio.gather(heartbeat, return_exceptions=True)
            if task.status in {"failed", "cancelled"}:
                self.remove_task_artifacts(task)
            task.process = None

    async def heartbeat(self, task: DownloadTask) -> None:
        """Expose liveness when yt-dlp has no new progress line yet."""
        while task.status == "working" and task.process is not None and task.process.returncode is None:
            await asyncio.sleep(TASK_HEARTBEAT_SECONDS)
            if task.status != "working" or task.process is None or task.process.returncode is not None:
                return
            phase_label = {
                "downloadingCombined": "Downloading combined track",
                "downloadingVideo": "Downloading video track",
                "downloadingAudio": "Downloading audio track",
                "merging": "Merging selected tracks",
            }.get(task.phase, "yt-dlp is still running")
            message = f"{phase_label}: {round(task.progress_percent)}%." if task.progress_percent is not None else f"{phase_label}."
            task.touch(message)

    async def consume_stream(self, task: DownloadTask, stream: asyncio.StreamReader | None, *, source: str) -> None:
        if stream is None:
            return
        buffered = ""
        while chunk := await stream.read(4_096):
            buffered += chunk.decode("utf-8", errors="replace")
            lines = re.split(r"[\r\n]+", buffered)
            buffered = lines.pop()
            for line in lines:
                self.consume_output_line(task, line, source=source)
        if buffered:
            self.consume_output_line(task, buffered, source=source)

    def consume_output_line(self, task: DownloadTask, line: str, *, source: str = "manual") -> None:
        text = bounded_line(re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", line))
        if not text:
            return
        # New yt-dlp releases and wrappers may preserve the custom template or
        # emit the standard "[download] 37.4%" form. Both are authoritative.
        progress = re.search(r"(?:researchtube_progress:\s*|\[download\]\s+)([0-9]+(?:[.,][0-9]+)?)%", text)
        if progress:
            percentage = min(100.0, max(0.0, float(progress.group(1).replace(",", "."))))
            next_phase = self.download_phase(task, percentage)
            if next_phase != task.phase:
                task.phase = next_phase
                task.progress_percent = None
            task.progress_percent = percentage
            label = {
                "downloadingCombined": "Downloading combined track",
                "downloadingVideo": "Downloading video track",
                "downloadingAudio": "Downloading audio track",
            }[task.phase]
            task.touch(f"{label}: {round(task.progress_percent)}%.")
        elif text.startswith("researchtube_file:"):
            candidate = Path(text.removeprefix("researchtube_file:").strip())
            task.output_file = candidate if candidate.is_absolute() else task.output_directory / candidate
        elif text.startswith("researchtube_postprocess:") or "[Merger]" in text:
            task.phase = "merging"
            task.progress_percent = None
            task.touch("Merging selected video and audio tracks.")
        else:
            task.diagnostics.append(text)
            if len(task.diagnostics) > MAX_DIAGNOSTIC_LINES:
                del task.diagnostics[:-MAX_DIAGNOSTIC_LINES]

    @staticmethod
    def download_phase(task: DownloadTask, percentage: float) -> str:
        """Translate yt-dlp's per-file percentage into an honest task phase.

        yt-dlp reports 0–100 independently for each selected source.  For a
        selected video+audio pair its second source starts after the first one
        completed, so a reset following a nearly complete video is an audio
        phase transition, not a backwards global task percentage.
        """
        selection = task.selection
        if selection.combined is not None:
            return "downloadingCombined"
        if selection.video is not None and selection.audio is None:
            return "downloadingVideo"
        if selection.audio is not None and selection.video is None:
            return "downloadingAudio"
        if task.phase == "downloadingAudio":
            return "downloadingAudio"
        if task.phase == "downloadingVideo" and task.progress_percent is not None and task.progress_percent >= 99.0 and percentage < task.progress_percent:
            return "downloadingAudio"
        return "downloadingVideo"

    def remove_task_artifacts(self, task: DownloadTask) -> None:
        """Do not leave separate A/V tracks or partial files after a failed task."""
        try:
            marker = f" [{task.task_id}]"
            for item in task.output_directory.iterdir():
                if item.is_file() and marker in item.name:
                    item.unlink(missing_ok=True)
        except OSError as error:
            log(f"could not clean partial files for task {task.task_id}: {error.__class__.__name__}", error=True)

    def valid_output_file(self, task: DownloadTask) -> Path | None:
        workspace = WORKSPACE_PATH.resolve()
        if task.output_file is not None:
            try:
                resolved = task.output_file.resolve()
                if resolved.is_file() and path_is_within(resolved, workspace):
                    return resolved
            except OSError:
                pass
        try:
            matches = sorted(task.output_directory.glob(f"* [{task.task_id}].*"), key=lambda item: item.stat().st_mtime, reverse=True)
        except OSError:
            return None
        for match in matches:
            try:
                resolved = match.resolve()
                if resolved.is_file() and path_is_within(resolved, workspace):
                    return resolved
            except OSError:
                continue
        return None

    async def shutdown(self) -> None:
        await asyncio.gather(*(self.cancel(task.task_id) for task in self.tasks.values() if task.status == "working"), return_exceptions=True)


TASKS = DownloadTaskManager()


def error_document(error: AgentApiError) -> dict[str, Any]:
    payload: dict[str, str] = {"code": error.code, "message": error.message}
    if error.detail:
        payload["detail"] = error.detail
    return {"error": payload}


def http_response(status: str, body: dict[str, Any] | None = None) -> bytes:
    encoded = b"" if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = [
        f"HTTP/1.1 {status}", "Content-Type: application/json; charset=utf-8", f"Content-Length: {len(encoded)}",
        "Access-Control-Allow-Origin: *", "Access-Control-Allow-Methods: GET, POST, OPTIONS",
        "Access-Control-Allow-Headers: Content-Type", "Connection: close", "", "",
    ]
    return "\r\n".join(headers).encode("ascii") + encoded


async def read_request(reader: asyncio.StreamReader) -> tuple[str, str, bytes]:
    request_line = await asyncio.wait_for(reader.readline(), timeout=5)
    parts = request_line.decode("latin-1").strip().split()
    if len(parts) < 2:
        raise AgentApiError("BAD_REQUEST", "Invalid HTTP request.")
    headers: dict[str, str] = {}
    while True:
        line = await asyncio.wait_for(reader.readline(), timeout=5)
        if line in (b"", b"\r\n", b"\n"):
            break
        text = line.decode("latin-1").strip()
        if ":" not in text:
            raise AgentApiError("BAD_REQUEST", "Invalid HTTP headers.")
        key, value = text.split(":", 1)
        headers[key.lower()] = value.strip()
    try:
        content_length = int(headers.get("content-length", "0"))
    except ValueError as error:
        raise AgentApiError("BAD_REQUEST", "Invalid Content-Length.") from error
    if content_length < 0 or content_length > MAX_REQUEST_BODY_BYTES:
        raise AgentApiError("REQUEST_TOO_LARGE", "Request body is too large.")
    body = await asyncio.wait_for(reader.readexactly(content_length), timeout=5) if content_length else b""
    return parts[0].upper(), urlparse(parts[1]).path, body


def parse_json_body(body: bytes) -> Any:
    if not body:
        return {}
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AgentApiError("INVALID_JSON", "The request body must be valid UTF-8 JSON.") from error


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    method, path = "", ""
    try:
        method, path, body = await read_request(reader)
        if method == "OPTIONS":
            response_status, response_body = "204 No Content", None
        elif method == "GET" and path == "/health":
            response_status, response_body = "200 OK", public_health_document(await health_snapshot())
        elif method == "POST" and path == "/diagnostics/yt-dlp-formats":
            payload = parse_json_body(body)
            video_id = validate_video_id(payload.get("videoId"))
            debug = payload.get("debug", False)
            if not isinstance(debug, bool):
                raise AgentApiError("INVALID_REQUEST", "debug must be a boolean when supplied.")
            formats, debug_output = await yt_dlp_format_probe(video_id, debug=debug)
            response_status, response_body = "200 OK", {
                "videoId": video_id,
                "downloadFormats": formats,
                "debug": debug_output,
            }
        elif method == "POST" and path == "/tasks/youtube-download":
            response_status, response_body = "201 Created", await TASKS.create_download(parse_json_body(body))
        elif method == "GET" and path.startswith("/tasks/"):
            response_status, response_body = "200 OK", TASKS.snapshot(TASKS.get(path.removeprefix("/tasks/")))
        elif method == "POST" and path.startswith("/tasks/") and path.endswith("/cancel"):
            task_id = path.removeprefix("/tasks/").removesuffix("/cancel").rstrip("/")
            await TASKS.cancel(task_id)
            response_status, response_body = "202 Accepted", {"accepted": True}
        elif not method:
            response_status, response_body = "400 Bad Request", error_document(AgentApiError("BAD_REQUEST", "Invalid HTTP request."))
        else:
            response_status, response_body = "404 Not Found", error_document(AgentApiError("NOT_FOUND", "Unknown local Agent endpoint."))
        writer.write(http_response(response_status, response_body))
        await writer.drain()
        log(f"{method or 'INVALID'} {path or '/'} -> {response_status.split()[0]}")
    except AgentApiError as error:
        status = "404 Not Found" if error.code == "TASK_NOT_FOUND" else "400 Bad Request"
        writer.write(http_response(status, error_document(error)))
        await writer.drain()
        log(f"{method or 'INVALID'} {path or '/'} -> {status.split()[0]}")
    except (ConnectionError, asyncio.TimeoutError, UnicodeDecodeError, asyncio.IncompleteReadError) as error:
        log(f"request failed: {error.__class__.__name__}", error=True)
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except ConnectionError:
            pass


async def serve(port: int) -> None:
    initial_health = await health_snapshot()
    server = await asyncio.start_server(handle_client, host="127.0.0.1", port=port)
    log_startup_health(initial_health, port)
    try:
        async with server:
            await server.serve_forever()
    finally:
        await TASKS.shutdown()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the ResearchTube Local Agent Task service.")
    parser.add_argument("--port", type=int, help="Override agent-config.json for this run.")
    args = parser.parse_args()
    if args.port is not None and not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    return args


def main() -> int:
    args = parse_args()
    try:
        asyncio.run(serve(args.port if args.port is not None else configured_port()))
    except KeyboardInterrupt:
        return 0
    except OSError as error:
        log(f"ResearchTube Local Agent could not start: {error}", error=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
