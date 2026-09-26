#!/usr/bin/env python3
"""ResearchTube Local Agent — Iteration 2 download Task service.

The Agent is a loopback-only HTTP service. Browser code owns the public MCP
contract; this process owns executable discovery, workspace sandboxing, and
independent yt-dlp subprocesses.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import ctypes
from html import escape
import json
import math
import mimetypes
import os
import platform
import re
import secrets
import shutil
import struct
import string
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlparse
from urllib.request import Request, urlopen

AGENT_VERSION = "1.107.0"
INTERFACE_VERSION = 68
DEFAULT_PORT = 17843
MAX_REQUEST_BODY_BYTES = 64 * 1024
MAX_GOOGLE_TRANSLATE_AUDIO_BYTES = 16 * 1024 * 1024
TASK_POLL_INTERVAL_MS = 1_000
SPEECH_MAX_TEXT_BYTES = 60 * 1024
TASK_HEARTBEAT_SECONDS = 5
MAX_DIAGNOSTIC_LINES = 20
MAX_DIAGNOSTIC_LINE_LENGTH = 240
MAX_TASK_EVENTS = 250
MAX_TASK_EVENT_MESSAGE_LENGTH = 240
YTDLP_FORMATS_TIMEOUT_SECONDS = 30
ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "agent-config.json"
WORKSPACE_PATH = ROOT / "workspace"
TOOLS_PATH = ROOT / "tools"
WINDOWS_SPEECH_SCRIPT_PATH = TOOLS_PATH / "windows-speech" / "researchtube_speech.py"
FONTS_PATH = TOOLS_PATH / "fonts"
YOUTUBE_POT_PROVIDER_PATH = TOOLS_PATH / "youtube-pot-provider"
YOUTUBE_POT_PROVIDER_SERVER_PATH = YOUTUBE_POT_PROVIDER_PATH / "server"
YOUTUBE_POT_PLUGIN_PATH = TOOLS_PATH / "yt-dlp" / "yt-dlp-plugins" / "bgutil-ytdlp-pot-provider.zip"
YOUTUBE_POT_PROVIDER_READY_PATH = YOUTUBE_POT_PROVIDER_PATH / ".researchtube-provider-ready.json"
DEFAULT_DOWNLOAD_DIRECTORY = "downloads"
MAX_LOGICAL_PATH_LENGTH = 1_024
MAX_LOGICAL_COMPONENT_LENGTH = 240
MAX_WORKSPACE_LIST_ENTRIES = 500
MAX_PUBLIC_SHARE_DIRECTORY_ENTRIES = 500
MEDIA_PROBE_TIMEOUT_SECONDS = 15
CAPTURE_FRAME_TIMEOUT_SECONDS = 60
CAMERA_CAPTURE_TIMEOUT_SECONDS = 20
CAMERA_RECORD_MAX_DURATION_SECONDS = 60
CAMERA_AUTO_TARGET_FPS = (60.0, 30.0)
CAMERA_MIN_ADVERTISED_FPS = 25.0
CAMERA_MAX_ADVERTISED_FPS = 120.0
CAMERA_TARGET_FPS_TOLERANCE = 1.0
VISUAL_MAP_TIMEOUT_SECONDS = 180
VISUAL_MAP_MAX_TOTAL_FRAMES = 120
VISUAL_MAP_MAX_GRID_SIDE = 20
VISUAL_MAP_MAX_CELLS = 120
DEFAULT_VISUAL_MAP_MAX_DIMENSION = 4096
DEFAULT_TIMESTAMP_FONT_SIZE_PX = 24
DEFAULT_VISUAL_MAP_TIMESTAMP_FONT = "DejaVuSans.ttf"
DEFAULT_VISUAL_MAP_SCENE_DETECT_THRESHOLD = 10.0
VISUAL_MAP_SCENE_MIN_DISTANCE_SECONDS = 2.0
YOUTUBE_CAPTURE_FRAME_TIMEOUT_SECONDS = 90
YOUTUBE_CAPTURE_PRE_ROLL_SECONDS = 12.0
YOUTUBE_CAPTURE_POST_ROLL_SECONDS = 3.0
YOUTUBE_CAPTURE_SECTION_MERGE_GAP_SECONDS = 10.0
YOUTUBE_CAPTURE_MAX_SECTION_SECONDS = 60.0
YOUTUBE_CAPTURE_SECTION_DELAY_SECONDS = 2.0
YOUTUBE_CAPTURE_SECTION_RETRY_DELAYS_SECONDS = (3.0, 6.0)
YOUTUBE_CAPTURE_FILE_PROGRESS_INTERVAL_SECONDS = 0.5
CAPTURE_FRAME_MAX_FRAMES = 20
DEBUG_BANNER_SWITCH = "--silent-debugger-extension-api"
MAX_CLIPBOARD_TEXT_BYTES = 2 * 1024 * 1024
MAX_CLIPBOARD_IMAGE_FILE_BYTES = 20 * 1024 * 1024
MAX_CLIPBOARD_IMAGE_PIXELS = 50_000_000
MAX_CLIPBOARD_IMAGE_DIB_BYTES = 200 * 1024 * 1024
CLIPBOARD_OPEN_ATTEMPTS = 4
MEDIA_PROBE_SECTIONS = {
    "format": ("-show_format", "format"),
    "streams": ("-show_streams", "streams"),
    "chapters": ("-show_chapters", "chapters"),
    "programs": ("-show_programs", "programs"),
}
WINDOWS_INVALID_FILENAME_CHARACTERS = frozenset('<>:"|?*')
WINDOWS_RESERVED_BASENAMES = frozenset({
    "CON", "PRN", "AUX", "NUL", *(f"COM{index}" for index in range(1, 10)), *(f"LPT{index}" for index in range(1, 10)),
})
class AgentApiError(Exception):
    def __init__(self, code: str, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.code, self.message, self.detail = code, message, detail


@dataclass(frozen=True)
class CameraMode:
    width: int
    height: int
    fps: float | None = None


@dataclass
class CameraDevice:
    """An Agent-only camera record. native_identity is never serialized or logged."""
    camera_id: str
    name: str
    backend: str
    native_identity: str
    audio_identity: str | None
    modes: tuple[CameraMode, ...]
    selected_mode: CameraMode | None


CAMERA_DEVICES_BY_NATIVE: dict[tuple[str, str], CameraDevice] = {}


def executable_names(name: str) -> tuple[str, ...]:
    return (f"{name}.exe", name) if os.name == "nt" else (name, f"{name}.exe")


COMPONENTS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "ytDlp": (executable_names("yt-dlp"), ("--version",)),
    "deno": (executable_names("deno"), ("--version",)),
    "ffmpeg": (executable_names("ffmpeg"), ("-version",)),
    "ffprobe": (executable_names("ffprobe"), ("-version",)),
    "cloudflared": (executable_names("cloudflared"), ("--version",)),
}
COMPONENT_LABELS = {"ytDlp": "yt-dlp", "deno": "Deno", "ffmpeg": "ffmpeg", "ffprobe": "ffprobe", "cloudflared": "cloudflared", "youtubePoTokenProvider": "YouTube PO-token provider"}
COMPONENT_TOOL_DIRECTORIES = {"ytDlp": "yt-dlp", "deno": "deno", "ffmpeg": "ffmpeg", "ffprobe": "ffmpeg", "cloudflared": "cloudflared"}
PUBLIC_TUNNEL_URL: str | None = None
PUBLIC_TUNNEL_PROCESS: asyncio.subprocess.Process | None = None
PUBLIC_TUNNEL_READY = asyncio.Event()
PUBLIC_TUNNEL_WATCHERS: list[asyncio.Task[None]] = []
PUBLIC_SHARE_SERVER: asyncio.AbstractServer | None = None
PUBLIC_SHARE_FOLDER: ResolvedWorkspacePath | None = None
PUBLIC_SHARE_FILE: ResolvedWorkspacePath | None = None
PUBLIC_SHARE_FILE_TYPES: tuple[str, ...] = ()
PUBLIC_SHARE_EXTERNAL_PROBE: dict[str, Any] = {"state": "not_requested", "provider": "wsrv.nl", "probePath": None, "httpStatus": None, "contentType": None}
PUBLIC_SHARE_LOCK = asyncio.Lock()
PUBLIC_SHARE_FILE_TYPE_SUFFIXES: dict[str, frozenset[str]] = {
    "images": frozenset({".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"}),
    "audio": frozenset({".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav", ".weba"}),
    "video": frozenset({".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm"}),
    "documents": frozenset({".csv", ".html", ".htm", ".json", ".md", ".pdf", ".rtf", ".text", ".txt", ".xml"}),
    "archives": frozenset({".7z", ".bz2", ".gz", ".rar", ".tar", ".xz", ".zip"}),
}
PUBLIC_SHARE_FILE_TYPE_NAMES = frozenset((*PUBLIC_SHARE_FILE_TYPE_SUFFIXES, "other", "all"))


@dataclass(frozen=True)
class ComponentDiscovery:
    source: str | None
    executable: str | None
    error: str | None = None


def log(message: str, *, error: bool = False, color: str | None = None) -> None:
    prefix = datetime.now().strftime("[%H:%M:%S]")
    stream = sys.stderr if error else sys.stdout
    line = f"{prefix} {'ERROR ' if error else ''}{message}"
    # Keep redirected logs plain, while making the first interactive startup
    # line easy to spot in the Agent console.
    if color == "red" and stream.isatty():
        line = f"\x1b[31m{line}\x1b[0m"
    print(line, file=stream, flush=True)


def clear_console() -> None:
    """Clear an interactive terminal before the Agent prints its startup health."""
    if not sys.stdout.isatty():
        return
    try:
        os.system("cls" if os.name == "nt" else "clear")
    except OSError:
        pass


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


def configured_visual_map_timestamp_font() -> str:
    """Return the configured font filename, never a path outside tools/fonts."""
    try:
        value = json.loads(CONFIG_PATH.read_text(encoding="utf-8")).get("visualMapTimestampFont", DEFAULT_VISUAL_MAP_TIMESTAMP_FONT)
    except (OSError, json.JSONDecodeError, AttributeError):
        return DEFAULT_VISUAL_MAP_TIMESTAMP_FONT
    if not isinstance(value, str) or not value or "/" in value or "\\" in value or Path(value).name != value or Path(value).suffix.lower() not in {".ttf", ".otf"}:
        raise AgentApiError("VISUAL_MAP_TIMESTAMP_FONT_INVALID", "visualMapTimestampFont must be a .ttf or .otf filename from tools/fonts.")
    return value


def workspace_health() -> dict[str, str | int | None]:
    try:
        WORKSPACE_PATH.mkdir(parents=True, exist_ok=True)
        return {"status": "available", "availableBytes": shutil.disk_usage(WORKSPACE_PATH).free}
    except OSError as error:
        log(f"workspace health check failed at {WORKSPACE_PATH}: {error.__class__.__name__}", error=True)
        return {"status": "error", "availableBytes": None}


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


def youtube_pot_provider_status(deno_executable: str | None = None) -> dict[str, str]:
    """Describe the mandatory local BgUtils provider without exposing paths."""
    if not YOUTUBE_POT_PLUGIN_PATH.is_file():
        return {"state": "notInstalled", "provider": "bgutil"}
    if not YOUTUBE_POT_PROVIDER_SERVER_PATH.is_dir():
        return {"state": "incomplete", "provider": "bgutil"}
    if not YOUTUBE_POT_PROVIDER_READY_PATH.is_file():
        return {"state": "notReady", "provider": "bgutil"}
    if deno_executable is None:
        try:
            deno_executable = resolve_deno_runtime()
        except AgentApiError:
            deno_executable = None
    if not deno_executable:
        return {"state": "runtimeMissing", "provider": "bgutil"}
    return {"state": "ready", "provider": "bgutil"}


async def youtube_pot_provider_health() -> tuple[str, dict[str, str | None]]:
    """Expose the installed provider as a first-class mandatory Agent tool."""
    state = youtube_pot_provider_status()
    base = {"source": "local", "privatePath": str(YOUTUBE_POT_PROVIDER_PATH)}
    if state["state"] == "ready":
        try:
            marker = json.loads(YOUTUBE_POT_PROVIDER_READY_PATH.read_text(encoding="utf-8"))
            version = marker.get("version") if isinstance(marker, dict) else None
        except (OSError, json.JSONDecodeError):
            version = None
        return "youtubePoTokenProvider", {"status": "available", "version": version if isinstance(version, str) else "bgutil", **base, "message": None}
    if state["state"] == "notInstalled":
        return "youtubePoTokenProvider", {"status": "missing", "version": None, **base, "message": "Run install-youtube-po-token-provider.ps1."}
    messages = {
        "incomplete": "Provider files are incomplete. Run install-youtube-po-token-provider.ps1 again.",
        "notReady": "Provider dependencies are not approved. Re-run install-youtube-po-token-provider.ps1.",
        "runtimeMissing": "Deno is required by the YouTube PO-token provider.",
    }
    return "youtubePoTokenProvider", {"status": "error", "version": None, **base, "message": messages.get(state["state"], "Provider is unavailable.")}


def yt_dlp_youtube_arguments(deno_executable: str | None) -> list[str]:
    """Use the same runtime/client/provider setup for every YouTube call."""
    arguments = yt_dlp_js_runtime_arguments(deno_executable)
    provider = youtube_pot_provider_status(deno_executable)
    if provider["state"] != "ready":
        raise AgentApiError("YOUTUBE_POT_PROVIDER_NOT_AVAILABLE", "The mandatory YouTube PO-token provider is not ready. Run install-youtube-po-token-provider.ps1 and restart the Local Agent.")
    if provider["state"] == "ready":
        # Keep yt-dlp's normal client selection. Forcing mweb makes the token
        # path work on some videos but can remove high-resolution DASH formats,
        # which defeats ResearchTube's exact stream selection. The provider
        # hooks into whichever normal YouTube client yt-dlp selects.
        arguments.extend([
            "--extractor-args",
            f"youtube-bgutilscript:server_home={YOUTUBE_POT_PROVIDER_SERVER_PATH}",
        ])
    return arguments


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
    component_results, chrome_automation = await asyncio.gather(
        asyncio.gather(*(component_health(name, definition) for name, definition in COMPONENTS.items()), youtube_pot_provider_health()),
        chrome_automation_status(),
    )
    return {
        "status": "ok", "agentVersion": AGENT_VERSION, "interfaceVersion": INTERFACE_VERSION,
        "platform": public_platform_metadata(), "workspace": workspace_health(), "components": dict(component_results),
        "chromeAutomation": chrome_automation,
    }


def public_platform_metadata() -> dict[str, str]:
    """Return portable OS facts without host, user, path, or network identity."""
    return {
        "operatingSystem": platform.system() or "Unknown",
        "release": platform.release() or "Unknown",
        "version": platform.version() or "Unknown",
        "architecture": platform.machine() or "Unknown",
    }


def debug_banner_unknown(message: str, *, chrome_running: bool | None = None) -> dict[str, Any]:
    """Return a privacy-preserving result when Chrome launch flags are unavailable."""
    return {
        "chromeRunning": chrome_running,
        "browserInstances": 0,
        "configuration": "unknown",
        "requiredSwitch": DEBUG_BANNER_SWITCH,
        "message": message,
    }


def summarize_debug_banner_process_report(report: Any) -> dict[str, Any]:
    """Validate the deliberately aggregate-only Windows process query result."""
    if not isinstance(report, dict):
        return debug_banner_unknown("Chrome process information could not be read.")
    chrome_running = report.get("chromeRunning")
    browser_instances = report.get("browserInstances")
    enabled_instances = report.get("enabledInstances")
    if not isinstance(chrome_running, bool) or not isinstance(browser_instances, int) or isinstance(browser_instances, bool) \
            or not isinstance(enabled_instances, int) or isinstance(enabled_instances, bool) \
            or browser_instances < 0 or enabled_instances < 0 or enabled_instances > browser_instances:
        return debug_banner_unknown("Chrome process information could not be read.")
    if not chrome_running:
        return debug_banner_unknown("Chrome is not currently running.", chrome_running=False)
    if browser_instances == 0:
        return debug_banner_unknown("Chrome is running, but its browser instances could not be identified.", chrome_running=True)
    if enabled_instances == browser_instances:
        configuration = "banner_suppressed"
        message = f"All running Chrome browser instances use {DEBUG_BANNER_SWITCH}. ResearchTube debugger operations should not show the Chrome debugging banner."
    elif enabled_instances == 0:
        configuration = "banner_enabled"
        message = f"Chrome is running without {DEBUG_BANNER_SWITCH}. ResearchTube debugger operations may show the Chrome debugging banner."
    else:
        configuration = "mixed"
        message = f"Some running Chrome browser instances use {DEBUG_BANNER_SWITCH} and some do not. The Chrome debugging banner may appear depending on the instance used by ResearchTube."
    return {
        "chromeRunning": True,
        "browserInstances": browser_instances,
        "configuration": configuration,
        "requiredSwitch": DEBUG_BANNER_SWITCH,
        "message": message,
    }


async def debug_banner_status() -> dict[str, Any]:
    """Inspect only aggregate Chrome launch-flag state for the current request.

    The PowerShell side deliberately emits counts only. Raw command lines, PIDs,
    profiles and paths never cross into the Agent result or its loopback API.
    """
    if os.name != "nt":
        return debug_banner_unknown("Chrome startup switches can be checked by this ResearchTube Agent only on Windows.")
    script = r'''
$ErrorActionPreference = 'Stop'
$chrome = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'chrome.exe'")
$browser = @($chrome | Where-Object {
  $commandLine = [string]$_.CommandLine
  $commandLine -notmatch '(?i)(?:^|\s)--type(?:=|\s)'
})
$enabled = @($browser | Where-Object {
  ([string]$_.CommandLine) -match '(?i)(?:^|\s)--silent-debugger-extension-api(?:\s|$)'
})
[pscustomobject]@{
  chromeRunning = ($chrome.Count -gt 0)
  browserInstances = $browser.Count
  enabledInstances = $enabled.Count
} | ConvertTo-Json -Compress
'''
    try:
        process = await asyncio.create_subprocess_exec(
            "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _stderr = await asyncio.wait_for(process.communicate(), timeout=5)
        if process.returncode != 0:
            return debug_banner_unknown("Chrome process information could not be read.")
        report = json.loads(stdout.decode("utf-8-sig", errors="replace"))
        return summarize_debug_banner_process_report(report)
    except (OSError, asyncio.TimeoutError, json.JSONDecodeError):
        return debug_banner_unknown("Chrome process information could not be read.")


async def chrome_automation_status() -> dict[str, Any]:
    """Expose the aggregate automation-switch state as part of Agent health."""
    report = await debug_banner_status()
    configuration = report["configuration"]
    state = {
        "banner_suppressed": "enabled",
        "banner_enabled": "disabled",
        "mixed": "mixed",
        "unknown": "unknown",
    }[configuration]
    return {
        "state": state,
        "chromeRunning": report["chromeRunning"],
        "browserInstances": report["browserInstances"],
        "message": report["message"],
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
        "platform": snapshot["platform"],
        "workspace": {
            "status": snapshot["workspace"]["status"],
            "availableBytes": snapshot["workspace"]["availableBytes"],
        },
        "components": components,
        "chromeAutomation": snapshot.get("chromeAutomation", {"state": "unknown", "chromeRunning": None, "browserInstances": 0, "message": "Chrome automation status was not included in this health snapshot."}),
    }


def log_startup_health(health: dict[str, Any], port: int) -> None:
    log(f"ResearchTube Agent {AGENT_VERSION} started", color="red")
    log(f"Agent interface version: {health['interfaceVersion']} — it must match the ResearchTube Extension interface version.")
    platform_metadata = health["platform"]
    log(f"Platform: {platform_metadata['operatingSystem']} {platform_metadata['release']} ({platform_metadata['architecture']})")
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

    The Agent never accepts an arbitrary yt-dlp selector or command-line
    fragment. Exact numeric IDs are expected to come from the Local Agent's
    youtube_download_get_formats workflow, not the advisory YouTube snapshot.
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


def parse_format_selection(value: Any) -> DownloadSelection:
    if not isinstance(value, dict):
        raise AgentApiError("FORMAT_SELECTION_INVALID", "formatSelection must describe one combined track or video and/or audio tracks.")
    unknown = set(value) - {"combined", "video", "audio"}
    if unknown:
        raise AgentApiError("FORMAT_SELECTION_INVALID", "formatSelection contains an unsupported field.")

    def parse_value(name: str) -> str | None:
        candidate = value.get(name)
        if candidate is None:
            return None
        if not isinstance(candidate, str) or not re.fullmatch(r"(?:best|[0-9]+)", candidate):
            raise AgentApiError("FORMAT_SELECTION_INVALID", f"formatSelection.{name} must be 'best', a numeric YouTube formatId, or null.")
        return candidate

    selection = DownloadSelection(parse_value("combined"), parse_value("video"), parse_value("audio"))
    if selection.combined is not None and (selection.video is not None or selection.audio is not None):
        raise AgentApiError("FORMAT_SELECTION_INVALID", "Select either one combined track or video/audio tracks; do not mix them.")
    if selection.combined is None and selection.video is None and selection.audio is None:
        raise AgentApiError("FORMAT_SELECTION_INVALID", "Select a combined, video, or audio track.")
    return selection


@dataclass(frozen=True)
class DownloadRange:
    start_seconds: float
    end_seconds: float

    def filename_tag(self) -> str:
        return f"partial_{self.start_seconds:.3f}_{self.end_seconds:.3f}"


def parse_download_range(payload: dict[str, Any]) -> DownloadRange | None:
    start = payload.get("startSeconds")
    end = payload.get("endSeconds")
    if start is None and end is None:
        return None
    if start is None or end is None:
        raise AgentApiError("DOWNLOAD_RANGE_INVALID", "startSeconds and endSeconds must be supplied together.")
    if isinstance(start, bool) or not isinstance(start, (int, float)) or not math.isfinite(start) or start < 0:
        raise AgentApiError("DOWNLOAD_RANGE_INVALID", "startSeconds must be a finite non-negative number.")
    if isinstance(end, bool) or not isinstance(end, (int, float)) or not math.isfinite(end) or end < 0:
        raise AgentApiError("DOWNLOAD_RANGE_INVALID", "endSeconds must be a finite non-negative number.")
    if end <= start:
        raise AgentApiError("DOWNLOAD_RANGE_INVALID", "endSeconds must be greater than startSeconds.")
    return DownloadRange(float(start), float(end))


def nullable_nonnegative_number(value: Any) -> float | int | None:
    """Return one finite non-negative JSON number, otherwise None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return value


def nullable_nonnegative_integer(value: Any) -> int | None:
    number = nullable_nonnegative_number(value)
    return int(number) if number is not None and float(number).is_integer() else None


def normalize_yt_dlp_format(format_data: Any) -> dict[str, Any] | None:
    """Publish a non-sensitive, selectable yt-dlp format record.

    The source document contains signed media URLs and other ephemeral player
    details.  This projection intentionally keeps only stable technical
    properties and the exact format ID accepted by the same local yt-dlp.
    """
    if not isinstance(format_data, dict):
        return None
    format_id = format_data.get("format_id")
    if not isinstance(format_id, str) or not re.fullmatch(r"[0-9]+", format_id):
        return None
    video_codec = format_data.get("vcodec")
    audio_codec = format_data.get("acodec")
    has_video = isinstance(video_codec, str) and video_codec != "none"
    has_audio = isinstance(audio_codec, str) and audio_codec != "none"
    if not has_video and not has_audio:
        return None
    kind = "combined" if has_video and has_audio else "video" if has_video else "audio"
    size = nullable_nonnegative_integer(format_data.get("filesize"))
    if size is None:
        size = nullable_nonnegative_integer(format_data.get("filesize_approx"))
    bitrate_kbps = nullable_nonnegative_number(format_data.get("tbr"))
    if bitrate_kbps is None:
        bitrate_kbps = nullable_nonnegative_number(format_data.get("vbr" if has_video else "abr"))
    quality = format_data.get("format_note")
    if not isinstance(quality, str) or not quality:
        quality = format_data.get("resolution") if has_video else None
    return {
        "formatId": format_id,
        "kind": kind,
        "container": format_data.get("ext") if isinstance(format_data.get("ext"), str) else None,
        "videoCodec": video_codec if has_video else None,
        "audioCodec": audio_codec if has_audio else None,
        "width": nullable_nonnegative_integer(format_data.get("width")) if has_video else None,
        "height": nullable_nonnegative_integer(format_data.get("height")) if has_video else None,
        "fps": nullable_nonnegative_number(format_data.get("fps")) if has_video else None,
        "bitrateBps": int(bitrate_kbps * 1000) if bitrate_kbps is not None else None,
        "audioSampleRateHz": nullable_nonnegative_integer(format_data.get("asr")) if has_audio else None,
        "audioChannels": nullable_nonnegative_integer(format_data.get("audio_channels")) if has_audio else None,
        "qualityLabel": quality,
        "sizeBytes": size,
    }


def normalize_yt_dlp_formats(document: Any) -> dict[str, Any]:
    grouped: dict[str, Any] = {
        "available": False, "source": "unavailable",
        "message": "yt-dlp did not expose downloadable media formats for this video.",
        "combined": [], "video": [], "audio": [],
    }
    formats = document.get("formats") if isinstance(document, dict) else None
    if not isinstance(formats, list):
        return grouped
    seen: set[str] = set()
    for raw_format in formats:
        item = normalize_yt_dlp_format(raw_format)
        if item is None or item["formatId"] in seen:
            continue
        seen.add(item["formatId"])
        grouped[item["kind"]].append(item)
    for entries in (grouped["combined"], grouped["video"], grouped["audio"]):
        entries.sort(key=lambda item: (item["height"] or 0, item["fps"] or 0, item["bitrateBps"] or 0, item["formatId"]))
    if seen:
        grouped["available"] = True
        grouped["source"] = "ytDlp"
        grouped["message"] = None
    return grouped


async def youtube_download_formats(payload: Any) -> dict[str, Any]:
    """Read formats from the exact local yt-dlp installation used for downloads."""
    if not isinstance(payload, dict):
        raise AgentApiError("INVALID_REQUEST", "youtube_download_get_formats requires a JSON object.")
    video_id = validate_video_id(payload.get("videoId"))
    yt_dlp = find_component("ytDlp", COMPONENTS["ytDlp"][0])
    if yt_dlp.error:
        raise AgentApiError("YTDLP_DISCOVERY_ERROR", "yt-dlp discovery is ambiguous.", yt_dlp.error)
    if not yt_dlp.executable:
        raise AgentApiError("YTDLP_NOT_AVAILABLE", "yt-dlp is not available. Place it in tools/yt-dlp or install it on PATH.")
    deno_executable = resolve_deno_runtime()
    command = [
        yt_dlp.executable, *yt_dlp_youtube_arguments(deno_executable),
        "--no-playlist", "--skip-download", "--no-warnings", "--dump-single-json",
        f"https://www.youtube.com/watch?v={video_id}",
    ]
    try:
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, _stderr = await asyncio.wait_for(process.communicate(), timeout=YTDLP_FORMATS_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        process.kill()
        await process.communicate()
        return {"videoId": video_id, "downloadFormats": normalize_yt_dlp_formats(None)}
    except OSError as error:
        log(f"yt-dlp format discovery could not start: {error.__class__.__name__}", error=True)
        return {"videoId": video_id, "downloadFormats": normalize_yt_dlp_formats(None)}
    if process.returncode != 0:
        log(f"yt-dlp format discovery for {video_id} exited {process.returncode}", error=True)
        return {"videoId": video_id, "downloadFormats": normalize_yt_dlp_formats(None)}
    try:
        document = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        log(f"yt-dlp format discovery for {video_id} returned invalid JSON", error=True)
        return {"videoId": video_id, "downloadFormats": normalize_yt_dlp_formats(None)}
    return {"videoId": video_id, "downloadFormats": normalize_yt_dlp_formats(document)}


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
    def logical_parts(value: Any, *, field_name: str, error_code: str, allow_root: bool = False) -> tuple[tuple[str, ...], str]:
        if allow_root and value == "":
            return (), ""
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

    def resolve_destination(self, value: Any, *, field_name: str, error_code: str, allow_root: bool = False) -> ResolvedWorkspacePath:
        parts, logical_path = self.logical_parts(value, field_name=field_name, error_code=error_code, allow_root=allow_root)
        candidate = self.root.joinpath(*parts)
        # Do not let built-in tools traverse a symbolic link or Windows
        # junction even when its current target happens to be inside workspace.
        # This also prevents delete/move from unexpectedly operating on the
        # target rather than the link itself.
        component = self.root
        for part in parts:
            component = component / part
            is_junction = getattr(component, "is_junction", lambda: False)
            if component.is_symlink() or is_junction():
                raise AgentApiError(error_code, f"{field_name} cannot traverse a workspace filesystem redirect.")
        try:
            resolved_candidate = candidate.resolve(strict=False)
        except OSError as error:
            log(f"workspace resolver could not resolve a candidate: {error.__class__.__name__}", error=True)
            raise AgentApiError("WORKSPACE_UNAVAILABLE", "The Agent workspace is unavailable.") from error
        if not path_is_within(resolved_candidate, self.root):
            raise AgentApiError(error_code, f"{field_name} must stay inside the ResearchTube workspace.")
        return ResolvedWorkspacePath(logical_path, resolved_candidate)

    def resolve_existing(self, value: Any, *, field_name: str, expected_type: str | None = None, allow_root: bool = False) -> ResolvedWorkspacePath:
        resolved = self.resolve_destination(
            value, field_name=field_name, error_code="WORKSPACE_PATH_INVALID", allow_root=allow_root,
        )
        try:
            physical_path = resolved.physical_path.resolve(strict=True)
        except FileNotFoundError as error:
            code = "DIRECTORY_NOT_FOUND" if expected_type == "directory" else "FILE_NOT_FOUND" if expected_type == "file" else "WORKSPACE_NOT_FOUND"
            raise AgentApiError(code, f"The requested workspace {expected_type or 'path'} does not exist.") from error
        except OSError as error:
            raise AgentApiError("WORKSPACE_UNAVAILABLE", "The Agent workspace is unavailable.") from error
        if not path_is_within(physical_path, self.root):
            raise AgentApiError("WORKSPACE_PATH_OUTSIDE_SANDBOX", f"{field_name} must stay inside the ResearchTube workspace.")
        if expected_type == "file" and not physical_path.is_file():
            raise AgentApiError("FILE_NOT_FOUND", "The requested workspace file does not exist.")
        if expected_type == "directory" and not physical_path.is_dir():
            raise AgentApiError("DIRECTORY_NOT_FOUND", "The requested workspace directory does not exist.")
        return ResolvedWorkspacePath(resolved.logical_path, physical_path)

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


def workspace_object_type(path: Path) -> str:
    if path.is_file():
        return "file"
    if path.is_dir():
        return "directory"
    return "other"


def workspace_modified_at(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def workspace_list(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise AgentApiError("INVALID_REQUEST", "workspace_list requires a JSON object.")
    path = payload.get("path", "")
    limit, extensions = payload.get("limit", 100), payload.get("extensions")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_WORKSPACE_LIST_ENTRIES:
        raise AgentApiError("INVALID_REQUEST", f"limit must be an integer from 1 to {MAX_WORKSPACE_LIST_ENTRIES}.")
    if extensions is not None and (not isinstance(extensions, list) or not extensions or any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9]{1,16}", value) for value in extensions)):
        raise AgentApiError("INVALID_REQUEST", "extensions must be a non-empty array of extension names without dots.")
    extension_filter = {value.casefold() for value in extensions} if extensions is not None else None
    directory = WorkspacePathResolver().resolve_existing(path, field_name="path", expected_type="directory", allow_root=True)
    try:
        children = sorted(directory.physical_path.iterdir(), key=lambda item: (item.name.casefold(), item.name))
    except OSError as error:
        raise AgentApiError("PERMISSION_DENIED", "The workspace directory could not be listed.") from error
    entries: list[dict[str, Any]] = []
    for child in children:
        # Never follow a redirect while producing directory metadata.
        if child.is_symlink() or getattr(child, "is_junction", lambda: False)():
            entry_type, size = "other", None
        else:
            entry_type = workspace_object_type(child)
            try:
                size = child.stat().st_size if entry_type == "file" else None
            except OSError:
                entry_type, size = "other", None
        if extension_filter is not None and (entry_type != "file" or child.suffix.removeprefix(".").casefold() not in extension_filter):
            continue
        logical_path = f"{directory.logical_path}/{child.name}" if directory.logical_path else child.name
        entries.append({"name": child.name, "path": logical_path, "type": entry_type, "size": size})
        if len(entries) >= limit:
            break
    log(f"workspace_list path={directory.logical_path or '<root>'} -> ok")
    return {"path": directory.logical_path, "entries": entries, "returned": len(entries), "limit": limit, "extensions": sorted(extension_filter) if extension_filter is not None else None}


def workspace_stat(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise AgentApiError("INVALID_REQUEST", "workspace_stat requires a JSON object.")
    item = WorkspacePathResolver().resolve_existing(payload.get("path"), field_name="path")
    item_type = workspace_object_type(item.physical_path)
    if item_type == "other":
        raise AgentApiError("WORKSPACE_NOT_FOUND", "The requested workspace path is not a regular file or directory.")
    try:
        size = item.physical_path.stat().st_size if item_type == "file" else None
        modified_at = workspace_modified_at(item.physical_path)
    except OSError as error:
        raise AgentApiError("PERMISSION_DENIED", "The requested workspace path could not be inspected.") from error
    log(f"workspace_stat path={item.logical_path} -> ok")
    return {"path": item.logical_path, "type": item_type, "size": size, "modifiedAt": modified_at}


def workspace_mkdir(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise AgentApiError("INVALID_REQUEST", "workspace_mkdir requires a JSON object.")
    directory = WorkspacePathResolver().resolve_destination(payload.get("path"), field_name="path", error_code="WORKSPACE_PATH_INVALID")
    try:
        already_exists = directory.physical_path.exists()
        if already_exists and not directory.physical_path.is_dir():
            raise AgentApiError("DESTINATION_EXISTS", "A non-directory workspace object already exists at path.")
        directory.physical_path.mkdir(parents=True, exist_ok=True)
    except AgentApiError:
        raise
    except PermissionError as error:
        raise AgentApiError("PERMISSION_DENIED", "The workspace directory could not be created.") from error
    except OSError as error:
        raise AgentApiError("WORKSPACE_OPERATION_FAILED", "The workspace directory could not be created.") from error
    log(f"workspace_mkdir path={directory.logical_path} -> ok")
    return {"path": directory.logical_path, "type": "directory", "created": not already_exists}


def workspace_move(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise AgentApiError("INVALID_REQUEST", "workspace_move requires a JSON object.")
    resolver = WorkspacePathResolver()
    source = resolver.resolve_existing(payload.get("source"), field_name="source")
    source_type = workspace_object_type(source.physical_path)
    if source_type == "other":
        raise AgentApiError("WORKSPACE_NOT_FOUND", "source is not a regular file or directory.")
    destination = resolver.resolve_destination(payload.get("destination"), field_name="destination", error_code="WORKSPACE_PATH_INVALID")
    if destination.physical_path.exists() or destination.physical_path.is_symlink():
        raise AgentApiError("DESTINATION_EXISTS", "destination already exists; workspace_move never overwrites files.")
    if not destination.physical_path.parent.is_dir():
        raise AgentApiError("DIRECTORY_NOT_FOUND", "The destination parent directory does not exist.")
    try:
        source.physical_path.rename(destination.physical_path)
    except PermissionError as error:
        raise AgentApiError("PERMISSION_DENIED", "The workspace item could not be moved.") from error
    except OSError as error:
        raise AgentApiError("WORKSPACE_OPERATION_FAILED", "The workspace item could not be moved.") from error
    log(f"workspace_move {source.logical_path} -> {destination.logical_path} -> ok")
    return {"source": source.logical_path, "destination": destination.logical_path, "type": source_type}


def workspace_delete(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise AgentApiError("INVALID_REQUEST", "workspace_delete requires a JSON object.")
    item = WorkspacePathResolver().resolve_existing(payload.get("path"), field_name="path")
    item_type = workspace_object_type(item.physical_path)
    try:
        if item_type == "file":
            item.physical_path.unlink()
        elif item_type == "directory":
            item.physical_path.rmdir()
        else:
            raise AgentApiError("WORKSPACE_NOT_FOUND", "The requested workspace path is not a regular file or directory.")
    except AgentApiError:
        raise
    except OSError as error:
        if item_type == "directory" and item.physical_path.exists():
            raise AgentApiError("DIRECTORY_NOT_EMPTY", "workspace_delete only removes empty directories.") from error
        raise AgentApiError("PERMISSION_DENIED", "The workspace item could not be deleted.") from error
    log(f"workspace_delete path={item.logical_path} -> ok")
    return {"path": item.logical_path, "type": item_type, "deleted": True}


def ffprobe_integer(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def finite_number(value: Any, *, field_name: str, minimum: float | None = None, maximum: float | None = None) -> float:
    """Validate a JSON number without accepting booleans or NaN/Infinity."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise AgentApiError("CAPTURE_FRAME_INVALID", f"{field_name} must be a finite number.")
    number = float(value)
    if minimum is not None and number < minimum or maximum is not None and number > maximum:
        raise AgentApiError("CAPTURE_FRAME_INVALID", f"{field_name} is outside its supported range.")
    return number


def nonnegative_integer(value: Any, *, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise AgentApiError("CAPTURE_FRAME_INVALID", f"{field_name} must be a non-negative integer.")
    return value


def positive_integer(value: Any, *, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise AgentApiError("CAPTURE_FRAME_INVALID", f"{field_name} must be a positive integer.")
    return value


def capture_object(value: Any, *, field_name: str, allowed: set[str]) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict) or set(value) - allowed:
        raise AgentApiError("CAPTURE_FRAME_INVALID", f"{field_name} contains an unsupported field.")
    return value


def capture_crop(value: Any) -> dict[str, int] | None:
    if value is None:
        return None
    item = capture_object(value, field_name="crop", allowed={"x", "y", "width", "height"})
    if set(item) != {"x", "y", "width", "height"}:
        raise AgentApiError("CAPTURE_FRAME_INVALID", "crop requires x, y, width, and height.")
    return {
        "x": nonnegative_integer(item["x"], field_name="crop.x"),
        "y": nonnegative_integer(item["y"], field_name="crop.y"),
        "width": positive_integer(item["width"], field_name="crop.width"),
        "height": positive_integer(item["height"], field_name="crop.height"),
    }


def capture_hex_color(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?", value):
        raise AgentApiError("CAPTURE_FRAME_INVALID", "resize.padColor must be #RRGGBB or #RRGGBBAA.")
    # ffmpeg accepts this unambiguously in a filter expression.
    return f"0x{value[1:]}"


def capture_resize(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    item = capture_object(value, field_name="resize", allowed={"width", "height", "mode", "anchor", "padColor"})
    width = item.get("width")
    height = item.get("height")
    if width is None and height is None:
        raise AgentApiError("CAPTURE_FRAME_INVALID", "resize requires width, height, or both.")
    if width is not None:
        width = positive_integer(width, field_name="resize.width")
    if height is not None:
        height = positive_integer(height, field_name="resize.height")
    mode = item.get("mode", "contain")
    if mode not in {"contain", "cover", "stretch"}:
        raise AgentApiError("CAPTURE_FRAME_INVALID", "resize.mode must be contain, cover, or stretch.")
    anchor_item = capture_object(item.get("anchor"), field_name="resize.anchor", allowed={"x", "y"})
    if anchor_item and set(anchor_item) != {"x", "y"}:
        raise AgentApiError("CAPTURE_FRAME_INVALID", "resize.anchor requires x and y.")
    anchor = {
        "x": finite_number(anchor_item.get("x", 0.5), field_name="resize.anchor.x", minimum=0, maximum=1),
        "y": finite_number(anchor_item.get("y", 0.5), field_name="resize.anchor.y", minimum=0, maximum=1),
    }
    return {
        "width": width, "height": height, "mode": mode, "anchor": anchor,
        "padColor": capture_hex_color(item.get("padColor", "#000000")),
    }


def capture_image(value: Any) -> dict[str, Any]:
    item = capture_object(value, field_name="image", allowed={"format", "quality", "compressionLevel"})
    image_format = item.get("format", "png")
    if image_format not in {"png", "jpeg", "webp"}:
        raise AgentApiError("CAPTURE_FRAME_INVALID", "image.format must be png, jpeg, or webp.")
    quality = item.get("quality")
    compression = item.get("compressionLevel")
    if quality is not None:
        quality = positive_integer(quality, field_name="image.quality")
        if quality > 100:
            raise AgentApiError("CAPTURE_FRAME_INVALID", "image.quality must be from 1 to 100.")
    if compression is not None:
        compression = nonnegative_integer(compression, field_name="image.compressionLevel")
        if compression > 9:
            raise AgentApiError("CAPTURE_FRAME_INVALID", "image.compressionLevel must be from 0 to 9.")
    if image_format == "png" and quality is not None:
        raise AgentApiError("CAPTURE_FRAME_INVALID", "image.quality is available only for jpeg and webp output.")
    if image_format != "png" and compression is not None:
        raise AgentApiError("CAPTURE_FRAME_INVALID", "image.compressionLevel is available only for png output.")
    return {
        "format": image_format,
        "quality": quality if quality is not None else (90 if image_format in {"jpeg", "webp"} else None),
        "compressionLevel": compression if compression is not None else (6 if image_format == "png" else None),
    }


def screen_capture_image(value: Any) -> dict[str, Any]:
    item = capture_object(value, field_name="image", allowed={"format", "quality"})
    image_format = item.get("format", "png")
    if image_format not in {"png", "jpeg", "webp"}:
        raise AgentApiError("SCREEN_CAPTURE_INVALID", "image.format must be png, jpeg, or webp.")
    quality = item.get("quality")
    if quality is not None:
        quality = positive_integer(quality, field_name="image.quality")
        if quality > 100:
            raise AgentApiError("SCREEN_CAPTURE_INVALID", "image.quality must be from 1 to 100.")
    if image_format == "png" and quality is not None:
        raise AgentApiError("SCREEN_CAPTURE_INVALID", "image.quality is available only for jpeg and webp output.")
    return {"format": image_format, "quality": quality if quality is not None else (90 if image_format in {"jpeg", "webp"} else None)}


def screen_capture_default_workspace_path(image_format: str, region: dict[str, int] | None = None) -> str:
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    capture_id = secrets.token_urlsafe(8)
    region_tag = "" if region is None else f"_x{region['x']}_y{region['y']}_w{region['width']}_h{region['height']}"
    return f"screenshots/screenshot_{timestamp}{region_tag}_{capture_id}.{image_format}"


def screen_capture_options(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) - {"outputPath", "image", "region"}:
        raise AgentApiError("SCREEN_CAPTURE_INVALID", "capture_screen requires only documented fields.")
    image = screen_capture_image(payload.get("image"))
    region = payload.get("region")
    if region is not None:
        if not isinstance(region, dict) or set(region) != {"x", "y", "width", "height"}:
            raise AgentApiError("SCREEN_CAPTURE_INVALID", "region requires x, y, width, and height.")
        if isinstance(region["x"], bool) or not isinstance(region["x"], int) or isinstance(region["y"], bool) or not isinstance(region["y"], int):
            raise AgentApiError("SCREEN_CAPTURE_INVALID", "region.x and region.y must be integers.")
        if isinstance(region["width"], bool) or not isinstance(region["width"], int) or region["width"] < 1 or isinstance(region["height"], bool) or not isinstance(region["height"], int) or region["height"] < 1:
            raise AgentApiError("SCREEN_CAPTURE_INVALID", "region.width and region.height must be positive integers.")
    output_path = payload.get("outputPath")
    if output_path is not None and (not isinstance(output_path, str) or not output_path):
        raise AgentApiError("SCREEN_CAPTURE_INVALID", "outputPath must be a non-empty logical workspace path.")
    path = output_path or screen_capture_default_workspace_path(image["format"], region)
    suffix = Path(path).suffix.lower()
    allowed_suffixes = {"png": {".png"}, "jpeg": {".jpg", ".jpeg"}, "webp": {".webp"}}
    if suffix not in allowed_suffixes[image["format"]]:
        raise AgentApiError("SCREEN_CAPTURE_INVALID", f"outputPath extension must match image.format {image['format']}.")
    return {"image": image, "outputPath": path, "region": region}


def screen_capture_region(options: dict[str, Any], virtual_desktop: dict[str, int]) -> dict[str, int]:
    """Resolve an optional global desktop rectangle and reject out-of-bounds input."""
    region = options["region"]
    if region is None:
        return {"x": virtual_desktop["left"], "y": virtual_desktop["top"], "width": virtual_desktop["width"], "height": virtual_desktop["height"]}
    left, top = virtual_desktop["left"], virtual_desktop["top"]
    right, bottom = left + virtual_desktop["width"], top + virtual_desktop["height"]
    if region["x"] < left or region["y"] < top or region["x"] + region["width"] > right or region["y"] + region["height"] > bottom:
        raise AgentApiError("SCREEN_CAPTURE_INVALID", "region must lie completely inside the current virtual desktop.")
    return dict(region)


def capture_default_workspace_path(source_path: str, timestamp_seconds: float, image_format: str) -> str:
    """Name an automatically created capture as a normal workspace artifact.

    Use the source filename's human-readable title and stable yt ID when
    available.  The download task ID is intentionally not propagated: it
    identifies one download operation, whereas a capture needs to identify
    the video it depicts.  Its own random capture ID prevents collisions.
    """
    source_stem = Path(source_path).stem.strip()
    match = re.search(r"\s+\[yt_([A-Za-z0-9_-]+)\]", source_stem)
    partial_match = re.search(r"\s+\[(partial_\d+(?:\.\d+)?_\d+(?:\.\d+)?)\]", source_stem)
    title = source_stem[:match.start()].strip() if match else source_stem
    title = title or "ResearchTube frame"
    video_part = f" [yt_{match.group(1)}]" if match else ""
    partial_part = f" [{partial_match.group(1)}]" if partial_match else ""
    timestamp_part = f"{timestamp_seconds:.3f}".replace("-", "_")
    # Six bytes encode to a compact, fixed eight-character URL-safe ID.
    capture_id = secrets.token_urlsafe(6)
    return f"captures/{title}{video_part}{partial_part} [t_{timestamp_part}] [cap_{capture_id}].{image_format}"


def capture_output_path(value: Any, source_path: str, timestamp_seconds: float, image_format: str) -> dict[str, Any]:
    if value is not None and (not isinstance(value, str) or not value):
        raise AgentApiError("CAPTURE_FRAME_INVALID", "outputPath must be a non-empty logical workspace path.")
    return {
        "path": value or capture_default_workspace_path(source_path, timestamp_seconds, image_format),
        "provided": value is not None,
    }


def capture_frame_options(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) - {"path", "youtube", "timestampSeconds", "videoStreamIndex", "seekMode", "applyDisplayRotation", "crop", "resize", "image", "outputPath"}:
        raise AgentApiError("CAPTURE_FRAME_INVALID", "capture_frame requires only documented fields.")
    path = payload.get("path")
    youtube_value = payload.get("youtube")
    if (path is None) == (youtube_value is None):
        raise AgentApiError("CAPTURE_FRAME_INVALID", "capture_frame requires exactly one source: path or youtube.")
    youtube: dict[str, str] | None = None
    if youtube_value is not None:
        youtube_item = capture_object(youtube_value, field_name="youtube", allowed={"videoId", "formatId"})
        if set(youtube_item) != {"videoId", "formatId"}:
            raise AgentApiError("CAPTURE_FRAME_INVALID", "youtube requires videoId and formatId.")
        youtube = {
            "videoId": validate_video_id(youtube_item["videoId"]),
            "formatId": parse_format_selection({"video": youtube_item["formatId"]}).video or "",
        }
        if not re.fullmatch(r"[0-9]+", youtube["formatId"]):
            raise AgentApiError("CAPTURE_FRAME_INVALID", "youtube.formatId must be a numeric ID returned by youtube_download_get_formats.")
    timestamp = finite_number(payload.get("timestampSeconds"), field_name="timestampSeconds", minimum=0)
    stream_index = payload.get("videoStreamIndex")
    if stream_index is not None:
        stream_index = nonnegative_integer(stream_index, field_name="videoStreamIndex")
    seek_mode = payload.get("seekMode", "accurate")
    if seek_mode not in {"accurate", "fast"}:
        raise AgentApiError("CAPTURE_FRAME_INVALID", "seekMode must be accurate or fast.")
    rotation = payload.get("applyDisplayRotation", True)
    if not isinstance(rotation, bool):
        raise AgentApiError("CAPTURE_FRAME_INVALID", "applyDisplayRotation must be a boolean.")
    image = capture_image(payload.get("image"))
    return {
        "path": path, "youtube": youtube, "timestampSeconds": timestamp, "videoStreamIndex": stream_index, "seekMode": seek_mode,
        "applyDisplayRotation": rotation, "crop": capture_crop(payload.get("crop")), "resize": capture_resize(payload.get("resize")),
        "image": image, "outputPath": capture_output_path(payload.get("outputPath"), path if isinstance(path, str) else "", timestamp, image["format"]),
    }


def capture_frames_options(payload: Any) -> dict[str, Any]:
    allowed = {"path", "youtube", "timestampsSeconds", "videoStreamIndex", "seekMode", "applyDisplayRotation", "crop", "resize", "image"}
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise AgentApiError("CAPTURE_FRAME_INVALID", "media_capture_frame requires only documented fields.")
    path, youtube_value = payload.get("path"), payload.get("youtube")
    if (path is None) == (youtube_value is None):
        raise AgentApiError("CAPTURE_FRAME_INVALID", "media_capture_frame requires exactly one source: path or youtube.")
    timestamps_value = payload.get("timestampsSeconds")
    if not isinstance(timestamps_value, list) or not 1 <= len(timestamps_value) <= CAPTURE_FRAME_MAX_FRAMES:
        raise AgentApiError("CAPTURE_FRAME_INVALID", f"timestampsSeconds must contain from 1 to {CAPTURE_FRAME_MAX_FRAMES} timestamps.")
    timestamps = [finite_number(value, field_name="timestampsSeconds", minimum=0) for value in timestamps_value]
    if len(set(timestamps)) != len(timestamps):
        raise AgentApiError("CAPTURE_FRAME_INVALID", "timestampsSeconds must not contain duplicates.")
    single_payload = {key: value for key, value in payload.items() if key != "timestampsSeconds"}
    first = capture_frame_options({**single_payload, "timestampSeconds": timestamps[0]})
    return {**first, "timestampsSeconds": sorted(timestamps)}


def image_crop_default_workspace_path(source_path: str, crop: dict[str, int], image_format: str) -> str:
    source_stem = Path(source_path).stem.strip() or "ResearchTube image"
    # Leave enough room for the crop provenance and unique ID under the
    # portable 240-character workspace path-component limit.
    source_stem = source_stem[:150].rstrip() or "ResearchTube image"
    crop_tag = f"crop_{crop['x']}_{crop['y']}_{crop['width']}_{crop['height']}"
    return f"crops/{source_stem} [{crop_tag}] [img_{secrets.token_urlsafe(8)}].{image_format}"


def image_crop_options(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) - {"path", "crop", "image", "outputPath"}:
        raise AgentApiError("IMAGE_CROP_INVALID", "image_crop requires only documented fields.")
    path = payload.get("path")
    if not isinstance(path, str) or not path:
        raise AgentApiError("IMAGE_CROP_INVALID", "path must be a non-empty logical workspace image path.")
    crop = capture_crop(payload.get("crop"))
    if crop is None:
        raise AgentApiError("IMAGE_CROP_INVALID", "crop requires x, y, width, and height.")
    try:
        image = capture_image(payload.get("image"))
    except AgentApiError as error:
        raise AgentApiError("IMAGE_CROP_INVALID", error.message) from error
    output_path = payload.get("outputPath")
    if output_path is not None and (not isinstance(output_path, str) or not output_path):
        raise AgentApiError("IMAGE_CROP_INVALID", "outputPath must be a non-empty logical workspace path.")
    path = output_path or image_crop_default_workspace_path(path, crop, image["format"])
    suffix = Path(path).suffix.lower()
    allowed_suffixes = {"png": {".png"}, "jpeg": {".jpg", ".jpeg"}, "webp": {".webp"}}
    if suffix not in allowed_suffixes[image["format"]]:
        raise AgentApiError("IMAGE_CROP_INVALID", f"outputPath extension must match image.format {image['format']}.")
    return {"path": payload["path"], "crop": crop, "image": image, "outputPath": path}


def visual_map_options(payload: Any) -> dict[str, Any]:
    allowed = {"workspacePath", "columns", "rows", "maxTotalFrames", "selection", "sceneDetectThreshold", "startSeconds", "endSeconds", "maxMapDimension", "frameTimestampPosition"}
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise AgentApiError("VISUAL_MAP_INVALID", "visual_map_create requires only documented fields.")
    path = payload.get("workspacePath")
    if not isinstance(path, str) or not path:
        raise AgentApiError("VISUAL_MAP_INVALID", "workspacePath must be a non-empty logical workspace video path.")
    columns = nonnegative_integer(payload.get("columns"), field_name="columns")
    rows = nonnegative_integer(payload.get("rows"), field_name="rows")
    max_total_frames = nonnegative_integer(payload.get("maxTotalFrames"), field_name="maxTotalFrames")
    if columns < 1 or rows < 1 or max_total_frames < 1:
        raise AgentApiError("VISUAL_MAP_INVALID", "columns, rows, and maxTotalFrames must be positive integers.")
    if columns > VISUAL_MAP_MAX_GRID_SIDE or rows > VISUAL_MAP_MAX_GRID_SIDE or columns * rows > VISUAL_MAP_MAX_CELLS:
        raise AgentApiError("VISUAL_MAP_INVALID", "The visual-map grid is too large.")
    if max_total_frames > VISUAL_MAP_MAX_TOTAL_FRAMES:
        raise AgentApiError("VISUAL_MAP_INVALID", f"maxTotalFrames must not exceed {VISUAL_MAP_MAX_TOTAL_FRAMES}.")
    selection = payload.get("selection", "uniform")
    if selection not in {"uniform", "sceneDetect", "hybrid"}:
        raise AgentApiError("VISUAL_MAP_INVALID", "selection must be uniform, sceneDetect, or hybrid.")
    threshold = payload.get("sceneDetectThreshold", DEFAULT_VISUAL_MAP_SCENE_DETECT_THRESHOLD)
    if not isinstance(threshold, (int, float)) or isinstance(threshold, bool) or not math.isfinite(threshold) or threshold < 0 or threshold > 100:
        raise AgentApiError("VISUAL_MAP_INVALID", "sceneDetectThreshold must be a finite number from 0 to 100.")
    if selection not in {"sceneDetect", "hybrid"} and "sceneDetectThreshold" in payload:
        raise AgentApiError("VISUAL_MAP_INVALID", "sceneDetectThreshold is available only when selection is sceneDetect or hybrid.")
    start, end = payload.get("startSeconds", 0), payload.get("endSeconds")
    if not isinstance(start, (int, float)) or isinstance(start, bool) or not math.isfinite(start) or start < 0:
        raise AgentApiError("VISUAL_MAP_INVALID", "startSeconds must be a finite number greater than or equal to zero.")
    if end is not None and (not isinstance(end, (int, float)) or isinstance(end, bool) or not math.isfinite(end)):
        raise AgentApiError("VISUAL_MAP_INVALID", "endSeconds must be a finite number.")
    maximum = payload.get("maxMapDimension", DEFAULT_VISUAL_MAP_MAX_DIMENSION)
    if not isinstance(maximum, int) or isinstance(maximum, bool) or maximum < 1:
        raise AgentApiError("VISUAL_MAP_INVALID", "maxMapDimension must be a positive integer.")
    timestamp_position = payload.get("frameTimestampPosition", "bottomRight")
    if timestamp_position not in {"none", "topLeft", "topRight", "bottomLeft", "bottomRight"}:
        raise AgentApiError("VISUAL_MAP_INVALID", "frameTimestampPosition is invalid.")
    return {"workspacePath": path, "columns": columns, "rows": rows, "maxTotalFrames": max_total_frames, "selection": selection, "sceneDetectThreshold": float(threshold) if selection in {"sceneDetect", "hybrid"} else None, "startSeconds": float(start), "endSeconds": None if end is None else float(end), "maxMapDimension": maximum, "frameTimestampPosition": timestamp_position}


def uniform_visual_map_timestamps(start: float, end: float, count: int) -> list[float]:
    if count == 1:
        return [start]
    step = (end - start) / (count - 1)
    return [start + index * step for index in range(count - 1)] + [end]


@dataclass(frozen=True)
class VisualMapSceneCandidate:
    timestamp_seconds: float
    delta: float


def visual_map_scene_candidates(metadata: bytes, start: float, end: float) -> list[VisualMapSceneCandidate]:
    """Parse native scdet metadata without exposing FFmpeg process output."""
    candidates: list[VisualMapSceneCandidate] = []
    timestamp: float | None = None
    score: float | None = None

    def append_candidate() -> None:
        nonlocal timestamp, score
        if timestamp is not None and score is not None and start <= timestamp <= end:
            candidates.append(VisualMapSceneCandidate(timestamp, score))
        timestamp, score = None, None

    for raw_line in metadata.decode("utf-8", "replace").splitlines():
        if raw_line.startswith("frame:"):
            append_candidate()
            continue
        time_match = re.fullmatch(r"lavfi\.scd\.time=([-+]?\d+(?:\.\d+)?)", raw_line.strip())
        if time_match:
            try:
                value = float(time_match.group(1))
            except ValueError:
                timestamp = None
            else:
                timestamp = value if math.isfinite(value) else None
            continue
        score_match = re.fullmatch(r"lavfi\.scd\.score=([-+]?\d+(?:\.\d+)?)", raw_line.strip())
        if score_match:
            try:
                value = float(score_match.group(1))
            except ValueError:
                continue
            score = value if math.isfinite(value) and value > 0 else None
    append_candidate()
    return candidates


def select_visual_map_scene_candidates(candidates: list[VisualMapSceneCandidate], maximum: int) -> list[VisualMapSceneCandidate]:
    """Keep the strongest scene changes at least two seconds apart, then order them chronologically."""
    strongest_first = sorted(candidates, key=lambda candidate: (-candidate.delta, candidate.timestamp_seconds))
    spaced: list[VisualMapSceneCandidate] = []
    for candidate in strongest_first:
        if all(abs(candidate.timestamp_seconds - kept.timestamp_seconds) >= VISUAL_MAP_SCENE_MIN_DISTANCE_SECONDS for kept in spaced):
            spaced.append(candidate)
    return sorted(spaced[:maximum], key=lambda candidate: candidate.timestamp_seconds)


def hybrid_visual_map_timestamps(candidates: list[VisualMapSceneCandidate], start: float, end: float, count: int) -> list[float]:
    """Pick one strongest detected scene per equal interval, or its midpoint if empty."""
    interval = (end - start) / count
    timestamps: list[float] = []
    for index in range(count):
        left = start + interval * index
        right = end if index == count - 1 else start + interval * (index + 1)
        in_interval = [candidate for candidate in candidates if left <= candidate.timestamp_seconds and (candidate.timestamp_seconds < right or index == count - 1)]
        if in_interval:
            strongest = min(in_interval, key=lambda candidate: (-candidate.delta, candidate.timestamp_seconds))
            timestamps.append(strongest.timestamp_seconds)
        else:
            timestamps.append((left + right) / 2)
    return sorted(timestamps)


def visual_map_timestamp_label(value: float) -> str:
    seconds = max(0, int(round(value)))
    if seconds < 60:
        return f"0:{seconds:02d}"
    minutes, remainder = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}:{remainder:02d}"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}:{minutes:02d}:{remainder:02d}"


def visual_map_thumbnail_size(width: int, height: int, columns: int, rows: int, maximum: int) -> tuple[int, int]:
    scale = min(1.0, maximum / (width * columns), maximum / (height * rows))
    return max(1, int(width * scale)), max(1, int(height * scale))


def visual_map_default_path(source_path: str, map_number: int, map_id: str) -> str:
    stem = safe_capture_title(Path(source_path).stem)[:180].rstrip() or "Visual map"
    return f"visual-maps/{stem} [vismap_{map_id}_{map_number:03d}].png"


def video_frame_rate(stream: dict[str, Any]) -> float | None:
    """Read ffprobe's rational rate when it is usable for endpoint sampling."""
    for name in ("avg_frame_rate", "r_frame_rate"):
        value = stream.get(name)
        if not isinstance(value, str) or "/" not in value:
            continue
        try:
            numerator, denominator = value.split("/", 1)
            rate = float(numerator) / float(denominator)
        except (TypeError, ValueError, ZeroDivisionError):
            continue
        if math.isfinite(rate) and rate > 0:
            return rate
    return None


def visual_map_extract_timestamp(requested: float, video_duration: float, frame_rate: float | None) -> float:
    """Keep an endpoint request within the range where a decoded video frame exists."""
    frame_interval = 1.0 / frame_rate if frame_rate else min(1.0, video_duration / 2)
    # stream.duration is normally the end immediately after the final frame.
    # Leave a small fraction of a frame as well: decimal rounding in ffprobe
    # can otherwise make select=gte(t, ...) miss that final frame by <1 μs.
    final_sample = max(0.0, video_duration - frame_interval * 1.01)
    return min(requested, final_sample)


async def ffprobe_streams_for_file(physical_path: Path, executable: str) -> list[dict[str, Any]]:
    command = [executable, "-v", "error", "-show_streams", "-of", "json", str(physical_path)]
    try:
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, _stderr = await asyncio.wait_for(process.communicate(), timeout=MEDIA_PROBE_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as error:
        process.kill()
        await process.communicate()
        raise AgentApiError("CAPTURE_FRAME_FAILED", "ffprobe timed out while reading video streams.") from error
    except OSError as error:
        raise AgentApiError("CAPTURE_FRAME_FAILED", "ffprobe could not be started.") from error
    if process.returncode != 0:
        raise AgentApiError("CAPTURE_FRAME_FAILED", "ffprobe could not inspect video streams.")
    try:
        result = json.loads(stdout.decode("utf-8"))
        streams = result.get("streams")
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError) as error:
        raise AgentApiError("CAPTURE_FRAME_FAILED", "ffprobe returned invalid video stream metadata.") from error
    if not isinstance(streams, list):
        raise AgentApiError("CAPTURE_FRAME_FAILED", "ffprobe returned invalid video stream metadata.")
    return [stream for stream in streams if isinstance(stream, dict)]


async def ffprobe_streams(item: ResolvedWorkspacePath, executable: str) -> list[dict[str, Any]]:
    return await ffprobe_streams_for_file(item.physical_path, executable)


def video_stream_rotation(stream: dict[str, Any]) -> float:
    candidates: list[Any] = [stream.get("tags", {}).get("rotate") if isinstance(stream.get("tags"), dict) else None]
    side_data = stream.get("side_data_list")
    if isinstance(side_data, list):
        candidates.extend(item.get("rotation") for item in side_data if isinstance(item, dict))
    for value in candidates:
        try:
            rotation = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(rotation):
            normalized = rotation % 360
            return 0.0 if math.isclose(normalized, 0.0, abs_tol=0.001) else normalized
    return 0.0


def capture_filter(options: dict[str, Any]) -> str:
    filters: list[str] = []
    if options["seekMode"] == "accurate":
        # Unlike output-side -ss, select gives us both a deterministic frame
        # (the first decoded PTS at or after the request) and a truthful PTS
        # in the following showinfo filter.
        filters.append(f"select=gte(t\\,{options['timestampSeconds']:.9f})")
    crop = options["crop"]
    if crop is not None:
        filters.append(f"crop={crop['width']}:{crop['height']}:{crop['x']}:{crop['y']}")
    resize = options["resize"]
    if resize is not None:
        width, height = resize["width"], resize["height"]
        if width is None:
            filters.append(f"scale=-2:{height}")
        elif height is None:
            filters.append(f"scale={width}:-2")
        elif resize["mode"] == "stretch":
            filters.append(f"scale={width}:{height}")
        elif resize["mode"] == "contain":
            x, y = resize["anchor"]["x"], resize["anchor"]["y"]
            filters.extend([
                f"scale={width}:{height}:force_original_aspect_ratio=decrease",
                f"pad={width}:{height}:(ow-iw)*{x:.8f}:(oh-ih)*{y:.8f}:color={resize['padColor']}",
            ])
        else:
            x, y = resize["anchor"]["x"], resize["anchor"]["y"]
            filters.extend([
                f"scale={width}:{height}:force_original_aspect_ratio=increase",
                f"crop={width}:{height}:(iw-ow)*{x:.8f}:(ih-oh)*{y:.8f}",
            ])
    # showinfo reports the decoded frame PTS to stderr, without adding any pixels.
    filters.append("showinfo")
    return ",".join(filters)


def capture_encoder_arguments(image: dict[str, Any]) -> tuple[list[str], str]:
    image_format = image["format"]
    if image_format == "png":
        return ["-c:v", "png", "-compression_level", str(image["compressionLevel"])], "image/png"
    if image_format == "jpeg":
        # ffmpeg's mjpeg qscale is inverse: 2 is highest quality and 31 lowest.
        qscale = round(31 - ((image["quality"] - 1) * 29 / 99))
        return ["-c:v", "mjpeg", "-q:v", str(max(2, min(31, qscale)))], "image/jpeg"
    return ["-c:v", "libwebp", "-q:v", str(image["quality"])], "image/webp"


def macos_virtual_desktop() -> tuple[list[dict[str, int]], dict[str, int]]:
    """Return active macOS displays and the CoreGraphics virtual-desktop bounds."""
    if platform.system() != "Darwin":
        raise AgentApiError("SCREEN_CAPTURE_UNAVAILABLE", "capture_screen is unavailable on this operating system.")
    class CGPoint(ctypes.Structure):
        _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]
    class CGSize(ctypes.Structure):
        _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]
    class CGRect(ctypes.Structure):
        _fields_ = [("origin", CGPoint), ("size", CGSize)]
    try:
        core_graphics = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        active = (ctypes.c_uint32 * 32)()
        count = ctypes.c_uint32()
        core_graphics.CGGetActiveDisplayList.argtypes = [ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_uint32)]
        core_graphics.CGGetActiveDisplayList.restype = ctypes.c_int32
        core_graphics.CGDisplayBounds.argtypes = [ctypes.c_uint32]
        core_graphics.CGDisplayBounds.restype = CGRect
        if core_graphics.CGGetActiveDisplayList(32, active, ctypes.byref(count)) != 0 or count.value < 1:
            raise OSError("no active displays")
        displays = []
        for index in range(count.value):
            bounds = core_graphics.CGDisplayBounds(active[index])
            displays.append({"index": index, "left": round(bounds.origin.x), "top": round(bounds.origin.y), "width": round(bounds.size.width), "height": round(bounds.size.height)})
    except (AttributeError, OSError) as error:
        raise AgentApiError("SCREEN_CAPTURE_UNAVAILABLE", "macOS could not read the virtual desktop geometry.") from error
    left = min(item["left"] for item in displays)
    top = min(item["top"] for item in displays)
    right = max(item["left"] + item["width"] for item in displays)
    bottom = max(item["top"] + item["height"] for item in displays)
    if right <= left or bottom <= top:
        raise AgentApiError("SCREEN_CAPTURE_UNAVAILABLE", "macOS reported no usable virtual desktop.")
    return displays, {"left": left, "top": top, "width": right - left, "height": bottom - top}


async def capture_screen_macos(payload: Any) -> dict[str, Any]:
    """Capture macOS active displays solely with FFmpeg avfoundation and xstack."""
    options = screen_capture_options(payload)
    displays, virtual_desktop = macos_virtual_desktop()
    region = screen_capture_region(options, virtual_desktop)
    ffmpeg = find_component("ffmpeg", COMPONENTS["ffmpeg"][0])
    ffprobe = find_component("ffprobe", COMPONENTS["ffprobe"][0])
    if ffmpeg.error or ffprobe.error:
        raise AgentApiError("FFMPEG_DISCOVERY_ERROR", "ffmpeg or ffprobe discovery is ambiguous.", ffmpeg.error or ffprobe.error)
    if not ffmpeg.executable or not ffprobe.executable:
        raise AgentApiError("FFMPEG_NOT_AVAILABLE", "ffmpeg and ffprobe are required for macOS screen capture. Extract them under tools/ffmpeg or install them on PATH.")
    resolver = WorkspacePathResolver()
    destination_path: Path | None = None
    try:
        destination = resolver.resolve_destination(options["outputPath"], field_name="outputPath", error_code="WORKSPACE_PATH_INVALID")
        destination.physical_path.parent.mkdir(parents=True, exist_ok=True)
        destination = resolver.resolve_destination(destination.logical_path, field_name="outputPath", error_code="WORKSPACE_PATH_INVALID")
        if destination.physical_path.exists() or destination.physical_path.is_symlink():
            raise AgentApiError("SCREEN_CAPTURE_DESTINATION_EXISTS", "outputPath already exists; capture_screen never overwrites a workspace file.")
        destination_path = destination.physical_path
        command = [ffmpeg.executable, "-hide_banner", "-nostdin", "-v", "error"]
        for display in displays:
            command.extend(["-f", "avfoundation", "-framerate", "1", "-i", f"Capture screen {display['index']}:none"])
        filters = []
        labels = []
        for display in displays:
            label = f"d{display['index']}"
            filters.append(f"[{display['index']}:v]scale={display['width']}:{display['height']}[{label}]")
            labels.append(f"[{label}]")
        layout = "|".join(f"{display['left'] - virtual_desktop['left']}_{display['top'] - virtual_desktop['top']}" for display in displays)
        filters.append(f"{''.join(labels)}xstack=inputs={len(displays)}:layout={layout}:fill=black[out]")
        output_label = "out"
        if options["region"] is not None:
            filters.append(f"[out]crop={region['width']}:{region['height']}:{region['x'] - virtual_desktop['left']}:{region['y'] - virtual_desktop['top']}[region]")
            output_label = "region"
        encoder_args, mime_type = capture_encoder_arguments({**options["image"], "compressionLevel": 6 if options["image"]["format"] == "png" else None})
        command.extend(["-filter_complex", ";".join(filters), "-map", f"[{output_label}]", "-frames:v", "1", *encoder_args, "-y", str(destination_path)])
        try:
            process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            await asyncio.wait_for(process.communicate(), timeout=CAPTURE_FRAME_TIMEOUT_SECONDS)
        except asyncio.TimeoutError as error:
            process.kill()
            await process.communicate()
            raise AgentApiError("SCREEN_CAPTURE_FAILED", "FFmpeg timed out while capturing the macOS virtual desktop.") from error
        except OSError as error:
            raise AgentApiError("SCREEN_CAPTURE_UNAVAILABLE", "FFmpeg could not start macOS desktop capture.") from error
        if process.returncode != 0 or not destination_path.is_file():
            raise AgentApiError("SCREEN_CAPTURE_FAILED", "FFmpeg could not capture the macOS virtual desktop. Its build must support avfoundation and macOS screen recording must be permitted.")
        output_streams = await ffprobe_streams_for_file(destination_path, ffprobe.executable)
        stream = next((item for item in output_streams if item.get("codec_type") == "video"), None)
        width = stream.get("width") if isinstance(stream, dict) else None
        height = stream.get("height") if isinstance(stream, dict) else None
        if width != region["width"] or height != region["height"]:
            raise AgentApiError("SCREEN_CAPTURE_FAILED", "FFmpeg did not produce the requested macOS screen-capture dimensions.")
        result = {"workspacePath": destination.logical_path, "format": options["image"]["format"], "mimeType": mime_type, "width": width, "height": height, "imageSizeBytes": destination_path.stat().st_size, "monitorCount": len(displays), "virtualDesktop": virtual_desktop, "region": region}
        log(f"capture_screen monitors={len(displays)} {width}x{height} -> {destination.logical_path}")
        return result
    except AgentApiError:
        if destination_path is not None:
            try:
                destination_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise


async def x11_virtual_desktop() -> tuple[dict[str, int], int]:
    """Read X11 root-display geometry and monitor count without capturing pixels."""
    if not os.environ.get("DISPLAY") or os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
        raise AgentApiError("SCREEN_CAPTURE_UNAVAILABLE", "capture_screen on Linux requires an X11 DISPLAY. Wayland capture is not implemented.")
    xrandr = shutil.which("xrandr")
    if not xrandr:
        raise AgentApiError("SCREEN_CAPTURE_UNAVAILABLE", "Linux/X11 screen capture requires xrandr to report the virtual desktop and monitor count.")
    try:
        process = await asyncio.create_subprocess_exec(xrandr, "--query", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, _stderr = await asyncio.wait_for(process.communicate(), timeout=MEDIA_PROBE_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as error:
        process.kill()
        await process.communicate()
        raise AgentApiError("SCREEN_CAPTURE_UNAVAILABLE", "xrandr timed out while reading the X11 virtual desktop.") from error
    except OSError as error:
        raise AgentApiError("SCREEN_CAPTURE_UNAVAILABLE", "xrandr could not start for Linux/X11 screen capture.") from error
    if process.returncode != 0:
        raise AgentApiError("SCREEN_CAPTURE_UNAVAILABLE", "xrandr could not read the X11 virtual desktop.")
    try:
        text = stdout.decode("utf-8", "replace")
        match = re.search(r"^Screen\s+\d+:.*?\bcurrent\s+(\d+)\s+x\s+(\d+)\b", text, re.MULTILINE)
        monitor_count = len(re.findall(r"^\S+\s+connected(?:\s|$)", text, re.MULTILINE))
        if match is None:
            raise ValueError("missing X11 screen geometry")
        width, height = int(match.group(1)), int(match.group(2))
    except (AttributeError, ValueError) as error:
        raise AgentApiError("SCREEN_CAPTURE_UNAVAILABLE", "xrandr returned invalid X11 virtual-desktop geometry.") from error
    if width < 1 or height < 1 or monitor_count < 1:
        raise AgentApiError("SCREEN_CAPTURE_UNAVAILABLE", "xrandr reported no usable X11 virtual desktop.")
    # X11's root-window coordinates begin at 0,0; monitor layouts are within it.
    return {"left": 0, "top": 0, "width": width, "height": height}, monitor_count


async def capture_screen_x11(payload: Any) -> dict[str, Any]:
    """Capture exactly one Linux/X11 virtual-desktop image through FFmpeg x11grab."""
    options = screen_capture_options(payload)
    virtual_desktop, monitor_count = await x11_virtual_desktop()
    region = screen_capture_region(options, virtual_desktop)
    ffmpeg = find_component("ffmpeg", COMPONENTS["ffmpeg"][0])
    ffprobe = find_component("ffprobe", COMPONENTS["ffprobe"][0])
    if ffmpeg.error:
        raise AgentApiError("FFMPEG_DISCOVERY_ERROR", "ffmpeg discovery is ambiguous.", ffmpeg.error)
    if ffprobe.error:
        raise AgentApiError("FFPROBE_DISCOVERY_ERROR", "ffprobe discovery is ambiguous.", ffprobe.error)
    if not ffmpeg.executable:
        raise AgentApiError("FFMPEG_NOT_AVAILABLE", "ffmpeg is required for Linux/X11 screen capture. Extract it under tools/ffmpeg or install it on PATH.")
    if not ffprobe.executable:
        raise AgentApiError("FFPROBE_NOT_AVAILABLE", "ffprobe is required to verify Linux/X11 screen capture dimensions. Extract it under tools/ffmpeg or install it on PATH.")
    resolver = WorkspacePathResolver()
    destination_path: Path | None = None
    try:
        destination = resolver.resolve_destination(options["outputPath"], field_name="outputPath", error_code="WORKSPACE_PATH_INVALID")
        destination.physical_path.parent.mkdir(parents=True, exist_ok=True)
        destination = resolver.resolve_destination(destination.logical_path, field_name="outputPath", error_code="WORKSPACE_PATH_INVALID")
        if destination.physical_path.exists() or destination.physical_path.is_symlink():
            raise AgentApiError("SCREEN_CAPTURE_DESTINATION_EXISTS", "outputPath already exists; capture_screen never overwrites a workspace file.")
        destination_path = destination.physical_path
        encoder_args, mime_type = capture_encoder_arguments({**options["image"], "compressionLevel": 6 if options["image"]["format"] == "png" else None})
        command = [
            ffmpeg.executable, "-hide_banner", "-nostdin", "-v", "error", "-f", "x11grab", "-framerate", "1",
            "-video_size", f"{region['width']}x{region['height']}", "-i", f"{os.environ['DISPLAY']}+{region['x']},{region['y']}",
            "-map", "0:v:0", "-an", "-frames:v", "1", *encoder_args, "-y", str(destination_path),
        ]
        try:
            process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            await asyncio.wait_for(process.communicate(), timeout=CAPTURE_FRAME_TIMEOUT_SECONDS)
        except asyncio.TimeoutError as error:
            process.kill()
            await process.communicate()
            raise AgentApiError("SCREEN_CAPTURE_FAILED", "FFmpeg timed out while capturing the Linux/X11 virtual desktop.") from error
        except OSError as error:
            raise AgentApiError("SCREEN_CAPTURE_UNAVAILABLE", "FFmpeg could not start Linux/X11 desktop capture.") from error
        if process.returncode != 0 or not destination_path.is_file():
            raise AgentApiError("SCREEN_CAPTURE_FAILED", "FFmpeg could not capture the Linux/X11 virtual desktop. Its build must support x11grab.")
        output_streams = await ffprobe_streams_for_file(destination_path, ffprobe.executable)
        output_stream = next((stream for stream in output_streams if stream.get("codec_type") == "video"), None)
        width = output_stream.get("width") if isinstance(output_stream, dict) else None
        height = output_stream.get("height") if isinstance(output_stream, dict) else None
        if width != region["width"] or height != region["height"]:
            raise AgentApiError("SCREEN_CAPTURE_FAILED", "FFmpeg did not produce the requested Linux/X11 screen-capture dimensions.")
        result = {"workspacePath": destination.logical_path, "format": options["image"]["format"], "mimeType": mime_type, "width": width, "height": height, "imageSizeBytes": destination_path.stat().st_size, "monitorCount": monitor_count, "virtualDesktop": virtual_desktop, "region": region}
        log(f"capture_screen monitors={monitor_count} {width}x{height} -> {destination.logical_path}")
        return result
    except AgentApiError:
        if destination_path is not None:
            try:
                destination_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise


def windows_virtual_desktop() -> tuple[dict[str, int], int]:
    """Return the real Windows virtual-desktop rectangle and monitor count.

    This does not capture any pixels. FFmpeg's gdigrab remains the only
    Windows capture implementation; the small WinAPI query merely preserves
    truthful geometry and monitor-count metadata in the MCP result.
    """
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        # Avoid DPI-scaled virtual-screen metrics in a high-DPI process. It is
        # harmless when awareness was already set by the host application.
        try:
            user32.SetProcessDPIAware()
        except AttributeError:
            pass
        get_system_metrics = user32.GetSystemMetrics
        get_system_metrics.argtypes = [ctypes.c_int]
        get_system_metrics.restype = ctypes.c_int
        bounds = {
            "left": get_system_metrics(76), "top": get_system_metrics(77),
            "width": get_system_metrics(78), "height": get_system_metrics(79),
        }
        monitor_count = get_system_metrics(80)
    except (AttributeError, OSError) as error:
        raise AgentApiError("SCREEN_CAPTURE_UNAVAILABLE", "Windows could not read the virtual desktop geometry.") from error
    if bounds["width"] < 1 or bounds["height"] < 1 or monitor_count < 1:
        raise AgentApiError("SCREEN_CAPTURE_UNAVAILABLE", "Windows reported no usable virtual desktop.")
    return bounds, monitor_count


async def capture_screen_windows(payload: Any) -> dict[str, Any]:
    """Capture exactly one Windows virtual-desktop image through FFmpeg gdigrab."""
    options = screen_capture_options(payload)
    virtual_desktop, monitor_count = windows_virtual_desktop()
    region = screen_capture_region(options, virtual_desktop)
    ffmpeg = find_component("ffmpeg", COMPONENTS["ffmpeg"][0])
    ffprobe = find_component("ffprobe", COMPONENTS["ffprobe"][0])
    if ffmpeg.error:
        raise AgentApiError("FFMPEG_DISCOVERY_ERROR", "ffmpeg discovery is ambiguous.", ffmpeg.error)
    if ffprobe.error:
        raise AgentApiError("FFPROBE_DISCOVERY_ERROR", "ffprobe discovery is ambiguous.", ffprobe.error)
    if not ffmpeg.executable:
        raise AgentApiError("FFMPEG_NOT_AVAILABLE", "ffmpeg is required for Windows screen capture. Extract it under tools/ffmpeg or install it on PATH.")
    if not ffprobe.executable:
        raise AgentApiError("FFPROBE_NOT_AVAILABLE", "ffprobe is required to verify Windows screen capture dimensions. Extract it under tools/ffmpeg or install it on PATH.")
    resolver = WorkspacePathResolver()
    destination_path: Path | None = None
    try:
        destination = resolver.resolve_destination(options["outputPath"], field_name="outputPath", error_code="WORKSPACE_PATH_INVALID")
        destination.physical_path.parent.mkdir(parents=True, exist_ok=True)
        destination = resolver.resolve_destination(destination.logical_path, field_name="outputPath", error_code="WORKSPACE_PATH_INVALID")
        if destination.physical_path.exists() or destination.physical_path.is_symlink():
            raise AgentApiError("SCREEN_CAPTURE_DESTINATION_EXISTS", "outputPath already exists; capture_screen never overwrites a workspace file.")
        destination_path = destination.physical_path
        encoder_args, mime_type = capture_encoder_arguments({**options["image"], "compressionLevel": 6 if options["image"]["format"] == "png" else None})
        command = [
            ffmpeg.executable, "-hide_banner", "-nostdin", "-v", "error",
            "-f", "gdigrab", "-offset_x", str(region["x"]), "-offset_y", str(region["y"]),
            "-video_size", f"{region['width']}x{region['height']}", "-framerate", "1", "-i", "desktop",
            "-map", "0:v:0", "-an", "-frames:v", "1", *encoder_args, "-y", str(destination_path),
        ]
        try:
            process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            await asyncio.wait_for(process.communicate(), timeout=CAPTURE_FRAME_TIMEOUT_SECONDS)
        except asyncio.TimeoutError as error:
            process.kill()
            await process.communicate()
            raise AgentApiError("SCREEN_CAPTURE_FAILED", "FFmpeg timed out while capturing the Windows virtual desktop.") from error
        except OSError as error:
            raise AgentApiError("SCREEN_CAPTURE_UNAVAILABLE", "FFmpeg could not start Windows desktop capture.") from error
        if process.returncode != 0 or not destination_path.is_file():
            raise AgentApiError("SCREEN_CAPTURE_FAILED", "FFmpeg could not capture the Windows virtual desktop. Its build must support gdigrab.")
        output_streams = await ffprobe_streams_for_file(destination_path, ffprobe.executable)
        output_stream = next((stream for stream in output_streams if stream.get("codec_type") == "video"), None)
        width = output_stream.get("width") if isinstance(output_stream, dict) else None
        height = output_stream.get("height") if isinstance(output_stream, dict) else None
        if width != region["width"] or height != region["height"]:
            raise AgentApiError("SCREEN_CAPTURE_FAILED", "FFmpeg did not produce the requested screen-capture dimensions.")
        result = {"workspacePath": destination.logical_path, "format": options["image"]["format"], "mimeType": mime_type, "width": width, "height": height, "imageSizeBytes": destination_path.stat().st_size, "monitorCount": monitor_count, "virtualDesktop": virtual_desktop, "region": region}
        log(f"capture_screen monitors={monitor_count} {width}x{height} -> {destination.logical_path}")
        return result
    except AgentApiError:
        if destination_path is not None:
            try:
                destination_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise


async def capture_screen(payload: Any) -> dict[str, Any]:
    """Capture exactly one virtual-desktop image on the current platform."""
    if os.name == "nt":
        return await capture_screen_windows(payload)
    if platform.system() == "Linux":
        return await capture_screen_x11(payload)
    return await capture_screen_macos(payload)


def showinfo_timestamp(stderr: bytes) -> float | None:
    matches = re.findall(rb"pts_time:([+-]?(?:\d+(?:\.\d*)?|\.\d+))", stderr)
    if not matches:
        return None
    try:
        # The filter graph can process a few extra frames before ffmpeg stops
        # the single-image output. The first showinfo entry is the frame that
        # the select filter admitted to the encoder.
        result = float(matches[0])
    except ValueError:
        return None
    return result if math.isfinite(result) else None


async def visual_map_video_metadata(item: ResolvedWorkspacePath, executable: str) -> tuple[float, int, int, int, float | None]:
    command = [executable, "-v", "error", "-show_entries", "format=duration:stream=index,codec_type,width,height,duration,avg_frame_rate,r_frame_rate:stream_side_data=rotation", "-of", "json", str(item.physical_path)]
    try:
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, _stderr = await asyncio.wait_for(process.communicate(), timeout=MEDIA_PROBE_TIMEOUT_SECONDS)
    except (asyncio.TimeoutError, OSError) as error:
        raise AgentApiError("VISUAL_MAP_FAILED", "ffprobe could not inspect the workspace video.") from error
    if process.returncode != 0:
        raise AgentApiError("VISUAL_MAP_FAILED", "ffprobe could not inspect the workspace video.")
    try:
        document = json.loads(stdout.decode("utf-8"))
        container_duration = float(document["format"]["duration"])
        stream = next(value for value in document["streams"] if value.get("codec_type") == "video" and isinstance(value.get("width"), int) and isinstance(value.get("height"), int))
        width, height, index = stream["width"], stream["height"], stream["index"]
    except (KeyError, TypeError, ValueError, StopIteration, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AgentApiError("VISUAL_MAP_FAILED", "ffprobe did not report a usable video duration and stream dimensions.") from error
    stream_duration = stream.get("duration")
    try:
        duration = float(stream_duration) if stream_duration is not None else container_duration
    except (TypeError, ValueError):
        duration = container_duration
    if not math.isfinite(container_duration) or container_duration <= 0 or not math.isfinite(duration) or duration <= 0 or width < 1 or height < 1 or not isinstance(index, int):
        raise AgentApiError("VISUAL_MAP_FAILED", "ffprobe did not report usable video metadata.")
    if not math.isclose(video_stream_rotation(stream) % 180, 0.0, abs_tol=0.001):
        width, height = height, width
    return duration, width, height, index, video_frame_rate(stream)


def visual_map_label_filter(label: str, position: str, height: int) -> str:
    if position == "none":
        return ""
    font_size = max(1, min(DEFAULT_TIMESTAMP_FONT_SIZE_PX, math.floor(height * 0.15)))
    padding = max(1, round(font_size * 0.30))
    x = str(padding) if position.endswith("Left") else f"w-text_w-{padding}"
    y = str(padding) if position.startswith("top") else f"h-text_h-{padding}"
    font_file = visual_map_font_file()
    if font_file is None:
        raise AgentApiError("VISUAL_MAP_TIMESTAMP_FONT_UNAVAILABLE", "The configured visual-map timestamp font is unavailable in tools/fonts. Add the font there, choose its filename in agent-config.json, or use frameTimestampPosition=none.")
    escaped_font = ffmpeg_filter_value(font_file.as_posix())
    escaped_label = ffmpeg_filter_value(label)
    return f"drawtext=fontfile='{escaped_font}':text='{escaped_label}':x={x}:y={y}:fontsize={font_size}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw={padding}"


def ffmpeg_filter_value(value: str) -> str:
    """Escape one literal FFmpeg filter option value without exposing paths."""
    return value.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def visual_map_font_file() -> Path | None:
    """Resolve the selected bundled font; no operating-system font paths are used."""
    candidate = FONTS_PATH / configured_visual_map_timestamp_font()
    return local_executable(candidate, FONTS_PATH)


async def run_visual_map_ffmpeg(command: list[str], timeout: float) -> tuple[int, bytes]:
    """Run one visual-map FFmpeg command without emitting diagnostic output."""
    process: asyncio.subprocess.Process | None = None
    try:
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        if process is not None and process.returncode is None:
            process.kill()
            await process.communicate()
        raise
    except asyncio.CancelledError:
        if process is not None and process.returncode is None:
            process.kill()
            await process.communicate()
        raise
    except OSError:
        raise
    return process.returncode, stderr


def visual_map_scene_detect_filter(start: float, end: float, threshold: float) -> str:
    """Use FFmpeg's native scdet percentage threshold, passing only detected frames."""
    return f"trim=start={start:.9f}:end={end:.9f},scdet=threshold={threshold:.6f}:sc_pass=1,metadata=print:file=-:direct=1"


async def detect_visual_map_scenes(source: ResolvedWorkspacePath, executable: str, stream_index: int, start: float, end: float, threshold: float) -> list[VisualMapSceneCandidate]:
    """Ask FFmpeg scdet for scene-change timestamps and scores in the requested range."""
    filters = visual_map_scene_detect_filter(start, end, threshold)
    command = [executable, "-hide_banner", "-nostdin", "-v", "error", "-i", str(source.physical_path), "-map", f"0:{stream_index}", "-an", "-vf", filters, "-f", "null", "-"]
    process: asyncio.subprocess.Process | None = None
    try:
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, _stderr = await asyncio.wait_for(process.communicate(), timeout=VISUAL_MAP_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as error:
        if process is not None and process.returncode is None:
            process.kill()
            await process.communicate()
        raise AgentApiError("VISUAL_MAP_FAILED", "ffmpeg scene detection timed out.") from error
    except asyncio.CancelledError:
        if process is not None and process.returncode is None:
            process.kill()
            await process.communicate()
        raise
    except OSError as error:
        raise AgentApiError("VISUAL_MAP_FAILED", "ffmpeg scene detection could not be started.") from error
    if process.returncode != 0:
        raise AgentApiError("VISUAL_MAP_FAILED", "ffmpeg scene detection failed.")
    return visual_map_scene_candidates(stdout, start, end)


VisualMapProgressReporter = Callable[[str, float, str, int, int, int, int], None]


async def media_create_visual_map(payload: Any, progress: VisualMapProgressReporter | None = None) -> dict[str, Any]:
    def report(phase: str, percentage: float, message: str, completed_frames: int, total_frames: int, completed_maps: int, total_maps: int) -> None:
        if progress is not None:
            progress(phase, percentage, message, completed_frames, total_frames, completed_maps, total_maps)

    options = visual_map_options(payload)
    resolver = WorkspacePathResolver()
    source = resolver.resolve_existing(options["workspacePath"], field_name="workspacePath", expected_type="file")
    ffmpeg = find_component("ffmpeg", COMPONENTS["ffmpeg"][0])
    ffprobe = find_component("ffprobe", COMPONENTS["ffprobe"][0])
    if ffmpeg.error or ffprobe.error:
        raise AgentApiError("FFMPEG_DISCOVERY_ERROR", "ffmpeg or ffprobe discovery is ambiguous.", ffmpeg.error or ffprobe.error)
    if not ffmpeg.executable or not ffprobe.executable:
        raise AgentApiError("FFMPEG_NOT_AVAILABLE", "ffmpeg and ffprobe are required to create a visual map.")
    duration, source_width, source_height, stream_index, frame_rate = await visual_map_video_metadata(source, ffprobe.executable)
    start = options["startSeconds"]
    end = duration if options["endSeconds"] is None else options["endSeconds"]
    if end is None or end > duration or start >= end:
        raise AgentApiError("VISUAL_MAP_INVALID", "The requested range must be within the video and have startSeconds less than endSeconds.")
    if options["selection"] == "uniform":
        timestamps = uniform_visual_map_timestamps(start, end, options["maxTotalFrames"])
    else:
        report("detectingScenes", 2.0, "Detecting scene changes.", 0, 0, 0, 0)
        candidates = await detect_visual_map_scenes(source, ffmpeg.executable, stream_index, start, end, options["sceneDetectThreshold"])
        if options["selection"] == "sceneDetect":
            timestamps = [candidate.timestamp_seconds for candidate in select_visual_map_scene_candidates(candidates, options["maxTotalFrames"])]
            if not timestamps:
                raise AgentApiError("VISUAL_MAP_NO_SCENES", "No scene changes exceeded the FFmpeg scene-detection threshold in the requested range.")
        else:
            timestamps = hybrid_visual_map_timestamps(candidates, start, end, options["maxTotalFrames"])
    thumbnail_width, thumbnail_height = visual_map_thumbnail_size(source_width, source_height, options["columns"], options["rows"], options["maxMapDimension"])
    temporary_directory = resolver.resolve_destination(f".researchtube-visual-map-tmp/{secrets.token_urlsafe(8)}", field_name="temporary directory", error_code="WORKSPACE_PATH_INVALID")
    temporary_directory.physical_path.mkdir(parents=True, exist_ok=True)
    frames: list[tuple[float, Path]] = []
    output_paths: list[Path] = []
    map_id = secrets.token_urlsafe(5)
    try:
        report("extractingFrames", 5.0, "Extracting video frames.", 0, len(timestamps), 0, 0)
        seen_decoded: set[float] = set()
        for frame_number, timestamp in enumerate(timestamps):
            frame_path = temporary_directory.physical_path / f"frame-{frame_number:03d}.png"
            final_full_range_frame = options["selection"] == "uniform" and options["endSeconds"] is None and len(timestamps) > 1 and frame_number == len(timestamps) - 1
            extraction_timestamp = visual_map_extract_timestamp(timestamp, duration, frame_rate)
            filters = (["reverse"] if final_full_range_frame else [f"select=gte(t\\,{extraction_timestamp:.9f})"])
            filters.extend([f"scale={thumbnail_width}:{thumbnail_height}:force_original_aspect_ratio=decrease", f"pad={thumbnail_width}:{thumbnail_height}:(ow-iw)/2:(oh-ih):color=black"])
            label_filter = visual_map_label_filter(visual_map_timestamp_label(timestamp), options["frameTimestampPosition"], thumbnail_height)
            if label_filter:
                filters.append(label_filter)
            filters.append("showinfo")
            command = [ffmpeg.executable, "-hide_banner", "-nostdin", "-v", "info"]
            command.extend(["-sseof", "-1"] if final_full_range_frame else [])
            command.extend(["-i", str(source.physical_path), "-map", f"0:{stream_index}", "-an", "-frames:v", "1", "-vf", ",".join(filters), "-c:v", "png", "-compression_level", "6", "-y", str(frame_path)])
            try:
                returncode, stderr = await run_visual_map_ffmpeg(command, CAPTURE_FRAME_TIMEOUT_SECONDS)
            except (asyncio.TimeoutError, OSError) as error:
                raise AgentApiError("VISUAL_MAP_FAILED", "ffmpeg could not extract a visual-map frame.") from error
            if returncode != 0 or not frame_path.is_file():
                raise AgentApiError("VISUAL_MAP_FAILED", "ffmpeg could not extract a visual-map frame.")
            # reverse starts its output timestamp sequence at zero. The final
            # full-range frame must therefore keep its nominal endpoint for
            # duplicate detection instead of being confused with frame zero.
            decoded_timestamp = None if final_full_range_frame else showinfo_timestamp(stderr)
            decoded = round(decoded_timestamp if decoded_timestamp is not None else timestamp, 6)
            if decoded in seen_decoded:
                frame_path.unlink(missing_ok=True)
                report("extractingFrames", 5.0 + 75.0 * (frame_number + 1) / len(timestamps), "Extracting video frames.", frame_number + 1, len(timestamps), 0, 0)
                continue
            seen_decoded.add(decoded)
            frames.append((timestamp, frame_path))
            report("extractingFrames", 5.0 + 75.0 * (frame_number + 1) / len(timestamps), "Extracting video frames.", frame_number + 1, len(timestamps), 0, 0)
        if not frames:
            raise AgentApiError("VISUAL_MAP_FAILED", "The requested range did not produce a frame.")
        capacity = options["columns"] * options["rows"]
        total_maps = math.ceil(len(frames) / capacity)
        report("assemblingMaps", 80.0, "Assembling visual maps.", len(frames), len(timestamps), 0, total_maps)
        maps: list[dict[str, Any]] = []
        for map_number, offset in enumerate(range(0, len(frames), capacity), start=1):
            group = frames[offset:offset + capacity]
            destination = resolver.resolve_destination(visual_map_default_path(source.logical_path, map_number, map_id), field_name="visual map output", error_code="WORKSPACE_PATH_INVALID")
            destination.physical_path.parent.mkdir(parents=True, exist_ok=True)
            destination = resolver.resolve_destination(destination.logical_path, field_name="visual map output", error_code="WORKSPACE_PATH_INVALID")
            if destination.physical_path.exists() or destination.physical_path.is_symlink():
                raise AgentApiError("VISUAL_MAP_DESTINATION_EXISTS", "A visual-map output path already exists; this tool never overwrites a workspace file.")
            output_paths.append(destination.physical_path)
            command = [ffmpeg.executable, "-hide_banner", "-nostdin", "-v", "error"]
            for _timestamp, frame_path in group:
                command.extend(["-loop", "1", "-i", str(frame_path)])
            for _ in range(capacity - len(group)):
                command.extend(["-f", "lavfi", "-i", f"color=c=black@0.0:s={thumbnail_width}x{thumbnail_height}:r=1"])
            labels = "".join(f"[{index}:v]" for index in range(capacity))
            layout = "|".join(f"{(index % options['columns']) * thumbnail_width}_{(index // options['columns']) * thumbnail_height}" for index in range(capacity))
            command.extend(["-filter_complex", f"{labels}xstack=inputs={capacity}:layout={layout}:fill=black@0.0,format=rgba[out]", "-map", "[out]", "-frames:v", "1", "-c:v", "png", "-compression_level", "6", "-y", str(destination.physical_path)])
            try:
                returncode, _stderr = await run_visual_map_ffmpeg(command, VISUAL_MAP_TIMEOUT_SECONDS)
            except (asyncio.TimeoutError, OSError) as error:
                raise AgentApiError("VISUAL_MAP_FAILED", "ffmpeg could not assemble a visual map.") from error
            if returncode != 0 or not destination.physical_path.is_file():
                raise AgentApiError("VISUAL_MAP_FAILED", "ffmpeg could not assemble a visual map.")
            maps.append({"workspacePath": destination.logical_path, "frameCount": len(group), "timestampsSeconds": [timestamp for timestamp, _frame in group]})
            report("assemblingMaps", 80.0 + 20.0 * map_number / total_maps, "Assembling visual maps.", len(frames), len(timestamps), map_number, total_maps)
        result = {"sourcePath": source.logical_path, "selection": options["selection"], "sceneDetectThreshold": options["sceneDetectThreshold"], "range": {"startSeconds": start, "endSeconds": end}, "columns": options["columns"], "rows": options["rows"], "mapCapacity": capacity, "maxTotalFrames": options["maxTotalFrames"], "actualTotalFrames": len(frames), "maps": maps}
        log(f"visual_map_create path={source.logical_path} frames={len(frames)} maps={len(maps)} -> ok")
        return result
    except AgentApiError:
        for output_path in output_paths:
            output_path.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(temporary_directory.physical_path, ignore_errors=True)


def windows_speech_python() -> str:
    if sys.platform != "win32":
        raise AgentApiError("SPEECH_NOT_SUPPORTED", "Windows text-to-speech is available only on Windows.")
    if not WINDOWS_SPEECH_SCRIPT_PATH.is_file():
        raise AgentApiError("SPEECH_NOT_AVAILABLE", "The Windows text-to-speech helper is not installed.")
    return sys.executable


def speech_options(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) - {"text", "engine", "voiceId", "outputPath", "outputMode"}:
        raise AgentApiError("SPEECH_INVALID", "system_speech_speak accepts text, engine, optional voiceId, outputMode, and outputPath only.")
    text = payload.get("text")
    voice_id = payload.get("voiceId")
    if not isinstance(text, str) or not text.strip():
        raise AgentApiError("SPEECH_INVALID", "text must be a non-empty string.")
    if len(text.encode("utf-8")) > SPEECH_MAX_TEXT_BYTES:
        raise AgentApiError("SPEECH_INVALID", f"text must not exceed {SPEECH_MAX_TEXT_BYTES} UTF-8 bytes.")
    if voice_id is not None and (not isinstance(voice_id, str) or not voice_id.strip()):
        raise AgentApiError("SPEECH_INVALID", "voiceId must be null or a non-empty voiceId returned by system_speech_list_voices.")
    engine = payload.get("engine", "googleTranslate")
    if engine not in {"windows", "googleTranslate"}:
        raise AgentApiError("SPEECH_INVALID", "engine must be windows or googleTranslate.")
    if engine == "googleTranslate":
        if voice_id is not None:
            raise AgentApiError("SPEECH_INVALID", "voiceId is available only with the Windows speech engine.")
    output_path = payload.get("outputPath")
    if output_path is not None and (not isinstance(output_path, str) or not output_path.strip()):
        raise AgentApiError("SPEECH_INVALID", "outputPath must be omitted, null, or a non-empty workspace-relative audio path.")
    output_mode = payload.get("outputMode", "speakers")
    if output_mode not in {"file", "speakers", "both"}:
        raise AgentApiError("SPEECH_INVALID", "outputMode must be one of: file, speakers, both.")
    if output_mode == "speakers" and output_path is not None:
        raise AgentApiError("SPEECH_INVALID", "outputPath is available only when outputMode is file or both.")
    return {"text": text, "engine": engine, "voiceId": voice_id, "outputPath": output_path, "outputMode": output_mode}


def speech_base64(value: str | None) -> str:
    return base64.b64encode((value or "").encode("utf-8")).decode("ascii")


def normalize_speech_voice(voice: Any) -> dict[str, Any]:
    """Keep Windows' optional/unknown VoiceGender from breaking voice discovery."""
    if not isinstance(voice, dict):
        raise AgentApiError("SPEECH_SYNTHESIS_FAILED", "Windows returned an invalid speech voice.")
    voice_id, name, language = voice.get("voiceId"), voice.get("name"), voice.get("language")
    if not isinstance(voice_id, str) or not voice_id or not isinstance(name, str) or not name or not isinstance(language, str) or not language or not isinstance(voice.get("isDefault"), bool):
        raise AgentApiError("SPEECH_SYNTHESIS_FAILED", "Windows returned an invalid speech voice.")
    gender = voice.get("gender")
    return {"voiceId": voice_id, "name": name, "language": language, "gender": gender if gender in {"male", "female", "neutral"} else "neutral", "isDefault": voice["isDefault"]}


# Public voice IDs intentionally never contain the Windows voice/registry ID.
# They only need to survive from list_voices to a following speak call in this
# running Local Agent, so an in-memory, positional mapping is sufficient.
SPEECH_WINDOWS_VOICE_IDS: dict[str, str] = {}
SPEECH_WINDOWS_VOICE_NAMES: dict[str, str] = {}


def public_speech_voices(voices: list[Any]) -> list[dict[str, Any]]:
    normalized = [normalize_speech_voice(voice) for voice in voices]
    SPEECH_WINDOWS_VOICE_IDS.clear()
    SPEECH_WINDOWS_VOICE_NAMES.clear()
    public: list[dict[str, Any]] = []
    for index, voice in enumerate(normalized, start=1):
        public_id = f"voice_{index}"
        SPEECH_WINDOWS_VOICE_IDS[public_id] = voice["voiceId"]
        SPEECH_WINDOWS_VOICE_NAMES[public_id] = voice["name"]
        public.append({**voice, "voiceId": public_id})
    return public


async def system_speech_list_voices(payload: Any) -> dict[str, Any]:
    if payload not in ({}, None):
        raise AgentApiError("SPEECH_INVALID", "system_speech_list_voices does not accept arguments.")
    executable = windows_speech_python()
    try:
        process = await asyncio.create_subprocess_exec(executable, str(WINDOWS_SPEECH_SCRIPT_PATH), "--action", "list-voices", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=15)
    except asyncio.TimeoutError as error:
        process.kill(); await process.communicate()
        raise AgentApiError("SPEECH_SYNTHESIS_FAILED", "Windows could not enumerate speech voices in time.") from error
    except OSError as error:
        raise AgentApiError("SPEECH_NOT_AVAILABLE", "The Windows text-to-speech helper could not start.") from error
    if process.returncode != 0:
        raise AgentApiError("SPEECH_SYNTHESIS_FAILED", "Windows could not enumerate speech voices.")
    try:
        document = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AgentApiError("SPEECH_SYNTHESIS_FAILED", "Windows returned an invalid speech-voice list.") from error
    voices = document.get("voices") if isinstance(document, dict) else None
    if not isinstance(voices, list):
        raise AgentApiError("SPEECH_SYNTHESIS_FAILED", "Windows returned an invalid speech-voice list.")
    return {"voices": public_speech_voices(voices)}


async def system_speech_voice_name(executable: str, voice_id: str | None) -> str:
    """Resolve the actual selected voice's display name without publishing its ID."""
    process: asyncio.subprocess.Process | None = None
    try:
        process = await asyncio.create_subprocess_exec(
            executable, str(WINDOWS_SPEECH_SCRIPT_PATH), "--action", "voice-info",
            "--voice-id-base64", speech_base64(voice_id),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=15)
    except asyncio.TimeoutError as error:
        if process is not None:
            process.kill(); await process.communicate()
        raise AgentApiError("SPEECH_SYNTHESIS_FAILED", "Windows could not resolve the selected speech voice in time.") from error
    except OSError as error:
        raise AgentApiError("SPEECH_NOT_AVAILABLE", "The Windows text-to-speech helper could not start.") from error
    if process.returncode != 0:
        code = "VOICE_NOT_FOUND" if b"VOICE_NOT_FOUND" in stderr else "SPEECH_SYNTHESIS_FAILED"
        raise AgentApiError(code, "The selected Windows voice was not found." if code == "VOICE_NOT_FOUND" else "Windows could not resolve the selected speech voice.")
    try:
        name = json.loads(stdout.decode("utf-8")).get("name")
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError) as error:
        raise AgentApiError("SPEECH_SYNTHESIS_FAILED", "Windows returned invalid selected-voice information.") from error
    if not isinstance(name, str) or not name.strip():
        raise AgentApiError("SPEECH_SYNTHESIS_FAILED", "Windows returned invalid selected-voice information.")
    return name.strip()


def new_speech_file_id() -> str:
    return f"tts_{secrets.token_urlsafe(7)}"


def speech_filename_stem(voice_name: str, file_id: str) -> str:
    name = re.sub(r'[\x00-\x1f<>:"/\\|?*]+', " ", voice_name)
    name = re.sub(r"\s+", " ", name).strip(" .")[:160].rstrip(" .") or "Windows voice"
    return f"{name} {camera_filename_timestamp()} [{file_id}]"


def speech_default_workspace_path(voice_name: str, file_id: str, extension: str = "wav") -> str:
    return f"text-to-speech/{speech_filename_stem(voice_name, file_id)}.{extension}"


@dataclass
class SpeechTask:
    task_id: str
    text: str
    voice_id: str | None
    voice_name: str
    output_mode: str
    output_path: str | None
    created_at: str
    last_updated_at: str
    engine: str = "windows"
    upload_token: str | None = None
    status: str = "working"
    status_message: str = "Preparing speech."
    phase: str = "preparing"
    progress_percent: float = 0.0
    result: dict[str, Any] | None = None
    error: dict[str, str] | None = None
    process: asyncio.subprocess.Process | None = None
    runner: asyncio.Task[None] | None = None
    voice_not_found: bool = False

    def touch(self, message: str | None = None) -> None:
        self.last_updated_at = utc_now()
        if message is not None:
            self.status_message = message


class SpeechTaskManager:
    def __init__(self) -> None: self.tasks: dict[str, SpeechTask] = {}

    def new_task_id(self) -> str:
        while True:
            task_id = f"tsk_{secrets.token_urlsafe(7)}"
            if task_id not in self.tasks:
                return task_id

    def get(self, task_id: str) -> SpeechTask:
        if not isinstance(task_id, str) or not task_id or task_id not in self.tasks:
            raise AgentApiError("TASK_NOT_FOUND", "The requested speech task does not exist.")
        return self.tasks[task_id]

    def snapshot(self, task: SpeechTask) -> dict[str, Any]:
        result: dict[str, Any] = {"taskId": task.task_id, "status": task.status, "phase": task.phase, "progressPercent": task.progress_percent, "statusMessage": task.status_message, "engine": task.engine, "voiceName": task.voice_name, "outputMode": task.output_mode, "saveToFile": task.output_path is not None, "outputPath": task.output_path, "createdAt": task.created_at, "lastUpdatedAt": task.last_updated_at, "pollIntervalMs": TASK_POLL_INTERVAL_MS}
        if task.result is not None:
            result["result"] = task.result
        if task.error is not None:
            result["error"] = task.error
        return result

    async def create(self, payload: Any) -> dict[str, Any]:
        options = speech_options(payload)
        now = utc_now()
        if options["engine"] == "googleTranslate":
            voice_name = "Google Translate (auto)"
            output_path = self.prepare_output_path(options, voice_name, "mp3")
            task = SpeechTask(self.new_task_id(), options["text"], None, voice_name, options["outputMode"], output_path, now, now,
                              engine="googleTranslate", upload_token=secrets.token_urlsafe(24),
                              status_message="Opening Google Translate.", phase="preparing")
            self.tasks[task.task_id] = task
            result = self.snapshot(task)
            result["uploadToken"] = task.upload_token
            return result
        executable = windows_speech_python()
        requested_voice_id = options["voiceId"]
        if requested_voice_id is not None and requested_voice_id not in SPEECH_WINDOWS_VOICE_IDS:
            raise AgentApiError("VOICE_NOT_FOUND", "The selected Windows voice was not found. Call system_speech_list_voices again.")
        windows_voice_id = SPEECH_WINDOWS_VOICE_IDS.get(requested_voice_id) if requested_voice_id is not None else None
        voice_name = SPEECH_WINDOWS_VOICE_NAMES.get(requested_voice_id) if requested_voice_id is not None else None
        if voice_name is None:
            voice_name = await system_speech_voice_name(executable, windows_voice_id)
        output_path = self.prepare_output_path(options, voice_name, "wav")
        task = SpeechTask(self.new_task_id(), options["text"], windows_voice_id, voice_name, options["outputMode"], output_path, now, now)
        self.tasks[task.task_id] = task
        task.runner = asyncio.create_task(self.run(task, executable), name=f"researchtube-speech-{task.task_id}")
        return self.snapshot(task)

    @staticmethod
    def prepare_output_path(options: dict[str, Any], voice_name: str, extension: str) -> str | None:
        if options["outputMode"] not in {"file", "both"}:
            return None
        output_path = options["outputPath"] or speech_default_workspace_path(voice_name, new_speech_file_id(), extension)
        destination = WorkspacePathResolver().resolve_destination(output_path, field_name="outputPath", error_code="SPEECH_INVALID")
        if destination.physical_path.suffix.lower() != f".{extension}":
            raise AgentApiError("SPEECH_INVALID", f"outputPath must end in .{extension} for the selected speech engine.")
        if destination.physical_path.exists() or destination.physical_path.is_symlink():
            raise AgentApiError("DESTINATION_EXISTS", "The speech output destination already exists; this tool never overwrites files.")
        return destination.logical_path

    def google_task(self, task_id: str, upload_token: str) -> SpeechTask:
        task = self.get(task_id)
        if task.engine != "googleTranslate" or not isinstance(upload_token, str) or not secrets.compare_digest(task.upload_token or "", upload_token):
            raise AgentApiError("GOOGLE_TRANSLATE_TASK_INVALID", "The Google Translate speech task is invalid.")
        if task.status != "working":
            raise AgentApiError("GOOGLE_TRANSLATE_TASK_INVALID", "The Google Translate speech task is no longer active.")
        return task

    def google_progress(self, task_id: str, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict) or set(payload) != {"uploadToken", "phase", "progressPercent"}:
            raise AgentApiError("GOOGLE_TRANSLATE_TASK_INVALID", "Google Translate progress is invalid.")
        task = self.google_task(task_id, payload["uploadToken"])
        phase = payload["phase"]
        progress = payload["progressPercent"]
        messages = {"openingTranslate": "Opening Google Translate.", "synthesizing": "Waiting for Google Translate to prepare speech.", "playing": "Playing Google Translate speech.", "capturing": "Collecting Google Translate source audio.", "saving": "Saving Google Translate source audio."}
        if phase not in messages or not isinstance(progress, (int, float)) or isinstance(progress, bool) or not math.isfinite(progress) or not 0 <= progress < 100:
            raise AgentApiError("GOOGLE_TRANSLATE_TASK_INVALID", "Google Translate progress is invalid.")
        task.phase, task.progress_percent = phase, max(task.progress_percent, float(progress))
        task.touch(messages[phase])
        return self.snapshot(task)

    def google_complete(self, task_id: str, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict) or set(payload) != {"uploadToken"}:
            raise AgentApiError("GOOGLE_TRANSLATE_TASK_INVALID", "Google Translate completion is invalid.")
        task = self.google_task(task_id, payload["uploadToken"])
        if task.output_path is not None:
            raise AgentApiError("GOOGLE_TRANSLATE_TASK_INVALID", "Google Translate audio must be uploaded before completing this task.")
        task.status, task.phase, task.progress_percent = "completed", "completed", 100.0
        task.touch("Google Translate speech completed.")
        return self.snapshot(task)

    def google_fail(self, task_id: str, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict) or set(payload) != {"uploadToken", "code"}:
            raise AgentApiError("GOOGLE_TRANSLATE_TASK_INVALID", "Google Translate failure is invalid.")
        task = self.google_task(task_id, payload["uploadToken"])
        messages = {"GOOGLE_TRANSLATE_UNAVAILABLE": "Google Translate could not prepare the requested speech.", "GOOGLE_TRANSLATE_PLAYBACK_FAILED": "Google Translate could not play the requested speech.", "GOOGLE_TRANSLATE_AUDIO_UNAVAILABLE": "Chrome could not obtain the Google Translate source audio."}
        if payload["code"] not in messages:
            raise AgentApiError("GOOGLE_TRANSLATE_TASK_INVALID", "Google Translate failure is invalid.")
        task.status, task.phase, task.error = "failed", "failed", {"code": payload["code"], "message": messages[payload["code"]]}
        task.touch("Google Translate speech failed.")
        return self.snapshot(task)

    async def google_audio(self, task_id: str, upload_token: str, audio: bytes) -> dict[str, Any]:
        task = self.google_task(task_id, upload_token)
        is_mp3 = audio.startswith(b"ID3") or (len(audio) >= 2 and audio[0] == 0xff and (audio[1] & 0xe0) == 0xe0)
        if task.output_path is None or len(audio) < 64 or len(audio) > MAX_GOOGLE_TRANSLATE_AUDIO_BYTES or not is_mp3:
            raise AgentApiError("GOOGLE_TRANSLATE_AUDIO_UNAVAILABLE", "Chrome did not provide valid Google Translate MP3 audio.")
        destination = WorkspacePathResolver().resolve_destination(task.output_path, field_name="speech output", error_code="SPEECH_FILE_FAILED")
        if destination.physical_path.exists() or destination.physical_path.is_symlink():
            raise AgentApiError("DESTINATION_EXISTS", "The speech output destination already exists; this tool never overwrites files.")
        task.phase, task.progress_percent = "saving", max(task.progress_percent, 80.0)
        task.touch("Saving Google Translate source audio.")
        destination.physical_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(prefix=".researchtube-google-tts-", suffix=".mp3", dir=destination.physical_path.parent)
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as source:
                source.write(audio)
            try:
                os.link(temporary, destination.physical_path)
            except FileExistsError as error:
                raise AgentApiError("DESTINATION_EXISTS", "The speech output destination already exists; this tool never overwrites files.") from error
        finally:
            temporary.unlink(missing_ok=True)
        task.result = {"filePath": destination.logical_path, "format": "mp3", "mimeType": "audio/mpeg"}
        task.status, task.phase, task.progress_percent = "completed", "completed", 100.0
        task.touch("Google Translate speech completed.")
        return self.snapshot(task)

    async def run(self, task: SpeechTask, executable: str) -> None:
        stdout = b""; stderr = b""; temporary_output: Path | None = None; final_output: ResolvedWorkspacePath | None = None
        try:
            if task.voice_not_found:
                raise AgentApiError("VOICE_NOT_FOUND", "The selected Windows voice was not found.")
            if task.output_path is not None:
                final_output = WorkspacePathResolver().resolve_destination(task.output_path, field_name="speech output", error_code="SPEECH_FILE_FAILED")
                if final_output.physical_path.exists() or final_output.physical_path.is_symlink():
                    raise AgentApiError("DESTINATION_EXISTS", "The speech output destination already exists; this tool never overwrites files.")
                final_output.physical_path.parent.mkdir(parents=True, exist_ok=True)
                temporary_output = final_output.physical_path.with_suffix(".tmp.wav")
                if temporary_output.exists() or temporary_output.is_symlink():
                    raise AgentApiError("DESTINATION_EXISTS", "The temporary speech output destination already exists. Try again.")
            task.phase = "synthesizing"; task.touch("Synthesizing speech.")
            task.process = await asyncio.create_subprocess_exec(
                executable, str(WINDOWS_SPEECH_SCRIPT_PATH), "--action", "speak",
                "--text-base64", "__STDIN__", "--voice-id-base64", speech_base64(task.voice_id),
                "--output-path-base64", speech_base64(str(temporary_output) if temporary_output is not None else None),
                "--play-through-speakers", "true" if task.output_mode in {"speakers", "both"} else "false",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            assert task.process.stdin is not None
            task.process.stdin.write(speech_base64(task.text).encode("ascii"))
            await task.process.stdin.drain()
            task.process.stdin.close()

            async def read_events() -> None:
                assert task.process is not None and task.process.stdout is not None
                while line := await task.process.stdout.readline():
                    try:
                        event = json.loads(line.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                    if not isinstance(event, dict):
                        continue
                    completed, total = event.get("completedChunks"), event.get("totalChunks")
                    if isinstance(completed, int) and isinstance(total, int) and total > 0:
                        task.progress_percent = min(99.0, max(task.progress_percent, completed * 100.0 / total))
                    reported_progress = event.get("progressPercent")
                    if isinstance(reported_progress, (int, float)) and math.isfinite(reported_progress):
                        task.progress_percent = min(99.0, max(task.progress_percent, float(reported_progress)))
                    kind = event.get("event")
                    if kind == "synthesizing": task.phase, task.status_message = "synthesizing", "Synthesizing speech."
                    elif kind == "saving": task.phase, task.status_message = "saving", "Saving synthesized speech to WAV."
                    elif kind == "speaking": task.phase, task.status_message = "speaking", "Speaking through the default Windows audio output."
                    task.last_updated_at = utc_now()

            reader = asyncio.create_task(read_events())
            assert task.process.stderr is not None
            stderr = await task.process.stderr.read()
            await task.process.wait()
            await asyncio.gather(reader, return_exceptions=True)
            if task.process.returncode != 0:
                message = stderr.decode("utf-8", errors="replace")
                code = "VOICE_NOT_FOUND" if "VOICE_NOT_FOUND" in message else "AUDIO_PLAYBACK_FAILED" if "AUDIO_PLAYBACK_FAILED" in message else "SPEECH_FILE_FAILED" if "SPEECH_FILE_FAILED" in message else "SPEECH_SYNTHESIS_FAILED"
                messages = {"VOICE_NOT_FOUND": "The selected Windows voice was not found.", "AUDIO_PLAYBACK_FAILED": "Windows could not play the requested speech.", "SPEECH_FILE_FAILED": "Windows could not save the requested speech audio.", "SPEECH_SYNTHESIS_FAILED": "Windows could not synthesize the requested speech."}
                raise AgentApiError(code, messages[code])
            if temporary_output is not None and final_output is not None:
                if not temporary_output.is_file() or temporary_output.stat().st_size < 44:
                    raise AgentApiError("SPEECH_FILE_FAILED", "Windows could not save the requested speech audio.")
                temporary_output.replace(final_output.physical_path)
                task.result = {"filePath": final_output.logical_path, "format": "wav", "mimeType": "audio/wav"}
            task.status, task.phase, task.progress_percent = "completed", "completed", 100.0
            task.touch("Speech completed.")
        except asyncio.CancelledError:
            if task.process is not None and task.process.returncode is None:
                task.process.terminate()
                try: await asyncio.wait_for(task.process.wait(), timeout=2)
                except asyncio.TimeoutError: task.process.kill()
            task.status, task.phase = "cancelled", "cancelled"; task.touch("Speech cancelled.")
            raise
        except AgentApiError as error:
            task.status, task.phase, task.error = "failed", "failed", {"code": error.code, "message": error.message}; task.touch("Speech failed.")
        except (OSError, asyncio.SubprocessError) as error:
            task.status, task.phase, task.error = "failed", "failed", {"code": "SPEECH_SYNTHESIS_FAILED", "message": "Windows could not start text-to-speech."}; task.touch("Speech failed.")
        finally:
            task.process = None
            if temporary_output is not None:
                temporary_output.unlink(missing_ok=True)

    async def cancel(self, task_id: str) -> dict[str, Any]:
        task = self.get(task_id)
        if task.status == "working" and task.engine == "googleTranslate":
            task.status, task.phase = "cancelled", "cancelled"; task.touch("Speech cancelled.")
            return {"taskId": task.task_id, "status": task.status}
        if task.status == "working" and task.runner is not None and not task.runner.done():
            if task.process is not None and task.process.returncode is None:
                task.process.terminate()
            task.status, task.phase = "cancelled", "cancelled"
            task.touch("Speech cancelled.")
            task.runner.cancel()
        return {"taskId": task.task_id, "status": task.status}

    async def shutdown(self) -> None:
        runners = [task.runner for task in self.tasks.values() if task.runner is not None and not task.runner.done()]
        for runner in runners: runner.cancel()
        if runners: await asyncio.gather(*runners, return_exceptions=True)


SPEECH_TASKS = SpeechTaskManager()


@dataclass
class VisualMapTask:
    task_id: str
    payload: dict[str, Any]
    created_at: str
    last_updated_at: str
    status: str = "working"
    status_message: str = "Preparing visual map."
    phase: str = "preparing"
    progress_percent: float = 0.0
    completed_frames: int = 0
    total_frames: int = 0
    completed_maps: int = 0
    total_maps: int = 0
    result: dict[str, Any] | None = None
    error: dict[str, str] | None = None
    runner: asyncio.Task[None] | None = None

    def touch(self, message: str | None = None) -> None:
        self.last_updated_at = utc_now()
        if message is not None:
            self.status_message = message


class VisualMapTaskManager:
    def __init__(self) -> None:
        self.tasks: dict[str, VisualMapTask] = {}

    def new_task_id(self) -> str:
        while True:
            task_id = f"vismap_{secrets.token_urlsafe(7)}"
            if task_id not in self.tasks:
                return task_id

    def get(self, task_id: str) -> VisualMapTask:
        if not isinstance(task_id, str) or not task_id or task_id not in self.tasks:
            raise AgentApiError("VISUAL_MAP_TASK_NOT_FOUND", "The requested visual-map task does not exist.")
        return self.tasks[task_id]

    def snapshot(self, task: VisualMapTask) -> dict[str, Any]:
        document: dict[str, Any] = {
            "taskId": task.task_id, "status": task.status, "statusMessage": task.status_message,
            "phase": task.phase, "progressPercent": task.progress_percent,
            "completedFrames": task.completed_frames, "totalFrames": task.total_frames,
            "completedMaps": task.completed_maps, "totalMaps": task.total_maps,
            "createdAt": task.created_at, "lastUpdatedAt": task.last_updated_at,
            "pollIntervalMs": TASK_POLL_INTERVAL_MS,
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
        task.touch("Visual-map cancellation requested.")
        if task.runner is not None and not task.runner.done():
            task.runner.cancel()

    async def create(self, payload: Any) -> dict[str, Any]:
        options = visual_map_options(payload)
        WorkspacePathResolver().resolve_existing(options["workspacePath"], field_name="workspacePath", expected_type="file")
        now = utc_now()
        task = VisualMapTask(self.new_task_id(), options, now, now)
        self.tasks[task.task_id] = task
        task.runner = asyncio.create_task(self.run(task), name=f"researchtube-visual-map-{task.task_id}")
        return self.snapshot(task)

    def update_progress(self, task: VisualMapTask, phase: str, percentage: float, message: str, completed_frames: int, total_frames: int, completed_maps: int, total_maps: int) -> None:
        task.phase, task.progress_percent = phase, max(0.0, min(100.0, percentage))
        task.completed_frames, task.total_frames = completed_frames, total_frames
        task.completed_maps, task.total_maps = completed_maps, total_maps
        task.touch(message)

    async def run(self, task: VisualMapTask) -> None:
        try:
            result = await media_create_visual_map(task.payload, lambda *update: self.update_progress(task, *update))
            task.result, task.status, task.phase, task.progress_percent = result, "completed", "completed", 100.0
            task.touch("Visual map completed.")
        except AgentApiError as error:
            task.status, task.phase = "failed", "failed"
            task.error = {"code": error.code, "message": error.message}
            task.touch("Visual map failed.")
        except asyncio.CancelledError:
            task.status, task.phase = "cancelled", "cancelled"
            task.touch("Visual-map task cancelled.")
            raise
        except Exception as error:
            log(f"visual-map task {task.task_id} failed unexpectedly: {error.__class__.__name__}", error=True)
            task.status, task.phase = "failed", "failed"
            task.error = {"code": "VISUAL_MAP_INTERNAL_ERROR", "message": "The visual-map task encountered an unexpected error."}
            task.touch("Visual map failed.")

    async def shutdown(self) -> None:
        runners = [task.runner for task in self.tasks.values() if task.runner is not None and not task.runner.done()]
        for runner in runners:
            runner.cancel()
        if runners:
            await asyncio.gather(*runners, return_exceptions=True)


VISUAL_MAP_TASKS = VisualMapTaskManager()


def camera_public_device(device: CameraDevice) -> dict[str, Any]:
    video_modes: dict[str, dict[str, int | float]] = {}
    available: dict[str, CameraMode] = {}
    for mode in device.modes:
        if mode.fps is None or not CAMERA_MIN_ADVERTISED_FPS < mode.fps <= CAMERA_MAX_ADVERTISED_FPS:
            continue
        key = camera_fps_key(mode.fps)
        current = available.get(key)
        if current is None or (mode.width * mode.height, mode.width, mode.height) > (current.width * current.height, current.width, current.height):
            available[key] = mode
    for key, mode in sorted(available.items(), key=lambda item: item[1].fps or 0.0):
        video_modes[key] = {"width": mode.width, "height": mode.height, "fps": mode.fps}
    return {
        "cameraId": device.camera_id,
        "name": device.name,
        "videoModes": video_modes,
    }


def select_camera_mode(modes: tuple[CameraMode, ...]) -> CameraMode | None:
    """Prefer responsive camera modes before raw pixel count.

    A nominal 60 fps mode is preferred first, then nominal 30 fps, and only
    then progressively lower frame rates.  A small tolerance accepts device
    reports such as 60.0002 fps.  Within the selected FPS band, use the largest
    available resolution.
    """
    if not modes:
        return None
    with_fps = [mode for mode in modes if mode.fps is not None]
    if not with_fps:
        return max(modes, key=lambda mode: (mode.width * mode.height, mode.width, mode.height))
    for target in CAMERA_AUTO_TARGET_FPS:
        mode = camera_mode_for_target_fps(modes, target)
        if mode is not None:
            return mode
    recording_modes = [mode for mode in with_fps if CAMERA_MIN_ADVERTISED_FPS < (mode.fps or 0.0) <= CAMERA_MAX_ADVERTISED_FPS]
    if recording_modes:
        with_fps = recording_modes
    highest_fps = max(mode.fps or 0.0 for mode in with_fps)
    band = [mode for mode in with_fps if mode.fps is not None and mode.fps >= highest_fps - 0.5]
    return max(band, key=lambda mode: (mode.width * mode.height, mode.width, mode.height, mode.fps or 0.0))


def camera_fps_key(fps: float) -> str:
    return f"{fps:.3f}".rstrip("0").rstrip(".")


def camera_mode_for_target_fps(modes: tuple[CameraMode, ...], target_fps: float) -> CameraMode | None:
    """Choose the largest native mode close to the requested recording rate."""
    candidates = [
        mode for mode in modes
        if mode.fps is not None and CAMERA_MIN_ADVERTISED_FPS < mode.fps <= CAMERA_MAX_ADVERTISED_FPS and abs(mode.fps - target_fps) <= CAMERA_TARGET_FPS_TOLERANCE
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda mode: (mode.width * mode.height, mode.width, mode.height, -(abs((mode.fps or 0.0) - target_fps))))


async def camera_ffmpeg_lines(command: list[str], *, operation: str) -> list[str]:
    """Run an internal FFmpeg camera command; keep its output for parsing only."""
    try:
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=CAMERA_CAPTURE_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        log(f"camera ffmpeg {operation} timed out", error=True)
        try:
            process.kill()
            await process.communicate()
        except (OSError, ProcessLookupError):
            pass
        return []
    except OSError as error:
        log(f"camera ffmpeg {operation} could not start: {error.__class__.__name__}", error=True)
        return []
    lines = camera_log_ffmpeg_output(operation, process.returncode, stdout, stderr)
    return lines


def camera_log_ffmpeg_output(operation: str, returncode: int | None, stdout: bytes | None, stderr: bytes | None) -> list[str]:
    lines = ((stdout or b"") + b"\n" + (stderr or b"")).decode("utf-8", errors="replace").splitlines()
    # FFmpeg diagnostics are intentionally not mirrored to the Agent console.
    # They are verbose and implementation-specific; the Agent's own endpoint
    # result/error is the concise diagnostic surface.
    return lines


def camera_modes_from_lines(lines: list[str]) -> tuple[CameraMode, ...]:
    found: dict[tuple[int, int, float | None], CameraMode] = {}
    for line in lines:
        for match in re.finditer(r"(?<!\d)(\d{2,5})x(\d{2,5})(?:[^\d]+(?:@|fps[= ]?)(\d+(?:\.\d+)?))?", line, re.IGNORECASE):
            width, height = int(match.group(1)), int(match.group(2))
            if width < 32 or height < 32 or width > 16384 or height > 16384:
                continue
            fps = float(match.group(3)) if match.group(3) else None
            found[(width, height, fps)] = CameraMode(width, height, fps)
    return tuple(sorted(found.values(), key=lambda mode: (mode.width * mode.height, mode.fps or 0.0), reverse=True))


async def enumerate_camera_candidates(ffmpeg_executable: str) -> list[tuple[str, str, str, str | None]]:
    """Return video camera details and its matching audio input when discoverable."""
    system = platform.system()
    if system == "Windows":
        lines = await camera_ffmpeg_lines([ffmpeg_executable, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], operation="list-dshow-devices")
        video_entries: list[tuple[str, str]] = []
        audio_entries: list[tuple[str, str]] = []
        kind: str | None = None
        friendly: str | None = None
        for line in lines:
            lower = line.lower()
            if "directshow video devices" in lower:
                kind = "video"
                continue
            if "directshow audio devices" in lower:
                kind = "audio"
                continue
            quoted = re.findall(r'"([^"]+)"', line)
            if not quoted:
                continue
            value = quoted[-1]
            # FFmpeg 9 prints individual entries as `"name" (video)` / `(audio)`
            # without the older DirectShow section headings.  Support both
            # layouts.
            if "(video)" in lower:
                kind, friendly = "video", value
                continue
            if "(audio)" in lower:
                kind, friendly = "audio", value
                continue
            if "alternative name" in lower and kind is not None and friendly is not None:
                (video_entries if kind == "video" else audio_entries).append((friendly, value))
                friendly = None
            elif kind is not None and "alternative name" not in lower:
                friendly = value
        if friendly is not None and kind is not None:
            (video_entries if kind == "video" else audio_entries).append((friendly, friendly))
        def matching_audio(video_name: str) -> str | None:
            normalized = video_name.casefold()
            matches = [identity for name, identity in audio_entries if normalized in name.casefold()]
            return matches[0] if matches else None
        return [("dshow", name, identity, matching_audio(name)) for name, identity in video_entries]
    if system == "Darwin":
        lines = await camera_ffmpeg_lines([ffmpeg_executable, "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], operation="list-avfoundation-devices")
        candidates = []
        in_video = False
        for line in lines:
            lower = line.lower()
            if "avfoundation video devices" in lower:
                in_video = True
                continue
            if "avfoundation audio devices" in lower:
                break
            if not in_video:
                continue
            match = re.search(r"\[(\d+)\]\s+(.+)$", line)
            if match:
                candidates.append(("avfoundation", match.group(2).strip(), match.group(1), None))
        return candidates
    candidates = []
    try:
        for item in sorted(Path("/dev").glob("video*"), key=lambda path: path.name):
            if not re.fullmatch(r"video\d+", item.name):
                continue
            name_path = Path("/sys/class/video4linux") / item.name / "name"
            try:
                name = name_path.read_text(encoding="utf-8", errors="replace").strip() or "Camera"
            except OSError:
                name = "Camera"
            candidates.append(("v4l2", name, str(item), None))
    except OSError:
        pass
    return candidates


def camera_input_arguments(device: CameraDevice, mode: CameraMode | None = None, *, include_audio: bool = False) -> list[str]:
    mode = mode or device.selected_mode
    if mode is None:
        raise AgentApiError("CAMERA_CAPABILITIES_UNAVAILABLE", "The selected camera does not expose a usable video mode.")
    arguments: list[str]
    if device.backend == "dshow":
        arguments = ["-f", "dshow", "-video_size", f"{mode.width}x{mode.height}"]
        if mode.fps is not None:
            arguments.extend(["-framerate", f"{mode.fps:g}"])
        source = f"video={device.native_identity}"
        if include_audio:
            if not device.audio_identity:
                raise AgentApiError("CAMERA_AUDIO_NOT_AVAILABLE", "This camera has no matching microphone available for recording.")
            source += f":audio={device.audio_identity}"
        return [*arguments, "-i", source]
    if device.backend == "avfoundation":
        arguments = ["-f", "avfoundation", "-video_size", f"{mode.width}x{mode.height}"]
        if mode.fps is not None:
            arguments.extend(["-framerate", f"{mode.fps:g}"])
        return [*arguments, "-i", f"{device.native_identity}:none"]
    arguments = ["-f", "v4l2", "-video_size", f"{mode.width}x{mode.height}"]
    if mode.fps is not None:
        arguments.extend(["-framerate", f"{mode.fps:g}"])
    if include_audio:
        raise AgentApiError("CAMERA_AUDIO_NOT_AVAILABLE", "This platform does not expose a matching camera microphone for recording.")
    return [*arguments, "-i", device.native_identity]


async def camera_modes(ffmpeg_executable: str, backend: str, identity: str) -> tuple[CameraMode, ...]:
    if backend == "dshow":
        command = [ffmpeg_executable, "-hide_banner", "-list_options", "true", "-f", "dshow", "-i", f"video={identity}"]
    elif backend == "avfoundation":
        command = [ffmpeg_executable, "-hide_banner", "-f", "avfoundation", "-list_formats", "all", "-i", f"{identity}:none"]
    else:
        command = [ffmpeg_executable, "-hide_banner", "-f", "v4l2", "-list_formats", "all", "-i", identity]
    return camera_modes_from_lines(await camera_ffmpeg_lines(command, operation=f"list-{backend}-modes"))


async def camera_devices() -> list[CameraDevice]:
    ffmpeg = find_component("ffmpeg", COMPONENTS["ffmpeg"][0])
    if ffmpeg.error:
        raise AgentApiError("FFMPEG_DISCOVERY_ERROR", "ffmpeg discovery is ambiguous.")
    if not ffmpeg.executable:
        raise AgentApiError("FFMPEG_NOT_AVAILABLE", "ffmpeg is required for camera operations.")
    discovered: list[CameraDevice] = []
    for backend, name, identity, audio_identity in await enumerate_camera_candidates(ffmpeg.executable):
        key = (backend, identity)
        modes = await camera_modes(ffmpeg.executable, backend, identity)
        device = CAMERA_DEVICES_BY_NATIVE.get(key)
        if device is None:
            camera_id = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(6))
            device = CameraDevice(camera_id, name, backend, identity, audio_identity, modes, select_camera_mode(modes))
            CAMERA_DEVICES_BY_NATIVE[key] = device
        else:
            device.name, device.audio_identity, device.modes, device.selected_mode = name, audio_identity, modes, select_camera_mode(modes)
        discovered.append(device)
    return discovered


async def camera_device(camera_id: Any) -> CameraDevice:
    if not isinstance(camera_id, str) or not camera_id:
        raise AgentApiError("CAMERA_INVALID", "cameraId must be a non-empty camera identifier.")
    devices = await camera_devices()
    device = next((item for item in devices if item.camera_id == camera_id), None)
    if device is None:
        raise AgentApiError("CAMERA_NOT_FOUND", "The requested camera is not available. Call camera_list and choose a current cameraId.")
    return device


def new_camera_task_id() -> str:
    """Create the compact camera session/task identifier used in filenames."""
    return f"cam_{secrets.token_urlsafe(7)}"


def camera_filename_timestamp() -> str:
    """Return a Windows-safe ISO-8601 UTC timestamp (colons become underscores)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H_%M_%SZ")


def camera_filename_stem(camera_name: str, task_id: str) -> str:
    name = re.sub(r'[\x00-\x1f<>:"/\\|?*]+', " ", camera_name)
    name = re.sub(r"\s+", " ", name).strip(" .")[:160].rstrip(" .") or "Camera"
    return f"{name} {camera_filename_timestamp()} [{task_id}]"


def camera_capture_default_path(camera_name: str, task_id: str, extension: str) -> str:
    return f"captures/{camera_filename_stem(camera_name, task_id)}.{extension}"


def camera_recording_default_path(camera_name: str, task_id: str, extension: str = "mp4") -> str:
    return f"webcamera/{camera_filename_stem(camera_name, task_id)}.{extension}"


def camera_audio_recording_default_path(camera_name: str, task_id: str) -> str:
    return f"sound/{camera_filename_stem(camera_name, task_id)}.m4a"


def camera_audio_input_arguments(device: CameraDevice) -> list[str]:
    if device.backend != "dshow" or not device.audio_identity:
        raise AgentApiError("CAMERA_AUDIO_NOT_AVAILABLE", "This camera has no matching microphone available for recording.")
    return ["-f", "dshow", "-i", f"audio={device.audio_identity}"]


def camera_rational(value: Any) -> float | None:
    if not isinstance(value, str) or not re.fullmatch(r"\d+(?:\.\d+)?/\d+(?:\.\d+)?", value):
        return None
    numerator, denominator = value.split("/", 1)
    try:
        result = float(numerator) / float(denominator)
    except (ValueError, ZeroDivisionError):
        return None
    return result if math.isfinite(result) and result > 0 else None


async def camera_recording_metadata(path: Path, ffprobe_executable: str) -> dict[str, Any]:
    command = [ffprobe_executable, "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,avg_frame_rate,nb_frames,duration", "-of", "json", str(path)]
    try:
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, _stderr = await asyncio.wait_for(process.communicate(), timeout=MEDIA_PROBE_TIMEOUT_SECONDS)
    except (asyncio.TimeoutError, OSError) as error:
        raise AgentApiError("CAMERA_RECORD_FAILED", "ffprobe could not inspect the camera recording.") from error
    if process.returncode != 0:
        raise AgentApiError("CAMERA_RECORD_FAILED", "ffprobe could not inspect the camera recording.")
    try:
        document = json.loads(stdout.decode("utf-8"))
        streams = document["streams"]
        duration = float(document["format"]["duration"])
    except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AgentApiError("CAMERA_RECORD_FAILED", "ffprobe returned invalid camera recording metadata.") from error
    if not math.isfinite(duration) or duration < 0 or not isinstance(streams, list):
        raise AgentApiError("CAMERA_RECORD_FAILED", "ffprobe returned invalid camera recording metadata.")
    video = next((stream for stream in streams if isinstance(stream, dict) and stream.get("codec_type") == "video"), None)
    audio = next((stream for stream in streams if isinstance(stream, dict) and stream.get("codec_type") == "audio"), None)
    result: dict[str, Any] = {"durationSeconds": duration, "hasAudio": audio is not None}
    if video is not None:
        width, height = ffprobe_integer(video.get("width")), ffprobe_integer(video.get("height"))
        stream_duration = float(video.get("duration")) if str(video.get("duration", "")).strip() else duration
        frame_count = ffprobe_integer(video.get("nb_frames"))
        fps = frame_count / stream_duration if frame_count is not None and stream_duration > 0 else camera_rational(video.get("avg_frame_rate"))
        if width is None or height is None or fps is None:
            raise AgentApiError("CAMERA_RECORD_FAILED", "ffprobe returned incomplete video recording metadata.")
        result.update({"width": width, "height": height, "fps": fps})
    return result


def camera_encoder_arguments(image_format: str) -> tuple[list[str], str]:
    if image_format == "png":
        return ["-c:v", "png", "-compression_level", "6"], "image/png"
    if image_format == "jpeg":
        return ["-c:v", "mjpeg", "-q:v", "3"], "image/jpeg"
    return ["-c:v", "libwebp", "-q:v", "85"], "image/webp"


async def camera_capture_frame(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) - {"cameraId", "targetPath", "targetFormat"}:
        raise AgentApiError("CAMERA_CAPTURE_INVALID", "camera_capture_frame accepts cameraId, targetPath, and targetFormat only.")
    device = await camera_device(payload.get("cameraId"))
    image_format = payload.get("targetFormat", "png")
    if not isinstance(image_format, str) or image_format not in {"png", "jpeg", "webp"}:
        raise AgentApiError("CAMERA_CAPTURE_INVALID", "targetFormat must be png, jpeg, or webp.")
    extension = {"png": "png", "jpeg": "jpg", "webp": "webp"}[image_format]
    resolver = WorkspacePathResolver()
    session_id = new_camera_task_id()
    logical_path = payload.get("targetPath", camera_capture_default_path(device.name, session_id, extension))
    destination = resolver.resolve_destination(logical_path, field_name="targetPath", error_code="WORKSPACE_PATH_INVALID")
    if destination.physical_path.suffix.lower() not in ({"png": {".png"}, "jpeg": {".jpg", ".jpeg"}, "webp": {".webp"}}[image_format]):
        raise AgentApiError("CAMERA_CAPTURE_INVALID", "targetPath extension must match targetFormat.")
    if destination.physical_path.exists() or destination.physical_path.is_symlink():
        raise AgentApiError("DESTINATION_EXISTS", "The camera frame destination already exists; this tool never overwrites files.")
    destination.physical_path.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = find_component("ffmpeg", COMPONENTS["ffmpeg"][0])
    assert ffmpeg.executable
    encoder, mime_type = camera_encoder_arguments(image_format)
    command = [ffmpeg.executable, "-hide_banner", "-nostdin", "-v", "info", *camera_input_arguments(device), "-frames:v", "1", *encoder, "-y", str(destination.physical_path)]
    try:
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=CAMERA_CAPTURE_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as error:
        process.kill(); await process.communicate()
        raise AgentApiError("CAMERA_CAPTURE_FAILED", "Timed out while capturing the camera frame.") from error
    except OSError as error:
        raise AgentApiError("CAMERA_CAPTURE_FAILED", "ffmpeg could not start camera capture.") from error
    camera_log_ffmpeg_output("capture-frame", process.returncode, stdout, stderr)
    if process.returncode != 0 or not destination.physical_path.is_file():
        destination.physical_path.unlink(missing_ok=True)
        raise AgentApiError("CAMERA_CAPTURE_FAILED", "ffmpeg could not capture a frame from the camera.")
    mode = device.selected_mode
    assert mode is not None
    result = {"cameraId": device.camera_id, "taskId": session_id, "workspacePath": destination.logical_path, "format": image_format, "mimeType": mime_type, "width": mode.width, "height": mode.height, "imageSizeBytes": destination.physical_path.stat().st_size}
    log(f"camera_capture_frame cameraId={device.camera_id} -> {destination.logical_path}")
    return result


@dataclass
class CameraRecordTask:
    task_id: str
    camera_id: str
    recording_kind: str
    requested_duration_seconds: int
    target_fps: float | None
    created_at: str
    last_updated_at: str
    status: str = "working"
    phase: str = "starting"
    status_message: str = "Starting camera recording."
    progress_percent: float = 0.0
    elapsed_seconds: float = 0.0
    started_monotonic: float | None = None
    stopped_early: bool = False
    result: dict[str, Any] | None = None
    error: dict[str, str] | None = None
    process: asyncio.subprocess.Process | None = None
    runner: asyncio.Task[None] | None = None

    def touch(self, message: str | None = None) -> None:
        self.last_updated_at = utc_now()
        if message is not None:
            self.status_message = message


class CameraRecordTaskManager:
    def __init__(self) -> None:
        self.tasks: dict[str, CameraRecordTask] = {}

    def get(self, task_id: Any) -> CameraRecordTask:
        if not isinstance(task_id, str) or task_id not in self.tasks:
            raise AgentApiError("CAMERA_RECORD_TASK_NOT_FOUND", "The requested camera recording task does not exist.")
        return self.tasks[task_id]

    def new_task_id(self) -> str:
        while True:
            task_id = new_camera_task_id()
            if task_id not in self.tasks and task_id not in TASKS.tasks:
                return task_id

    def snapshot(self, task: CameraRecordTask) -> dict[str, Any]:
        if task.status in {"working", "stopping"} and task.started_monotonic is not None:
            task.elapsed_seconds = min(float(task.requested_duration_seconds), max(0.0, time.monotonic() - task.started_monotonic))
            if task.status == "working" and task.phase == "recording":
                task.progress_percent = min(99.0, task.elapsed_seconds * 100.0 / task.requested_duration_seconds)
        document: dict[str, Any] = {"taskId": task.task_id, "recordingKind": task.recording_kind, "status": task.status, "phase": task.phase, "statusMessage": task.status_message, "progressPercent": task.progress_percent, "elapsedSeconds": task.elapsed_seconds, "requestedDurationSeconds": task.requested_duration_seconds, "targetFps": task.target_fps, "maxDurationSeconds": 600 if task.recording_kind == "audio" else CAMERA_RECORD_MAX_DURATION_SECONDS, "createdAt": task.created_at, "lastUpdatedAt": task.last_updated_at, "pollIntervalMs": TASK_POLL_INTERVAL_MS}
        if task.result is not None:
            document["result"] = task.result
        if task.error is not None:
            document["error"] = task.error
        return document

    async def create(self, payload: Any, *, recording_kind: str = "video") -> dict[str, Any]:
        allowed = {"cameraId", "durationSeconds", "targetFps"} if recording_kind == "video" else {"cameraId", "durationSeconds"}
        tool_name = "camera_record_video" if recording_kind == "video" else "camera_record_audio"
        maximum = CAMERA_RECORD_MAX_DURATION_SECONDS if recording_kind == "video" else 600
        if not isinstance(payload, dict) or set(payload) - allowed:
            raise AgentApiError("CAMERA_RECORD_INVALID", f"{tool_name} accepts only documented fields.")
        duration = payload.get("durationSeconds")
        if not isinstance(duration, int) or isinstance(duration, bool) or not 1 <= duration <= maximum:
            raise AgentApiError("CAMERA_RECORD_INVALID", f"durationSeconds must be an integer from 1 to {maximum}.")
        requested_fps = payload.get("targetFps")
        if recording_kind == "video" and requested_fps is not None and (not isinstance(requested_fps, (int, float)) or isinstance(requested_fps, bool) or not CAMERA_MIN_ADVERTISED_FPS < float(requested_fps) <= CAMERA_MAX_ADVERTISED_FPS):
            raise AgentApiError("CAMERA_RECORD_INVALID", "targetFps, when supplied, must be a number greater than 25 and no greater than 120.")
        for task in self.tasks.values():
            if task.camera_id == payload.get("cameraId") and task.status in {"working", "stopping"}:
                raise AgentApiError("CAMERA_BUSY", "That camera already has an active recording task.")
        device = await camera_device(payload.get("cameraId"))
        mode = camera_mode_for_target_fps(device.modes, float(requested_fps)) if requested_fps is not None else select_camera_mode(device.modes)
        if recording_kind == "video" and (mode is None or mode.fps is None):
            label = f"{requested_fps} FPS" if requested_fps is not None else "a usable recording mode"
            raise AgentApiError("CAMERA_MODE_NOT_AVAILABLE", f"This camera does not provide {label}. Call camera_list and choose an advertised videoModes rate.")
        now = utc_now()
        if recording_kind == "audio" and not device.audio_identity:
            raise AgentApiError("CAMERA_AUDIO_NOT_AVAILABLE", "This camera has no matching microphone available for recording.")
        # Audio-only recording has no video mode. Keep targetFps null in its
        # public task document; selecting a mode above is only needed for the
        # video branch and must not leak into the audio contract.
        task = CameraRecordTask(self.new_task_id(), payload["cameraId"], recording_kind, duration, mode.fps if recording_kind == "video" and mode is not None else None, now, now)
        self.tasks[task.task_id] = task
        task.runner = asyncio.create_task(self.run(task), name=f"researchtube-camera-record-{task.task_id}")
        return self.snapshot(task)

    async def stop(self, task_id: Any) -> dict[str, Any]:
        task = self.get(task_id)
        if task.status != "working":
            return {"taskId": task.task_id, "accepted": False, "message": "The camera recording task is already terminal."}
        task.stopped_early, task.status, task.phase = True, "stopping", "finalizing"
        task.touch("Stopping camera recording.")
        if task.process is not None and task.process.stdin is not None:
            try:
                # FFmpeg's interactive command reader accepts a single `q`.
                # Do not add a newline: it can remain buffered behind a live
                # DirectShow source and postpone the graceful trailer write.
                task.process.stdin.write(b"q")
                await task.process.stdin.drain()
            except (ConnectionError, OSError):
                pass
        return {"taskId": task.task_id, "accepted": True, "message": "Stop request accepted. Poll camera_record_status for completion."}

    async def run(self, task: CameraRecordTask) -> None:
        temporary_path: Path | None = None
        final_path: Path | None = None
        try:
            device = await camera_device(task.camera_id)
            ffmpeg = find_component("ffmpeg", COMPONENTS["ffmpeg"][0])
            ffprobe = find_component("ffprobe", COMPONENTS["ffprobe"][0])
            assert ffmpeg.executable
            assert ffprobe.executable
            resolver = WorkspacePathResolver()
            mode = camera_mode_for_target_fps(device.modes, task.target_fps) if task.target_fps is not None else None
            if task.recording_kind == "video" and mode is None:
                raise AgentApiError("CAMERA_MODE_NOT_AVAILABLE", "This camera no longer provides the requested video recording mode.")
            output_path = camera_recording_default_path(device.name, task.task_id) if task.recording_kind == "video" else camera_audio_recording_default_path(device.name, task.task_id)
            final = resolver.resolve_destination(output_path, field_name="camera recording output", error_code="WORKSPACE_PATH_INVALID")
            final.physical_path.parent.mkdir(parents=True, exist_ok=True)
            final_path = final.physical_path
            temporary_path = final.physical_path.with_suffix(f".tmp{final.physical_path.suffix}")
            if task.recording_kind == "video":
                assert mode is not None
                command = [ffmpeg.executable, "-hide_banner", "-v", "error", *camera_input_arguments(device, mode, include_audio=True), "-t", str(task.requested_duration_seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-y", str(temporary_path)]
            else:
                command = [ffmpeg.executable, "-hide_banner", "-v", "error", *camera_audio_input_arguments(device), "-t", str(task.requested_duration_seconds), "-vn", "-c:a", "aac", "-movflags", "+faststart", "-y", str(temporary_path)]
            task.process = await asyncio.create_subprocess_exec(*command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            task.phase, task.started_monotonic = "recording", time.monotonic()
            task.touch(f"Recording camera {task.recording_kind}.")
            await asyncio.wait_for(task.process.wait(), timeout=task.requested_duration_seconds + CAMERA_CAPTURE_TIMEOUT_SECONDS)
            stderr = await task.process.stderr.read() if task.process.stderr is not None else b""
            camera_log_ffmpeg_output(f"record-video taskId={task.task_id}", task.process.returncode, b"", stderr)
            task.elapsed_seconds = min(float(task.requested_duration_seconds), time.monotonic() - task.started_monotonic)
            if task.process.returncode != 0 or not temporary_path.is_file() or temporary_path.stat().st_size == 0:
                raise AgentApiError("CAMERA_RECORD_FAILED", f"ffmpeg could not record {task.recording_kind} from the camera.")
            task.phase = "finalizing"; task.touch("Finalizing camera recording.")
            temporary_path.replace(final_path)
            metadata = await camera_recording_metadata(final_path, ffprobe.executable)
            if task.recording_kind == "video" and not metadata["hasAudio"]:
                raise AgentApiError("CAMERA_RECORD_FAILED", "The completed camera video has no audio track.")
            task.elapsed_seconds = metadata["durationSeconds"]
            result = {"cameraId": device.camera_id, "filePath": resolver.logical_existing_file(final_path, error_code="CAMERA_RECORD_FAILED"), "format": "mp4" if task.recording_kind == "video" else "m4a", "durationSeconds": metadata["durationSeconds"], **({"stoppedEarly": True} if task.stopped_early else {})}
            if task.recording_kind == "video":
                result.update({"width": metadata["width"], "height": metadata["height"], "fps": metadata["fps"], "hasAudio": True})
            task.result = result
            task.status, task.phase, task.progress_percent = "completed", "completed", 100.0
            task.touch("Camera recording completed.")
            log(f"camera_record_{task.recording_kind} taskId={task.task_id} cameraId={task.camera_id} -> completed")
        except AgentApiError as error:
            task.status, task.phase, task.error = "failed", "failed", {"code": error.code, "message": error.message}
            task.touch("Camera recording failed.")
        except (asyncio.TimeoutError, OSError) as error:
            task.status, task.phase, task.error = "failed", "failed", {"code": "CAMERA_RECORD_FAILED", "message": "Camera recording could not be completed."}
            task.touch("Camera recording failed.")
            log(f"camera recording task {task.task_id} failed: {error.__class__.__name__}", error=True)
        finally:
            task.process = None
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

    async def shutdown(self) -> None:
        for task in self.tasks.values():
            if task.status == "working":
                await self.stop(task.task_id)
        runners = [task.runner for task in self.tasks.values() if task.runner is not None and not task.runner.done()]
        if runners:
            await asyncio.gather(*runners, return_exceptions=True)


CAMERA_RECORD_TASKS = CameraRecordTaskManager()


async def capture_frame_from_workspace_options(options: dict[str, Any]) -> dict[str, Any]:
    item = WorkspacePathResolver().resolve_existing(options["path"], field_name="path", expected_type="file")
    ffmpeg = find_component("ffmpeg", COMPONENTS["ffmpeg"][0])
    ffprobe = find_component("ffprobe", COMPONENTS["ffprobe"][0])
    if ffmpeg.error:
        raise AgentApiError("FFMPEG_DISCOVERY_ERROR", "ffmpeg discovery is ambiguous.", ffmpeg.error)
    if ffprobe.error:
        raise AgentApiError("FFPROBE_DISCOVERY_ERROR", "ffprobe discovery is ambiguous.", ffprobe.error)
    if not ffmpeg.executable:
        raise AgentApiError("FFMPEG_NOT_AVAILABLE", "ffmpeg is not available. Extract it under tools/ffmpeg or install it on PATH.")
    if not ffprobe.executable:
        raise AgentApiError("FFPROBE_NOT_AVAILABLE", "ffprobe is not available. Extract it under tools/ffmpeg or install it on PATH.")

    streams = await ffprobe_streams(item, ffprobe.executable)
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video" and isinstance(stream.get("index"), int)]
    if not video_streams:
        raise AgentApiError("VIDEO_STREAM_NOT_FOUND", "The workspace media file has no video stream.")
    selected_index = options["videoStreamIndex"]
    if selected_index is None:
        selected_stream = video_streams[0]
    else:
        selected_stream = next((stream for stream in video_streams if stream["index"] == selected_index), None)
        if selected_stream is None:
            raise AgentApiError("VIDEO_STREAM_NOT_FOUND", "videoStreamIndex does not identify a video stream in this file.")
    selected_index = selected_stream["index"]

    output = options["outputPath"]
    destination_path: Path | None = None
    try:
        # A capture is always a normal workspace file.  The widget may display
        # it immediately, but it never owns the only copy of the image.
        resolver = WorkspacePathResolver()
        destination = resolver.resolve_destination(output["path"], field_name="outputPath", error_code="WORKSPACE_PATH_INVALID")
        destination.physical_path.parent.mkdir(parents=True, exist_ok=True)
        # Re-run the resolver after creating parents so redirects cannot be introduced by the parent creation.
        destination = resolver.resolve_destination(destination.logical_path, field_name="outputPath", error_code="WORKSPACE_PATH_INVALID")
        if destination.physical_path.exists() or destination.physical_path.is_symlink():
            raise AgentApiError("CAPTURE_FRAME_DESTINATION_EXISTS", "outputPath already exists; capture_frame never overwrites a workspace file.")
        destination_path = destination.physical_path
        logical_output_path = destination.logical_path

        command = [ffmpeg.executable, "-hide_banner", "-nostdin", "-v", "info"]
        if not options["applyDisplayRotation"]:
            command.append("-noautorotate")
        if options["seekMode"] == "fast":
            command.extend(["-ss", f"{options['timestampSeconds']:.9f}"])
        command.extend(["-i", str(item.physical_path)])
        encoder_args, mime_type = capture_encoder_arguments(options["image"])
        command.extend(["-map", f"0:{selected_index}", "-an", "-frames:v", "1", "-vf", capture_filter(options), *encoder_args, "-y", str(destination_path)])
        try:
            process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            _stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=CAPTURE_FRAME_TIMEOUT_SECONDS)
        except asyncio.TimeoutError as error:
            process.kill()
            await process.communicate()
            raise AgentApiError("CAPTURE_FRAME_FAILED", "ffmpeg timed out while extracting the frame.") from error
        except OSError as error:
            raise AgentApiError("CAPTURE_FRAME_FAILED", "ffmpeg could not be started.") from error
        if process.returncode != 0 or not destination_path.is_file():
            raise AgentApiError("CAPTURE_FRAME_FAILED", "ffmpeg could not extract a frame at the requested timestamp.")
        try:
            image_size = destination_path.stat().st_size
        except OSError as error:
            raise AgentApiError("CAPTURE_FRAME_FAILED", "The extracted image is unavailable.") from error
        output_streams = await ffprobe_streams_for_file(destination_path, ffprobe.executable)
        output_stream = next((stream for stream in output_streams if stream.get("codec_type") == "video"), None)
        width = output_stream.get("width") if isinstance(output_stream, dict) else None
        height = output_stream.get("height") if isinstance(output_stream, dict) else None
        if not isinstance(width, int) or not isinstance(height, int):
            raise AgentApiError("CAPTURE_FRAME_FAILED", "ffprobe did not report usable dimensions for the extracted image.")
        rotation_degrees = video_stream_rotation(selected_stream)
        rotation_applied = options["applyDisplayRotation"] and not math.isclose(rotation_degrees % 180, 0.0, abs_tol=0.001)
        result: dict[str, Any] = {
            "sourcePath": item.logical_path,
            "requestedTimestampSeconds": options["timestampSeconds"],
            # Input-side fast seeking normally re-bases timestamps. Its frame
            # is intentionally approximate, so do not report a false absolute PTS.
            "actualTimestampSeconds": showinfo_timestamp(stderr) if options["seekMode"] == "accurate" else None,
            "selectedVideoStreamIndex": selected_index,
            "seekMode": options["seekMode"],
            "displayRotationApplied": rotation_applied,
            "image": {
                "format": options["image"]["format"], "mimeType": mime_type,
                "width": width, "height": height, "imageSizeBytes": image_size,
                "workspacePath": logical_output_path,
            },
        }
        log(f"capture_frame path={item.logical_path} timestamp={options['timestampSeconds']:.3f} -> {logical_output_path}")
        return result
    except AgentApiError:
        if destination_path is not None:
            try:
                destination_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise


def safe_capture_title(value: str) -> str:
    """Make a human-readable, cross-platform-safe filename component."""
    # Preserve all punctuation and Unicode that Windows permits. Invalid
    # filename characters stay visible instead of being silently discarded.
    title = re.sub(r'[\x00-\x1f<>:"/\\|?*]+', "_", value).strip(" .")
    if not title:
        return "YouTube frame"
    if title.split(".", 1)[0].upper() in WINDOWS_RESERVED_BASENAMES:
        title = f"YouTube {title}"
    # Leave room for YouTube, timestamp, and capture-id tags in the same
    # Windows filename component without needlessly truncating the title.
    return title[:190].rstrip(" .") or "YouTube frame"


def youtube_capture_default_workspace_path(title: str, video_id: str, timestamp_seconds: float, image_format: str) -> str:
    timestamp_part = f"{timestamp_seconds:.3f}".replace("-", "_")
    capture_id = secrets.token_urlsafe(6)
    return f"captures/{safe_capture_title(title)} [yt_{video_id}] [t_{timestamp_part}] [cap_{capture_id}].{image_format}"


def youtube_capture_stdout(stdout: bytes) -> tuple[str | None, Path | None]:
    title: str | None = None
    partial_path: Path | None = None
    for raw_line in stdout.decode("utf-8", errors="replace").splitlines():
        if raw_line.startswith("__RESEARCHTUBE_CAPTURE_TITLE__:"):
            title = raw_line.removeprefix("__RESEARCHTUBE_CAPTURE_TITLE__:").strip()
        elif raw_line.startswith("__RESEARCHTUBE_CAPTURE_PARTIAL__:"):
            candidate = raw_line.removeprefix("__RESEARCHTUBE_CAPTURE_PARTIAL__:").strip()
            if candidate:
                partial_path = Path(candidate)
    return title, partial_path


async def capture_youtube_frame(options: dict[str, Any]) -> dict[str, Any]:
    """Download only a small yt-dlp/ffmpeg time section, then extract one frame.

    The signed YouTube media URL and yt-dlp diagnostics stay entirely inside the
    Agent.  The temporary media section is deleted in every outcome.
    """
    youtube = options["youtube"]
    assert isinstance(youtube, dict)
    yt_dlp = find_component("ytDlp", COMPONENTS["ytDlp"][0])
    ffmpeg = find_component("ffmpeg", COMPONENTS["ffmpeg"][0])
    if yt_dlp.error:
        raise AgentApiError("YTDLP_DISCOVERY_ERROR", "yt-dlp discovery is ambiguous.", yt_dlp.error)
    if ffmpeg.error:
        raise AgentApiError("FFMPEG_DISCOVERY_ERROR", "ffmpeg discovery is ambiguous.", ffmpeg.error)
    if not yt_dlp.executable:
        raise AgentApiError("YTDLP_NOT_AVAILABLE", "yt-dlp is not available. Place it in tools/yt-dlp or install it on PATH.")
    if not ffmpeg.executable:
        raise AgentApiError("FFMPEG_NOT_AVAILABLE", "ffmpeg is required for partial YouTube frame capture. Extract it under tools/ffmpeg or install it on PATH.")

    # The browser's player card can advertise a different format set from this
    # local yt-dlp invocation. Confirm the exact numeric ID here, and reject
    # audio-only IDs before starting the partial download.
    local_formats = (await youtube_download_formats({"videoId": youtube["videoId"]}))["downloadFormats"]
    selectable_video_ids = {
        entry["formatId"] for kind in ("combined", "video") for entry in local_formats.get(kind, [])
        if isinstance(entry, dict) and isinstance(entry.get("formatId"), str)
    }
    if youtube["formatId"] not in selectable_video_ids:
        raise AgentApiError("CAPTURE_VIDEO_FORMAT_NOT_AVAILABLE", "youtube.formatId must be a currently available video or combined format from youtube_download_get_formats.")

    timestamp = options["timestampSeconds"]
    section_start = max(0.0, timestamp - YOUTUBE_CAPTURE_PRE_ROLL_SECONDS)
    section_end = timestamp + YOUTUBE_CAPTURE_POST_ROLL_SECONDS
    capture_token = secrets.token_urlsafe(8)
    resolver = WorkspacePathResolver()
    temporary_directory = resolver.resolve_destination(".researchtube-capture-tmp", field_name="temporary directory", error_code="WORKSPACE_PATH_INVALID")
    temporary_directory.physical_path.mkdir(parents=True, exist_ok=True)
    temporary_directory = resolver.resolve_destination(temporary_directory.logical_path, field_name="temporary directory", error_code="WORKSPACE_PATH_INVALID")
    output_template = f"partial [yt_%(id)s] [cap_{capture_token}].%(ext)s"
    command = [
        yt_dlp.executable, *yt_dlp_youtube_arguments(resolve_deno_runtime()), "--ignore-config", "--no-playlist", "--no-part", "--encoding", "utf-8",
        # Do not use --windows-filenames here: yt-dlp also applies it to the
        # %(title)s value printed below, which would discard Cyrillic before
        # safe_capture_title can make the final Windows-safe filename. The
        # temporary template is already ASCII-only.
        "--download-sections", f"*{section_start:.3f}-{section_end:.3f}", "--downloader", "ffmpeg",
        "--ffmpeg-location", str(Path(ffmpeg.executable).parent), "--format", youtube["formatId"],
        "--paths", str(temporary_directory.physical_path), "--output", output_template,
        "--print", "before_dl:__RESEARCHTUBE_CAPTURE_TITLE__:%(title)s",
        "--print", "after_move:__RESEARCHTUBE_CAPTURE_PARTIAL__:%(filepath)s",
        f"https://www.youtube.com/watch?v={youtube['videoId']}",
    ]
    partial_item: ResolvedWorkspacePath | None = None
    try:
        try:
            process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=YOUTUBE_CAPTURE_FRAME_TIMEOUT_SECONDS)
        except asyncio.TimeoutError as error:
            process.kill()
            await process.communicate()
            raise AgentApiError("YOUTUBE_CAPTURE_FRAME_FAILED", "yt-dlp timed out while downloading the short frame section.") from error
        except OSError as error:
            raise AgentApiError("YOUTUBE_CAPTURE_FRAME_FAILED", "yt-dlp could not be started for partial frame capture.") from error
        if process.returncode != 0:
            if b"requested format is not available" in stderr.lower():
                raise AgentApiError("FORMAT_NOT_AVAILABLE", "The selected YouTube format is not available to local yt-dlp.")
            raise AgentApiError("YOUTUBE_CAPTURE_FRAME_FAILED", "yt-dlp could not download the short video section needed for this frame.")
        title, partial_path = youtube_capture_stdout(stdout)
        if partial_path is None:
            raise AgentApiError("YOUTUBE_CAPTURE_FRAME_FAILED", "yt-dlp completed without reporting the temporary video section.")
        if not partial_path.is_absolute():
            partial_path = temporary_directory.physical_path / partial_path
        partial_item = resolver.resolve_existing(resolver.logical_existing_file(partial_path, error_code="YOUTUBE_CAPTURE_FRAME_FAILED"), field_name="path", expected_type="file")
        local_options = dict(options)
        local_options["path"] = partial_item.logical_path
        local_options["youtube"] = None
        local_options["timestampSeconds"] = timestamp - section_start
        local_options["videoStreamIndex"] = None
        if not options["outputPath"]["provided"]:
            local_options["outputPath"] = dict(options["outputPath"])
            local_options["outputPath"]["path"] = youtube_capture_default_workspace_path(title or "YouTube frame", youtube["videoId"], timestamp, options["image"]["format"])
        result = await capture_frame_from_workspace_options(local_options)
        result["sourcePath"] = f"youtube:{youtube['videoId']}"
        result["sourceVideoId"] = youtube["videoId"]
        result["sourceVideoFormatId"] = youtube["formatId"]
        result["sourceTitle"] = title or "YouTube video"
        result["requestedTimestampSeconds"] = timestamp
        actual = result.get("actualTimestampSeconds")
        result["actualTimestampSeconds"] = section_start + actual if isinstance(actual, (int, float)) else None
        result["partialDownload"] = {"startSeconds": section_start, "endSeconds": section_end}
        log(f"capture_frame youtube={youtube['videoId']} format={youtube['formatId']} timestamp={timestamp:.3f} -> {result['image']['workspacePath']}")
        return result
    finally:
        if partial_item is not None:
            try:
                partial_item.physical_path.unlink(missing_ok=True)
            except OSError:
                pass
        try:
            temporary_directory.physical_path.rmdir()
        except OSError:
            pass


async def capture_frame(payload: Any) -> dict[str, Any]:
    options = capture_frame_options(payload)
    if options["youtube"] is not None:
        return await capture_youtube_frame(options)
    return await capture_frame_from_workspace_options(options)


def youtube_capture_sections(timestamps: list[float]) -> list[tuple[float, float, list[float]]]:
    """Group nearby frame windows without creating an oversized partial download."""
    sections: list[tuple[float, float, list[float]]] = []
    for timestamp in timestamps:
        start, end = max(0.0, timestamp - YOUTUBE_CAPTURE_PRE_ROLL_SECONDS), timestamp + YOUTUBE_CAPTURE_POST_ROLL_SECONDS
        if sections and start <= sections[-1][1] + YOUTUBE_CAPTURE_SECTION_MERGE_GAP_SECONDS and end - sections[-1][0] <= YOUTUBE_CAPTURE_MAX_SECTION_SECONDS:
            previous_start, previous_end, points = sections[-1]
            sections[-1] = (previous_start, max(previous_end, end), [*points, timestamp])
        else:
            sections.append((start, end, [timestamp]))
    return sections


def youtube_capture_many_stdout(stdout: bytes) -> tuple[str | None, list[Path]]:
    title: str | None = None
    paths: list[Path] = []
    for raw_line in stdout.decode("utf-8", errors="replace").splitlines():
        if raw_line.startswith("__RESEARCHTUBE_CAPTURE_TITLE__:"):
            title = raw_line.removeprefix("__RESEARCHTUBE_CAPTURE_TITLE__:").strip() or title
        elif raw_line.startswith("__RESEARCHTUBE_CAPTURE_PARTIAL__:"):
            value = raw_line.removeprefix("__RESEARCHTUBE_CAPTURE_PARTIAL__:").strip()
            if value:
                paths.append(Path(value))
    return title, paths


def sanitized_ytdlp_diagnostic_lines(stdout: bytes | None, stderr: bytes | None) -> list[str]:
    """Return bounded yt-dlp output without signed URLs, tokens, or host paths."""
    text = ((stdout or b"") + b"\n" + (stderr or b"")).decode("utf-8", errors="replace")
    lines: list[str] = []
    for raw_line in text.splitlines():
        # Signed googlevideo URLs can contain short-lived access signatures and
        # PO Tokens; diagnostic output must never export either one.
        line = re.sub(r"https?://[^\s'\"]+", "[redacted URL]", raw_line)
        line = re.sub(r"(?i)\b(?:pot|po_token|signature|sig|lsig)=[^\s&]+", "[redacted token]", line)
        line = re.sub(r"(?:[A-Za-z]:\\|/)[^\s'\"]+", "[private path]", line)
        line = line.strip()
        if line:
            lines.append(line[:MAX_DIAGNOSTIC_LINE_LENGTH])
    return lines[-MAX_DIAGNOSTIC_LINES:]


_YTDLP_DOWNLOAD_PERCENT_RE = re.compile(rb"\[download\]\s+(\d+(?:\.\d+)?)%")
_FFMPEG_DOWNLOAD_TIME_RE = re.compile(rb"\btime=(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)")


def youtube_section_download_progress(line: bytes, section_duration_seconds: float) -> float | None:
    """Extract a bounded approximate section-download percentage from tool output."""
    match = _YTDLP_DOWNLOAD_PERCENT_RE.search(line)
    if match:
        return min(100.0, max(0.0, float(match.group(1))))
    match = _FFMPEG_DOWNLOAD_TIME_RE.search(line)
    if not match or section_duration_seconds <= 0:
        return None
    hours, minutes, seconds = match.groups()
    elapsed = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    return min(100.0, max(0.0, elapsed * 100.0 / section_duration_seconds))


def youtube_section_expected_bytes(format_record: dict[str, Any] | None, section_duration_seconds: float) -> int | None:
    """Estimate a partial-range size from yt-dlp's advertised source bitrate."""
    if not isinstance(format_record, dict) or section_duration_seconds <= 0:
        return None
    bitrate = format_record.get("bitrateBps")
    if isinstance(bitrate, bool) or not isinstance(bitrate, int) or bitrate <= 0:
        return None
    return max(1, math.ceil(bitrate * section_duration_seconds / 8.0))


def youtube_section_written_bytes(directory: Path, section_index: int) -> int:
    """Read bytes currently written for one ASCII-only temporary section name."""
    prefix = f"partial [section_{section_index:03d}]."
    total = 0
    try:
        for candidate in directory.iterdir():
            if candidate.is_file() and candidate.name.startswith(prefix):
                try:
                    total += candidate.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


async def collect_process_output_with_progress(
    process: Any, *, timeout_seconds: float, on_line: Callable[[bytes], None] | None = None,
) -> tuple[bytes, bytes]:
    """Drain both subprocess streams while exposing newline/carriage-return progress updates.

    A small fallback keeps the lightweight fake process objects used by unit tests
    compatible with the real asyncio subprocess implementation.
    """
    stdout_stream, stderr_stream = getattr(process, "stdout", None), getattr(process, "stderr", None)
    if stdout_stream is None or stderr_stream is None or not hasattr(process, "wait"):
        return await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)

    async def drain(stream: asyncio.StreamReader, chunks: list[bytes]) -> None:
        pending = b""
        while chunk := await stream.read(4096):
            chunks.append(chunk)
            pending += chunk
            pieces = re.split(rb"[\r\n]+", pending)
            pending = pieces.pop()
            if on_line is not None:
                for piece in pieces:
                    if piece:
                        on_line(piece)
        if pending and on_line is not None:
            on_line(pending)

    stdout_chunks: list[bytes] = []
    stderr_chunks: list[bytes] = []
    readers = [asyncio.create_task(drain(stdout_stream, stdout_chunks)), asyncio.create_task(drain(stderr_stream, stderr_chunks))]
    try:
        await asyncio.wait_for(process.wait(), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise
    finally:
        await asyncio.gather(*readers, return_exceptions=True)
    return b"".join(stdout_chunks), b"".join(stderr_chunks)


async def capture_youtube_frames(
    options: dict[str, Any], progress: Callable[..., None],
    diagnostics: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    youtube = options["youtube"]
    assert isinstance(youtube, dict)
    yt_dlp, ffmpeg = find_component("ytDlp", COMPONENTS["ytDlp"][0]), find_component("ffmpeg", COMPONENTS["ffmpeg"][0])
    if yt_dlp.error:
        raise AgentApiError("YTDLP_DISCOVERY_ERROR", "yt-dlp discovery is ambiguous.", yt_dlp.error)
    if ffmpeg.error:
        raise AgentApiError("FFMPEG_DISCOVERY_ERROR", "ffmpeg discovery is ambiguous.", ffmpeg.error)
    if not yt_dlp.executable or not ffmpeg.executable:
        raise AgentApiError("YTDLP_NOT_AVAILABLE", "yt-dlp and ffmpeg are required for partial YouTube frame capture.")
    formats = (await youtube_download_formats({"videoId": youtube["videoId"]}))["downloadFormats"]
    available = [entry for kind in ("combined", "video") for entry in formats.get(kind, []) if isinstance(entry, dict) and isinstance(entry.get("formatId"), str)]
    selected_format = next((entry for entry in available if entry["formatId"] == youtube["formatId"]), None)
    if selected_format is None:
        raise AgentApiError("CAPTURE_VIDEO_FORMAT_NOT_AVAILABLE", "youtube.formatId must be a currently available video or combined format from youtube_download_get_formats.")
    sections = youtube_capture_sections(options["timestampsSeconds"])
    deno_executable = resolve_deno_runtime()
    if diagnostics is not None:
        diagnostics["youtube"] = {
            "formatId": youtube["formatId"],
            "sectionCount": len(sections),
            "sections": [{"startSeconds": start, "endSeconds": end, "frameCount": len(points)} for start, end, points in sections],
            "poTokenProvider": youtube_pot_provider_status(deno_executable),
            "ytDlpExitCode": None,
            "output": [],
        }
    resolver = WorkspacePathResolver()
    temporary_directory = resolver.resolve_destination(f".researchtube-capture-tmp/{secrets.token_urlsafe(8)}", field_name="temporary directory", error_code="WORKSPACE_PATH_INVALID")
    temporary_directory.physical_path.mkdir(parents=True, exist_ok=True)
    def record_failed_section(section_index: int, start: float, end: float, timestamps: list[float], attempt_count: int) -> dict[str, Any]:
        section = {"sectionIndex": section_index, "startSeconds": start, "endSeconds": end, "frameCount": len(timestamps), "attemptCount": attempt_count}
        if diagnostics is not None:
            diagnostics["youtube"]["failedSection"] = section
        return section

    try:
        results: list[dict[str, Any]] = []
        total = len(options["timestampsSeconds"])
        title: str | None = None
        # Do not pass multiple --download-sections values to one yt-dlp process.
        # A failure in a late FFmpeg section otherwise discards every earlier
        # section and prevents the task from reporting useful incremental work.
        for section_index, (start, end, timestamps) in enumerate(sections, start=1):
            partial_path: Path | None = None
            section_title: str | None = None
            section_error: AgentApiError | None = None
            expected_section_bytes = youtube_section_expected_bytes(selected_format, end - start)
            for attempt_count in range(1, len(YOUTUBE_CAPTURE_SECTION_RETRY_DELAYS_SECONDS) + 2):
                command = [
                    yt_dlp.executable, *yt_dlp_youtube_arguments(deno_executable), "--verbose", "--newline", "--ignore-config", "--no-playlist", "--no-part", "--encoding", "utf-8",
                    "--download-sections", f"*{start:.3f}-{end:.3f}", "--downloader", "ffmpeg",
                    "--ffmpeg-location", str(Path(ffmpeg.executable).parent), "--format", youtube["formatId"],
                    "--paths", str(temporary_directory.physical_path), "--output", f"partial [section_{section_index:03d}].%(ext)s",
                    "--print", "before_dl:__RESEARCHTUBE_CAPTURE_TITLE__:%(title)s",
                    "--print", "after_move:__RESEARCHTUBE_CAPTURE_PARTIAL__:%(filepath)s",
                    f"https://www.youtube.com/watch?v={youtube['videoId']}",
                ]
                try:
                    process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    file_progress_stopped = asyncio.Event()

                    def report_download_progress(line: bytes) -> None:
                        percent = youtube_section_download_progress(line, end - start)
                        if percent is not None:
                            progress(len(results), total, None, percent, len(timestamps))

                    async def report_partial_file_progress() -> None:
                        # yt-dlp delegates --download-sections to its external
                        # FFmpeg downloader and does not relay that child's
                        # standard progress events. The partial file itself is
                        # the actual download destination, so its growing size
                        # gives us a non-invasive, real transfer indicator.
                        if expected_section_bytes is None:
                            return
                        while not file_progress_stopped.is_set():
                            await asyncio.sleep(YOUTUBE_CAPTURE_FILE_PROGRESS_INTERVAL_SECONDS)
                            written = youtube_section_written_bytes(temporary_directory.physical_path, section_index)
                            if written > 0:
                                percent = min(95.0, written * 100.0 / expected_section_bytes)
                                progress(len(results), total, None, percent, len(timestamps))

                    file_progress = asyncio.create_task(report_partial_file_progress())
                    try:
                        stdout, stderr = await collect_process_output_with_progress(
                            process, timeout_seconds=YOUTUBE_CAPTURE_FRAME_TIMEOUT_SECONDS, on_line=report_download_progress,
                        )
                    finally:
                        file_progress_stopped.set()
                        file_progress.cancel()
                        await asyncio.gather(file_progress, return_exceptions=True)
                except asyncio.TimeoutError as error:
                    process.kill(); await process.communicate()
                    section_error = AgentApiError("YOUTUBE_CAPTURE_FRAME_FAILED", "yt-dlp timed out while downloading a required frame section.")
                except OSError:
                    section_error = AgentApiError("YOUTUBE_CAPTURE_FRAME_FAILED", "yt-dlp could not be started for a partial frame section.")
                else:
                    if diagnostics is not None:
                        diagnostics["youtube"]["ytDlpExitCode"] = process.returncode
                        diagnostics["youtube"]["output"] = sanitized_ytdlp_diagnostic_lines(stdout, stderr)
                    if process.returncode != 0:
                        section_error = AgentApiError("FORMAT_NOT_AVAILABLE" if b"requested format is not available" in stderr.lower() else "YOUTUBE_CAPTURE_FRAME_FAILED", "The selected YouTube format is unavailable." if b"requested format is not available" in stderr.lower() else "yt-dlp could not download a required frame section.")
                    else:
                        section_title, paths = youtube_capture_many_stdout(stdout)
                        if len(paths) == 1:
                            partial_path = paths[0]
                            break
                        section_error = AgentApiError("YOUTUBE_CAPTURE_FRAME_FAILED", "yt-dlp did not return the requested temporary frame section.")
                # A permanently unavailable selected format cannot be repaired by
                # waiting. FFmpeg/transport failures receive two paced retries.
                if section_error.code == "FORMAT_NOT_AVAILABLE" or attempt_count > len(YOUTUBE_CAPTURE_SECTION_RETRY_DELAYS_SECONDS):
                    record_failed_section(section_index, start, end, timestamps, attempt_count)
                    raise section_error
                await asyncio.sleep(YOUTUBE_CAPTURE_SECTION_RETRY_DELAYS_SECONDS[attempt_count - 1])
            title = section_title or title
            assert partial_path is not None
            actual_path = partial_path if partial_path.is_absolute() else temporary_directory.physical_path / partial_path
            try:
                item = resolver.resolve_existing(resolver.logical_existing_file(actual_path, error_code="YOUTUBE_CAPTURE_FRAME_FAILED"), field_name="path", expected_type="file")
            except AgentApiError:
                record_failed_section(section_index, start, end, timestamps, attempt_count)
                raise
            try:
                for timestamp in timestamps:
                    local = dict(options)
                    local.update({"path": item.logical_path, "youtube": None, "timestampSeconds": timestamp - start, "videoStreamIndex": None, "outputPath": {"path": youtube_capture_default_workspace_path(title or "YouTube frame", youtube["videoId"], timestamp, options["image"]["format"]), "provided": False}})
                    result = await capture_frame_from_workspace_options(local)
                    result.update({"sourcePath": f"youtube:{youtube['videoId']}", "sourceVideoId": youtube["videoId"], "sourceVideoFormatId": youtube["formatId"], "sourceTitle": title or "YouTube video", "requestedTimestampSeconds": timestamp, "partialDownload": {"startSeconds": start, "endSeconds": end}})
                    actual = result.get("actualTimestampSeconds")
                    result["actualTimestampSeconds"] = start + actual if isinstance(actual, (int, float)) else None
                    results.append(result)
                    progress(len(results), total, result)
            except AgentApiError:
                record_failed_section(section_index, start, end, timestamps, attempt_count)
                raise
            finally:
                try:
                    item.physical_path.unlink(missing_ok=True)
                except OSError:
                    pass
            if section_index < len(sections):
                await asyncio.sleep(YOUTUBE_CAPTURE_SECTION_DELAY_SECONDS)
        return results
    finally:
        shutil.rmtree(temporary_directory.physical_path, ignore_errors=True)


async def capture_frames(
    options: dict[str, Any], progress: Callable[..., None],
    diagnostics: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    if options["youtube"] is not None:
        return await capture_youtube_frames(options, progress, diagnostics)
    results: list[dict[str, Any]] = []
    for timestamp in options["timestampsSeconds"]:
        local = dict(options)
        local.update({"timestampSeconds": timestamp, "outputPath": capture_output_path(None, options["path"], timestamp, options["image"]["format"])})
        result = await capture_frame_from_workspace_options(local)
        results.append(result)
        progress(len(results), len(options["timestampsSeconds"]), result)
    return results


@dataclass
class CaptureFrameTask:
    task_id: str
    payload: dict[str, Any]
    created_at: str
    last_updated_at: str
    status: str = "working"
    status_message: str = "Preparing frame extraction."
    progress_percent: float = 0.0
    completed_frames: int = 0
    total_frames: int = 0
    frames: list[dict[str, Any]] = field(default_factory=list)
    error: dict[str, str] | None = None
    failed_section: dict[str, Any] | None = None
    diagnostics: dict[str, Any] = field(default_factory=dict)
    runner: asyncio.Task[None] | None = None


class CaptureFrameTaskManager:
    def __init__(self) -> None: self.tasks: dict[str, CaptureFrameTask] = {}
    def get(self, task_id: str) -> CaptureFrameTask:
        if not isinstance(task_id, str) or task_id not in self.tasks: raise AgentApiError("CAPTURE_FRAME_TASK_NOT_FOUND", "The requested frame-extraction task does not exist.")
        return self.tasks[task_id]
    def snapshot(self, task: CaptureFrameTask) -> dict[str, Any]:
        value: dict[str, Any] = {"taskId": task.task_id, "status": task.status, "statusMessage": task.status_message, "progressPercent": task.progress_percent, "completedFrames": task.completed_frames, "totalFrames": task.total_frames, "frames": task.frames, "createdAt": task.created_at, "lastUpdatedAt": task.last_updated_at, "pollIntervalMs": TASK_POLL_INTERVAL_MS}
        if task.error is not None: value["error"] = task.error
        if task.failed_section is not None: value["failedSection"] = task.failed_section
        return value
    def diagnostics_snapshot(self, task_id: str) -> dict[str, Any]:
        task = self.get(task_id)
        youtube = task.diagnostics.get("youtube")
        return {
            "taskId": task.task_id,
            "status": task.status,
            "error": task.error,
            "youtube": youtube if isinstance(youtube, dict) else None,
        }
    async def create(self, payload: Any) -> dict[str, Any]:
        options = capture_frames_options(payload)
        if options["path"] is not None: WorkspacePathResolver().resolve_existing(options["path"], field_name="path", expected_type="file")
        task_id = f"frame_{secrets.token_urlsafe(7)}"
        now = utc_now(); task = CaptureFrameTask(task_id, options, now, now, total_frames=len(options["timestampsSeconds"]))
        self.tasks[task_id] = task; task.runner = asyncio.create_task(self.run(task), name=f"researchtube-capture-frame-{task_id}")
        return self.snapshot(task)
    async def run(self, task: CaptureFrameTask) -> None:
        def progress(completed: int, total: int, frame: dict[str, Any] | None = None, section_download_percent: float | None = None, section_frame_count: int = 0) -> None:
            task.completed_frames, task.total_frames = completed, total
            if section_download_percent is not None and section_frame_count > 0:
                estimated = ((completed + (section_download_percent / 100.0) * section_frame_count) * 100.0 / total)
                # Retried downloaders can restart their own progress at zero. Do
                # not make the task's externally visible progress move backwards.
                task.progress_percent = max(task.progress_percent, min(99.0, estimated))
                task.status_message = f"Downloading frame section: {section_download_percent:.0f}% (extracted {completed} of {total} frames)."
            else:
                task.progress_percent = completed * 100.0 / total
                task.status_message = f"Extracted {completed} of {total} frames."
            task.last_updated_at = utc_now()
            if frame is not None:
                task.frames.append(frame)
        try:
            await capture_frames(task.payload, progress, task.diagnostics); task.status = "completed"; task.progress_percent = 100.0; task.status_message = "Frame extraction completed."; task.last_updated_at = utc_now()
        except AgentApiError as error:
            youtube = task.diagnostics.get("youtube")
            failed_section = youtube.get("failedSection") if isinstance(youtube, dict) else None
            task.failed_section = failed_section if isinstance(failed_section, dict) else None
            detail = f" at section {task.failed_section['sectionIndex']}" if task.failed_section is not None else ""
            task.status, task.error, task.status_message, task.last_updated_at = "failed", {"code": error.code, "message": error.message}, f"Frame extraction failed{detail}.", utc_now()
        except asyncio.CancelledError:
            task.status, task.status_message, task.last_updated_at = "cancelled", "Frame-extraction task cancelled.", utc_now(); raise
        except Exception as error:
            log(f"capture-frame task {task.task_id} failed unexpectedly: {error.__class__.__name__}", error=True); task.status, task.error, task.status_message, task.last_updated_at = "failed", {"code": "CAPTURE_FRAME_INTERNAL_ERROR", "message": "The frame-extraction task encountered an unexpected error."}, "Frame extraction failed.", utc_now()
    async def cancel(self, task_id: str) -> None:
        task = self.get(task_id)
        if task.status == "working" and task.runner and not task.runner.done(): task.status_message = "Frame-extraction cancellation requested."; task.last_updated_at = utc_now(); task.runner.cancel()
    async def shutdown(self) -> None:
        runners = [task.runner for task in self.tasks.values() if task.runner and not task.runner.done()]
        for runner in runners: runner.cancel()
        if runners: await asyncio.gather(*runners, return_exceptions=True)


CAPTURE_FRAME_TASKS = CaptureFrameTaskManager()


IMAGE_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}

VIDEO_MIME_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".ogv": "video/ogg",
    ".mov": "video/quicktime",
}

AUDIO_MIME_TYPES = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".webm": "audio/webm",
}


def workspace_preview_mime_type(path: Path) -> tuple[str, str] | None:
    suffix = path.suffix.lower()
    if (mime_type := IMAGE_MIME_TYPES.get(suffix)) is not None:
        return "image", mime_type
    if (mime_type := VIDEO_MIME_TYPES.get(suffix)) is not None:
        return "video", mime_type
    if (mime_type := AUDIO_MIME_TYPES.get(suffix)) is not None:
        return "audio", mime_type
    return None


async def image_crop(payload: Any) -> dict[str, Any]:
    """Crop one existing workspace image without exposing a host path."""
    options = image_crop_options(payload)
    resolver = WorkspacePathResolver()
    source = resolver.resolve_existing(options["path"], field_name="path", expected_type="file")
    if source.physical_path.suffix.lower() not in IMAGE_MIME_TYPES:
        raise AgentApiError("IMAGE_CROP_INVALID", "path must identify a PNG, JPEG, or WebP image in the workspace.")
    ffmpeg = find_component("ffmpeg", COMPONENTS["ffmpeg"][0])
    ffprobe = find_component("ffprobe", COMPONENTS["ffprobe"][0])
    if ffmpeg.error:
        raise AgentApiError("FFMPEG_DISCOVERY_ERROR", "ffmpeg discovery is ambiguous.", ffmpeg.error)
    if ffprobe.error:
        raise AgentApiError("FFPROBE_DISCOVERY_ERROR", "ffprobe discovery is ambiguous.", ffprobe.error)
    if not ffmpeg.executable:
        raise AgentApiError("FFMPEG_NOT_AVAILABLE", "ffmpeg is not available. Extract it under tools/ffmpeg or install it on PATH.")
    if not ffprobe.executable:
        raise AgentApiError("FFPROBE_NOT_AVAILABLE", "ffprobe is not available. Extract it under tools/ffmpeg or install it on PATH.")

    streams = await ffprobe_streams(source, ffprobe.executable)
    source_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    source_width = source_stream.get("width") if isinstance(source_stream, dict) else None
    source_height = source_stream.get("height") if isinstance(source_stream, dict) else None
    if not isinstance(source_width, int) or source_width < 1 or not isinstance(source_height, int) or source_height < 1:
        raise AgentApiError("IMAGE_CROP_INVALID", "ffprobe did not report usable dimensions for the source image.")
    crop = options["crop"]
    if crop["x"] + crop["width"] > source_width or crop["y"] + crop["height"] > source_height:
        raise AgentApiError("IMAGE_CROP_INVALID", "crop must lie completely within the source image dimensions.")

    destination_path: Path | None = None
    try:
        destination = resolver.resolve_destination(options["outputPath"], field_name="outputPath", error_code="WORKSPACE_PATH_INVALID")
        destination.physical_path.parent.mkdir(parents=True, exist_ok=True)
        destination = resolver.resolve_destination(destination.logical_path, field_name="outputPath", error_code="WORKSPACE_PATH_INVALID")
        if destination.physical_path.exists() or destination.physical_path.is_symlink():
            raise AgentApiError("IMAGE_CROP_DESTINATION_EXISTS", "outputPath already exists; image_crop never overwrites a workspace file.")
        destination_path = destination.physical_path
        encoder_args, mime_type = capture_encoder_arguments(options["image"])
        command = [
            ffmpeg.executable, "-hide_banner", "-nostdin", "-v", "error", "-noautorotate", "-i", str(source.physical_path),
            "-map", "0:v:0", "-an", "-frames:v", "1",
            "-vf", f"crop={crop['width']}:{crop['height']}:{crop['x']}:{crop['y']}",
            *encoder_args, "-y", str(destination_path),
        ]
        try:
            process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            await asyncio.wait_for(process.communicate(), timeout=CAPTURE_FRAME_TIMEOUT_SECONDS)
        except asyncio.TimeoutError as error:
            process.kill()
            await process.communicate()
            raise AgentApiError("IMAGE_CROP_FAILED", "ffmpeg timed out while cropping the image.") from error
        except OSError as error:
            raise AgentApiError("IMAGE_CROP_FAILED", "ffmpeg could not be started.") from error
        if process.returncode != 0 or not destination_path.is_file():
            raise AgentApiError("IMAGE_CROP_FAILED", "ffmpeg could not crop the image.")
        output_streams = await ffprobe_streams_for_file(destination_path, ffprobe.executable)
        output_stream = next((stream for stream in output_streams if stream.get("codec_type") == "video"), None)
        width = output_stream.get("width") if isinstance(output_stream, dict) else None
        height = output_stream.get("height") if isinstance(output_stream, dict) else None
        if width != crop["width"] or height != crop["height"]:
            raise AgentApiError("IMAGE_CROP_FAILED", "ffmpeg did not produce the requested crop dimensions.")
        result = {
            "sourcePath": source.logical_path,
            "sourceWidth": source_width,
            "sourceHeight": source_height,
            "crop": crop,
            "image": {
                "format": options["image"]["format"], "mimeType": mime_type,
                "width": width, "height": height, "imageSizeBytes": destination_path.stat().st_size,
                "workspacePath": destination.logical_path,
            },
        }
        log(f"image_crop path={source.logical_path} crop={crop['x']},{crop['y']} {crop['width']}x{crop['height']} -> {destination.logical_path}")
        return result
    except AgentApiError:
        if destination_path is not None:
            try:
                destination_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise


def workspace_image_metadata(payload: Any) -> tuple[ResolvedWorkspacePath, dict[str, Any]]:
    """Resolve compact metadata for one locally previewable workspace media file."""
    if not isinstance(payload, dict) or set(payload) != {"path"}:
        raise AgentApiError("WORKSPACE_IMAGE_INVALID", "workspace image retrieval requires only path.")
    item = WorkspacePathResolver().resolve_existing(payload.get("path"), field_name="path", expected_type="file")
    preview = workspace_preview_mime_type(item.physical_path)
    if preview is None:
        raise AgentApiError("WORKSPACE_IMAGE_INVALID", "path must identify a supported image, video, or audio file in the workspace.")
    media_kind, mime_type = preview
    try:
        size = item.physical_path.stat().st_size
    except OSError as error:
        raise AgentApiError("WORKSPACE_IMAGE_UNAVAILABLE", "The workspace media file could not be inspected.") from error
    return item, {"path": item.logical_path, "mediaKind": media_kind, "mimeType": mime_type, "sizeBytes": size}


def widget_image_file(logical_path: str) -> tuple[Path, str]:
    """Resolve one direct Workspace-relative GET path for the media widget."""
    if not isinstance(logical_path, str) or not logical_path:
        raise AgentApiError("WORKSPACE_IMAGE_INVALID", "workspace image path is required.")
    item = WorkspacePathResolver().resolve_existing(logical_path, field_name="path", expected_type="file")
    preview = workspace_preview_mime_type(item.physical_path)
    if preview is None:
        raise AgentApiError("WORKSPACE_IMAGE_INVALID", "path must identify a supported image, video, or audio file in the workspace.")
    _media_kind, mime_type = preview
    return item.physical_path, mime_type


async def copy_widget_workspace_path(logical_path: str) -> dict[str, bool]:
    """Copy one image-widget URL path after resolving it inside the Workspace."""
    widget_image_file(logical_path)
    await clipboard_set({"text": logical_path})
    return {"success": True}


async def inspect_workspace_image(payload: Any) -> dict[str, Any]:
    """Return verified, bounded metadata for one workspace image only."""
    if not isinstance(payload, dict) or set(payload) != {"path"}:
        raise AgentApiError("IMAGE_INSPECT_INVALID", "image inspection requires only path.")
    item = WorkspacePathResolver().resolve_existing(payload.get("path"), field_name="path", expected_type="file")
    image_specifications = {
        ".png": ("png", "image/png", "png"),
        ".jpg": ("jpeg", "image/jpeg", "mjpeg"),
        ".jpeg": ("jpeg", "image/jpeg", "mjpeg"),
        ".webp": ("webp", "image/webp", "webp"),
    }
    specification = image_specifications.get(item.physical_path.suffix.lower())
    if specification is None:
        raise AgentApiError("INVALID_IMAGE", "path must identify a PNG, JPEG, or WebP image in the workspace.")
    ffprobe = find_component("ffprobe", COMPONENTS["ffprobe"][0])
    if not ffprobe.executable:
        raise AgentApiError("FFMPEG_NOT_AVAILABLE", "ffprobe is required to inspect workspace image metadata.")
    streams = await ffprobe_streams_for_file(item.physical_path, ffprobe.executable)
    stream = next((candidate for candidate in streams if candidate.get("codec_type") == "video"), None)
    width, height = (stream.get("width"), stream.get("height")) if isinstance(stream, dict) else (None, None)
    if not isinstance(stream, dict) or stream.get("codec_name") != specification[2] or not isinstance(width, int) or width < 1 or not isinstance(height, int) or height < 1:
        raise AgentApiError("INVALID_IMAGE", "The workspace file is not a valid image matching its PNG, JPEG, or WebP extension.")
    try:
        image_size = item.physical_path.stat().st_size
    except OSError as error:
        raise AgentApiError("WORKSPACE_IMAGE_UNAVAILABLE", "The workspace image could not be inspected.") from error
    log(f"inspect_workspace_image path={item.logical_path} -> ok")
    return {"workspacePath": item.logical_path, "format": specification[0], "mimeType": specification[1], "width": width, "height": height, "imageSizeBytes": image_size}


class WindowsClipboard:
    """Small, explicit Win32 clipboard wrapper; no clipboard history is kept."""

    CF_TEXT = 1
    CF_DIB = 8
    CF_UNICODETEXT = 13
    CF_DIBV5 = 17
    GMEM_MOVEABLE = 0x0002

    def __init__(self) -> None:
        if os.name != "nt":
            raise AgentApiError("CLIPBOARD_UNAVAILABLE", "System clipboard access is unavailable on this operating system.")
        try:
            self.user32 = ctypes.WinDLL("user32", use_last_error=True)
            self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            self.user32.OpenClipboard.argtypes = [ctypes.c_void_p]
            self.user32.OpenClipboard.restype = ctypes.c_int
            self.user32.CloseClipboard.restype = ctypes.c_int
            self.user32.GetClipboardData.argtypes = [ctypes.c_uint]
            self.user32.GetClipboardData.restype = ctypes.c_void_p
            self.user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
            self.user32.SetClipboardData.restype = ctypes.c_void_p
            self.user32.EmptyClipboard.restype = ctypes.c_int
            self.user32.IsClipboardFormatAvailable.argtypes = [ctypes.c_uint]
            self.user32.IsClipboardFormatAvailable.restype = ctypes.c_int
            self.user32.CountClipboardFormats.restype = ctypes.c_int
            self.user32.GetClipboardSequenceNumber.restype = ctypes.c_uint32
            self.kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
            self.kernel32.GlobalLock.restype = ctypes.c_void_p
            self.kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
            self.kernel32.GlobalSize.argtypes = [ctypes.c_void_p]
            self.kernel32.GlobalSize.restype = ctypes.c_size_t
            self.kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
            self.kernel32.GlobalAlloc.restype = ctypes.c_void_p
            self.kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
            self.kernel32.GlobalFree.restype = ctypes.c_void_p
        except (AttributeError, OSError) as error:
            raise AgentApiError("CLIPBOARD_UNAVAILABLE", "Windows clipboard APIs are unavailable in this session.") from error

    def open(self) -> None:
        for attempt in range(CLIPBOARD_OPEN_ATTEMPTS):
            if self.user32.OpenClipboard(None):
                return
            if attempt + 1 < CLIPBOARD_OPEN_ATTEMPTS:
                time.sleep(0.03 * (attempt + 1))
        raise AgentApiError("CLIPBOARD_BUSY", "The Windows clipboard is temporarily in use by another application.")

    def close(self) -> None:
        self.user32.CloseClipboard()

    def sequence(self) -> int:
        return int(self.user32.GetClipboardSequenceNumber())

    @staticmethod
    def revision(sequence: int) -> str:
        return f"cb_{sequence}"

    def has_image(self) -> bool:
        return bool(self.user32.IsClipboardFormatAvailable(self.CF_DIBV5) or self.user32.IsClipboardFormatAvailable(self.CF_DIB))

    def has_text(self) -> bool:
        return bool(self.user32.IsClipboardFormatAvailable(self.CF_UNICODETEXT))

    def global_bytes(self, handle: int, max_bytes: int) -> bytes:
        size = int(self.kernel32.GlobalSize(handle))
        if size < 1:
            raise AgentApiError("CLIPBOARD_UNAVAILABLE", "Windows returned an unreadable clipboard object.")
        if size > max_bytes:
            raise AgentApiError("CLIPBOARD_TOO_LARGE", "The clipboard object exceeds the configured size limit.")
        pointer = self.kernel32.GlobalLock(handle)
        if not pointer:
            raise AgentApiError("CLIPBOARD_BUSY", "The Windows clipboard object could not be read.")
        try:
            return ctypes.string_at(pointer, size)
        finally:
            self.kernel32.GlobalUnlock(handle)

    def clipboard_dib(self) -> bytes:
        handle = self.user32.GetClipboardData(self.CF_DIBV5) or self.user32.GetClipboardData(self.CF_DIB)
        if not handle:
            raise AgentApiError("CLIPBOARD_UNSUPPORTED", "The clipboard image cannot be read as a Windows bitmap.")
        return self.global_bytes(handle, MAX_CLIPBOARD_IMAGE_DIB_BYTES)

    def clipboard_text_bytes(self) -> bytes:
        handle = self.user32.GetClipboardData(self.CF_UNICODETEXT)
        if not handle:
            raise AgentApiError("CLIPBOARD_UNSUPPORTED", "The clipboard text cannot be read as Unicode text.")
        return self.global_bytes(handle, MAX_CLIPBOARD_TEXT_BYTES + 2)

    def set_global_data(self, clipboard_format: int, data: bytes) -> None:
        memory = self.kernel32.GlobalAlloc(self.GMEM_MOVEABLE, len(data))
        if not memory:
            raise AgentApiError("CLIPBOARD_UNAVAILABLE", "Windows could not allocate clipboard memory.")
        pointer = self.kernel32.GlobalLock(memory)
        if not pointer:
            self.kernel32.GlobalFree(memory)
            raise AgentApiError("CLIPBOARD_UNAVAILABLE", "Windows could not prepare clipboard memory.")
        try:
            ctypes.memmove(pointer, data, len(data))
        finally:
            self.kernel32.GlobalUnlock(memory)
        if not self.user32.SetClipboardData(clipboard_format, memory):
            self.kernel32.GlobalFree(memory)
            raise AgentApiError("CLIPBOARD_UNAVAILABLE", "Windows rejected the clipboard data.")


def clipboard_dib_metadata(dib: bytes) -> dict[str, int]:
    """Validate a Windows DIB and return dimensions plus the BMP pixel offset."""
    if len(dib) < 16:
        raise AgentApiError("CLIPBOARD_UNSUPPORTED", "The clipboard image has an invalid bitmap header.")
    header_size = struct.unpack_from("<I", dib)[0]
    if header_size == 12:
        if len(dib) < 12:
            raise AgentApiError("CLIPBOARD_UNSUPPORTED", "The clipboard image has an incomplete bitmap header.")
        width, height, bit_count = struct.unpack_from("<HHH", dib, 4)[0], struct.unpack_from("<HHH", dib, 4)[1], struct.unpack_from("<HHH", dib, 4)[2]
        offset = 12 + (3 * (1 << bit_count) if bit_count <= 8 else 0)
    elif header_size >= 40 and len(dib) >= header_size:
        width, height = struct.unpack_from("<ii", dib, 4)
        bit_count = struct.unpack_from("<H", dib, 14)[0]
        compression = struct.unpack_from("<I", dib, 16)[0]
        color_count = struct.unpack_from("<I", dib, 32)[0]
        palette_entries = color_count or ((1 << bit_count) if bit_count <= 8 else 0)
        extra_masks = 12 if header_size == 40 and compression == 3 else 0
        offset = header_size + extra_masks + (4 * palette_entries)
    else:
        raise AgentApiError("CLIPBOARD_UNSUPPORTED", "The clipboard image uses an unsupported bitmap header.")
    width, height = abs(int(width)), abs(int(height))
    if width < 1 or height < 1 or bit_count not in {1, 4, 8, 16, 24, 32} or offset >= len(dib):
        raise AgentApiError("CLIPBOARD_UNSUPPORTED", "The clipboard image bitmap is invalid.")
    if width * height > MAX_CLIPBOARD_IMAGE_PIXELS:
        raise AgentApiError("CLIPBOARD_TOO_LARGE", "The clipboard image exceeds the configured pixel limit.")
    return {"width": width, "height": height, "pixelOffset": offset}


def clipboard_bmp_from_dib(dib: bytes) -> bytes:
    metadata = clipboard_dib_metadata(dib)
    return struct.pack("<2sIHHI", b"BM", len(dib) + 14, 0, 0, 14 + metadata["pixelOffset"]) + dib


def clipboard_status(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) - {"sinceRevision"}:
        raise AgentApiError("CLIPBOARD_INVALID", "clipboard_status accepts only optional sinceRevision.")
    since = payload.get("sinceRevision")
    if since is not None and (not isinstance(since, str) or not since.startswith("cb_")):
        raise AgentApiError("CLIPBOARD_INVALID", "sinceRevision must be a clipboard revision returned by this tool.")
    clipboard = WindowsClipboard()
    clipboard.open()
    try:
        revision = clipboard.revision(clipboard.sequence())
        result: dict[str, Any] = {"revision": revision}
        if clipboard.has_image():
            dib = clipboard.clipboard_dib()
            metadata = clipboard_dib_metadata(dib)
            result.update({"type": "image", "width": metadata["width"], "height": metadata["height"], "sizeBytes": len(dib)})
        elif clipboard.has_text():
            result.update({"type": "text", "sizeBytes": max(0, int(clipboard.kernel32.GlobalSize(clipboard.user32.GetClipboardData(clipboard.CF_UNICODETEXT))) - 2)})
        elif clipboard.user32.CountClipboardFormats() == 0:
            result["type"] = "empty"
        else:
            result["type"] = "unsupported"
        if since is not None:
            result["changed"] = since != revision
        return result
    finally:
        clipboard.close()


async def clipboard_get(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) - {"revision"}:
        raise AgentApiError("CLIPBOARD_INVALID", "clipboard_get accepts only optional revision.")
    expected_revision = payload.get("revision")
    if expected_revision is not None and (not isinstance(expected_revision, str) or not expected_revision.startswith("cb_")):
        raise AgentApiError("CLIPBOARD_INVALID", "revision must be a clipboard revision returned by clipboard_status.")
    clipboard = WindowsClipboard()
    clipboard.open()
    destination_path: Path | None = None
    try:
        revision = clipboard.revision(clipboard.sequence())
        if expected_revision is not None and expected_revision != revision:
            raise AgentApiError("CLIPBOARD_CHANGED", "The clipboard changed after the supplied revision.")
        if clipboard.has_image():
            dib = clipboard.clipboard_dib()
            metadata = clipboard_dib_metadata(dib)
            value_type = "image"
        elif clipboard.has_text():
            text_bytes = clipboard.clipboard_text_bytes()
            value_type = "text"
        elif clipboard.user32.CountClipboardFormats() == 0:
            raise AgentApiError("CLIPBOARD_EMPTY", "The clipboard is empty.")
        else:
            raise AgentApiError("CLIPBOARD_UNSUPPORTED", "The clipboard does not contain supported text or image data.")
    finally:
        clipboard.close()
    if value_type == "text":
        text = text_bytes.decode("utf-16-le", "strict").rstrip("\x00")
        if len(text.encode("utf-8")) > MAX_CLIPBOARD_TEXT_BYTES:
            raise AgentApiError("CLIPBOARD_TOO_LARGE", "The clipboard text exceeds the configured size limit.")
        return {"type": "text", "revision": revision, "text": text}
    try:
        bmp = clipboard_bmp_from_dib(dib)
        resolver = WorkspacePathResolver()
        output_path = f"clipboard/clipboard_image_{revision.removeprefix('cb_')}_{secrets.token_urlsafe(6)}.png"
        destination = resolver.resolve_destination(output_path, field_name="outputPath", error_code="WORKSPACE_PATH_INVALID")
        destination.physical_path.parent.mkdir(parents=True, exist_ok=True)
        destination = resolver.resolve_destination(destination.logical_path, field_name="outputPath", error_code="WORKSPACE_PATH_INVALID")
        destination_path = destination.physical_path
        ffmpeg = find_component("ffmpeg", COMPONENTS["ffmpeg"][0])
        if not ffmpeg.executable:
            raise AgentApiError("FFMPEG_NOT_AVAILABLE", "ffmpeg is required to materialize a clipboard image into the workspace.")
        process = await asyncio.create_subprocess_exec(ffmpeg.executable, "-hide_banner", "-nostdin", "-v", "error", "-f", "image2pipe", "-vcodec", "bmp", "-i", "pipe:0", "-frames:v", "1", "-c:v", "png", "-y", str(destination_path), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _stdout, _stderr = await asyncio.wait_for(process.communicate(bmp), timeout=CAPTURE_FRAME_TIMEOUT_SECONDS)
        if process.returncode != 0 or not destination_path.is_file():
            raise AgentApiError("CLIPBOARD_UNSUPPORTED", "The clipboard image could not be converted to PNG.")
        return {"type": "image", "revision": revision, "workspacePath": destination.logical_path, "width": metadata["width"], "height": metadata["height"], "sizeBytes": destination_path.stat().st_size}
    except AgentApiError:
        if destination_path is not None:
            destination_path.unlink(missing_ok=True)
        raise


async def clipboard_set(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) - {"text", "workspacePath"} or ("text" in payload) == ("workspacePath" in payload):
        raise AgentApiError("CLIPBOARD_INVALID", "clipboard_set requires exactly one of text or workspacePath.")
    if "text" in payload:
        text = payload["text"]
        if not isinstance(text, str):
            raise AgentApiError("CLIPBOARD_INVALID", "text must be a Unicode string.")
        encoded = text.encode("utf-16-le") + b"\x00\x00"
        if len(encoded) - 2 > MAX_CLIPBOARD_TEXT_BYTES:
            raise AgentApiError("CLIPBOARD_TOO_LARGE", "The text exceeds the configured clipboard limit.")
        clipboard = WindowsClipboard()
        clipboard.open()
        try:
            if not clipboard.user32.EmptyClipboard():
                raise AgentApiError("CLIPBOARD_BUSY", "The Windows clipboard could not be cleared.")
            clipboard.set_global_data(clipboard.CF_UNICODETEXT, encoded)
            return {"success": True, "type": "text", "revision": clipboard.revision(clipboard.sequence())}
        finally:
            clipboard.close()
    source = WorkspacePathResolver().resolve_existing(payload["workspacePath"], field_name="workspacePath", expected_type="file")
    if source.physical_path.suffix.lower() not in IMAGE_MIME_TYPES:
        raise AgentApiError("INVALID_IMAGE", "workspacePath must identify a PNG, JPEG, or WebP image.")
    if source.physical_path.stat().st_size > MAX_CLIPBOARD_IMAGE_FILE_BYTES:
        raise AgentApiError("CLIPBOARD_TOO_LARGE", "The workspace image file exceeds the configured clipboard limit.")
    ffprobe = find_component("ffprobe", COMPONENTS["ffprobe"][0])
    ffmpeg = find_component("ffmpeg", COMPONENTS["ffmpeg"][0])
    if not ffprobe.executable or not ffmpeg.executable:
        raise AgentApiError("FFMPEG_NOT_AVAILABLE", "ffmpeg and ffprobe are required to put a workspace image on the clipboard.")
    streams = await ffprobe_streams_for_file(source.physical_path, ffprobe.executable)
    stream = next((item for item in streams if item.get("codec_type") == "video"), None)
    width, height = (stream.get("width"), stream.get("height")) if isinstance(stream, dict) else (None, None)
    if not isinstance(width, int) or not isinstance(height, int) or width < 1 or height < 1:
        raise AgentApiError("INVALID_IMAGE", "The workspace file is not a valid decodable image.")
    if width * height > MAX_CLIPBOARD_IMAGE_PIXELS or width * height * 4 > MAX_CLIPBOARD_IMAGE_DIB_BYTES:
        raise AgentApiError("CLIPBOARD_TOO_LARGE", "The workspace image exceeds the configured pixel or decoded-size limit.")
    process = await asyncio.create_subprocess_exec(ffmpeg.executable, "-hide_banner", "-nostdin", "-v", "error", "-i", str(source.physical_path), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "bmp", "pipe:1", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    bmp, _stderr = await asyncio.wait_for(process.communicate(), timeout=CAPTURE_FRAME_TIMEOUT_SECONDS)
    if process.returncode != 0 or len(bmp) < 15 or not bmp.startswith(b"BM"):
        raise AgentApiError("INVALID_IMAGE", "The workspace image could not be decoded for the clipboard.")
    dib = bmp[14:]
    clipboard_dib_metadata(dib)
    clipboard = WindowsClipboard()
    clipboard.open()
    try:
        if not clipboard.user32.EmptyClipboard():
            raise AgentApiError("CLIPBOARD_BUSY", "The Windows clipboard could not be cleared.")
        clipboard.set_global_data(clipboard.CF_DIB, dib)
        return {"success": True, "type": "image", "revision": clipboard.revision(clipboard.sequence()), "width": width, "height": height}
    finally:
        clipboard.close()


def library_store_files(payload: Any) -> dict[str, Any]:
    """Resolve a small image batch for the Extension's private CDP workflow.

    This endpoint is deliberately not an MCP response.  The Extension needs
    physical paths for DOM.setFileInputFiles, but the model receives only
    logical workspace paths through library_store_* tools.
    """
    if not isinstance(payload, dict) or set(payload) != {"files"} or not isinstance(payload["files"], list):
        raise AgentApiError("LIBRARY_STORE_INVALID", "library file resolution requires files.")
    requested = payload["files"]
    if not 1 <= len(requested) <= 5:
        raise AgentApiError("LIBRARY_STORE_INVALID", "library file resolution accepts between 1 and 5 files.")
    resolved_files: list[dict[str, str]] = []
    seen_paths: set[str] = set()
    resolver = WorkspacePathResolver()
    for entry in requested:
        if not isinstance(entry, dict) or set(entry) != {"workspacePath"} or not isinstance(entry["workspacePath"], str):
            raise AgentApiError("LIBRARY_STORE_INVALID", "each library file requires workspacePath.")
        item = resolver.resolve_existing(entry["workspacePath"], field_name="workspacePath", expected_type="file")
        if item.logical_path in seen_paths:
            raise AgentApiError("LIBRARY_STORE_INVALID", "library file paths must be unique within one batch.")
        if item.physical_path.suffix.lower() not in IMAGE_MIME_TYPES:
            raise AgentApiError("LIBRARY_STORE_INVALID", "library files must be PNG, JPEG, or WebP images.")
        seen_paths.add(item.logical_path)
        resolved_files.append({"workspacePath": item.logical_path, "localPath": str(item.physical_path)})
    return {"files": resolved_files}


def media_probe_sections(payload: dict[str, Any]) -> list[str]:
    value = payload.get("sections")
    if value is None:
        return list(MEDIA_PROBE_SECTIONS)
    if not isinstance(value, list) or not value or len(value) > len(MEDIA_PROBE_SECTIONS):
        raise AgentApiError("MEDIA_PROBE_SECTIONS_INVALID", "sections must be a non-empty array of supported ffprobe metadata sections.")
    if any(not isinstance(section, str) or section not in MEDIA_PROBE_SECTIONS for section in value) or len(set(value)) != len(value):
        raise AgentApiError("MEDIA_PROBE_SECTIONS_INVALID", "sections must contain unique supported ffprobe metadata section names.")
    return value


def public_ffprobe_document(document: Any, sections: list[str]) -> tuple[dict[str, Any], int | None]:
    if not isinstance(document, dict):
        raise AgentApiError("MEDIA_PROBE_FAILED", "ffprobe returned invalid media metadata.")
    probe: dict[str, Any] = {}
    ffprobe_file_size_bytes: int | None = None
    for section in sections:
        json_key = MEDIA_PROBE_SECTIONS[section][1]
        value = document.get(json_key)
        if section == "format":
            if not isinstance(value, dict):
                continue
            public_format = dict(value)
            # ffprobe's native format.filename is the physical host path.
            public_format.pop("filename", None)
            ffprobe_file_size_bytes = ffprobe_integer(public_format.pop("size", None))
            probe[json_key] = public_format
        elif section in {"streams", "chapters", "programs"}:
            if isinstance(value, list):
                probe[json_key] = value
    return probe, ffprobe_file_size_bytes


async def media_probe(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise AgentApiError("INVALID_REQUEST", "media_probe requires a JSON object.")
    item = WorkspacePathResolver().resolve_existing(payload.get("path"), field_name="path", expected_type="file")
    sections = media_probe_sections(payload)
    ffprobe = find_component("ffprobe", COMPONENTS["ffprobe"][0])
    if ffprobe.error:
        raise AgentApiError("FFPROBE_DISCOVERY_ERROR", "ffprobe discovery is ambiguous.", ffprobe.error)
    if not ffprobe.executable:
        raise AgentApiError("FFPROBE_NOT_AVAILABLE", "ffprobe is not available. Extract it under tools/ffmpeg or install it on PATH.")
    command = [
        ffprobe.executable, "-v", "error", *(MEDIA_PROBE_SECTIONS[section][0] for section in sections),
        "-of", "json", str(item.physical_path),
    ]
    try:
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, _stderr = await asyncio.wait_for(process.communicate(), timeout=MEDIA_PROBE_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as error:
        process.kill()
        await process.communicate()
        raise AgentApiError("MEDIA_PROBE_FAILED", "ffprobe timed out while inspecting the media file.") from error
    except OSError as error:
        raise AgentApiError("MEDIA_PROBE_FAILED", "ffprobe could not be started.") from error
    if process.returncode != 0:
        raise AgentApiError("MEDIA_PROBE_FAILED", "ffprobe could not inspect the media file.")
    try:
        document = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AgentApiError("MEDIA_PROBE_FAILED", "ffprobe returned invalid media metadata.") from error
    probe, ffprobe_file_size_bytes = public_ffprobe_document(document, sections)
    try:
        size = item.physical_path.stat().st_size
    except OSError as error:
        raise AgentApiError("MEDIA_PROBE_FAILED", "The media file could not be inspected.") from error
    log(f"media_probe path={item.logical_path} -> ok")
    return {
        "path": item.logical_path, "fileSizeBytes": size,
        "ffprobeFileSizeBytes": ffprobe_file_size_bytes,
        "sections": sections, "probe": probe,
    }


def bounded_line(value: str) -> str:
    return value.strip().replace("\x00", "")[:MAX_DIAGNOSTIC_LINE_LENGTH]


@dataclass
class DownloadTask:
    task_id: str
    url: str
    video_id: str
    selection: DownloadSelection
    partial_range: DownloadRange | None
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
    events: list[dict[str, Any]] = field(default_factory=list)
    next_event_id: int = 1
    yt_dlp_exit_code: int | None = None
    final_output_state: str = "notReported"
    cleanup_removed_count: int = 0

    def touch(self, message: str | None = None) -> None:
        self.last_updated_at = utc_now()
        if message is not None:
            self.status_message = message


class DownloadTaskManager:
    """In-memory task state: no queue and no artificial concurrency ceiling."""

    def __init__(self) -> None:
        self.tasks: dict[str, DownloadTask] = {}

    def record_event(
        self, task: DownloadTask, kind: str, *, message: str | None = None,
        process: str | None = None, exit_code: int | None = None,
        error_code: str | None = None, workspace_path: str | None = None,
        removed_workspace_paths: list[str] | None = None,
    ) -> None:
        """Keep a bounded, public-safe lifecycle record for post-mortem use."""
        event = {
            "eventId": task.next_event_id, "at": utc_now(), "kind": kind,
            "phase": task.phase, "message": (message or "")[:MAX_TASK_EVENT_MESSAGE_LENGTH] or None,
            "process": process, "exitCode": exit_code, "errorCode": error_code,
            "workspacePath": workspace_path,
            "removedWorkspacePaths": removed_workspace_paths or [],
        }
        task.next_event_id += 1
        task.events.append(event)
        if len(task.events) > MAX_TASK_EVENTS:
            del task.events[:-MAX_TASK_EVENTS]

    def set_phase(self, task: DownloadTask, phase: str, message: str) -> None:
        changed = task.phase != phase
        task.phase = phase
        task.touch(message)
        if changed:
            self.record_event(task, "phaseChanged", message=message)

    def fail_task(self, task: DownloadTask, code: str, message: str) -> None:
        task.status = "failed"
        self.set_phase(task, "failed", "Download failed.")
        task.error = {"code": code, "message": message}
        self.record_event(task, "taskFailed", message=message, error_code=code)

    async def create_download(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise AgentApiError("INVALID_REQUEST", "The JSON body must be an object.")
        unknown = set(payload) - {"videoId", "formatSelection", "outputDir", "startSeconds", "endSeconds"}
        if unknown:
            raise AgentApiError("INVALID_REQUEST", "youtube_download contains an unsupported field.")
        video_id = validate_video_id(payload.get("videoId"))
        selection = parse_format_selection(payload.get("formatSelection"))
        partial_range = parse_download_range(payload)
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
        if selection.requires_merge or partial_range is not None:
            ffmpeg = find_component("ffmpeg", COMPONENTS["ffmpeg"][0])
            if ffmpeg.error:
                raise AgentApiError("FFMPEG_DISCOVERY_ERROR", "ffmpeg discovery is ambiguous.", ffmpeg.error)
            if not ffmpeg.executable:
                raise AgentApiError(
                    "FFMPEG_NOT_AVAILABLE",
                    "ffmpeg is required to merge selected tracks or download a time range. Extract it under tools/ffmpeg or install it on PATH.",
                )
            ffmpeg_executable = ffmpeg.executable
        now = utc_now()
        task = DownloadTask(self.new_task_id(), url, video_id, selection, partial_range, output_directory, output_directory_relative, now, now)
        # Store before responding: returned IDs are immediately pollable.
        self.tasks[task.task_id] = task
        self.record_event(task, "taskCreated", message="Download task created.")
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

    def diagnostics_snapshot(self, task_id: str, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise AgentApiError("INVALID_REQUEST", "Diagnostics input must be a JSON object.")
        after_event_id = payload.get("afterEventId", 0)
        limit = payload.get("limit", 100)
        if isinstance(after_event_id, bool) or not isinstance(after_event_id, int) or after_event_id < 0:
            raise AgentApiError("INVALID_REQUEST", "afterEventId must be a non-negative integer.")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise AgentApiError("INVALID_REQUEST", "limit must be an integer from 1 to 100.")
        task = self.get(task_id)
        events = [event for event in task.events if event["eventId"] > after_event_id][:limit]
        return {
            "taskId": task.task_id, "status": task.status, "phase": task.phase,
            "error": task.error, "process": {
                "ytDlpExitCode": task.yt_dlp_exit_code,
                "finalOutput": task.final_output_state,
                "cleanupRemovedCount": task.cleanup_removed_count,
            },
            "events": events, "returned": len(events), "nextEventId": task.next_event_id - 1,
        }

    async def cancel(self, task_id: str) -> None:
        task = self.get(task_id)
        if task.status in {"completed", "failed", "cancelled"}:
            return
        task.cancel_requested = True
        task.touch("Cancellation requested.")
        self.record_event(task, "cancellationRequested", message="Cancellation requested.")
        if task.process is None:
            if task.runner and not task.runner.done():
                task.runner.cancel()
            task.status = "cancelled"
            self.set_phase(task, "cancelled", "Download cancelled.")
            self.record_event(task, "taskCancelled", message="Download cancelled.")
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
        self.set_phase(task, "cancelled", "Download cancelled.")
        self.record_event(task, "taskCancelled", message="Download cancelled.")

    async def run_download(self, task: DownloadTask, executable: str, ffmpeg: str | None, deno: str | None) -> None:
        heartbeat: asyncio.Task[None] | None = None
        try:
            if task.cancel_requested:
                task.status = "cancelled"
                self.set_phase(task, "cancelled", "Download cancelled.")
                self.record_event(task, "taskCancelled", message="Download cancelled.")
                return
            task.output_directory.mkdir(parents=True, exist_ok=True)
            partial_tag = f" [{task.partial_range.filename_tag()}]" if task.partial_range is not None else ""
            output_template = f"%(title)s [yt_%(id)s]{partial_tag} [{task.task_id}].%(ext)s"
            command = [
                # --print below is required for the final workspace file path,
                # but yt-dlp documents that it implies --quiet.  Re-enable
                # progress explicitly so the progress template is emitted.
                executable, *yt_dlp_youtube_arguments(deno),
                "--no-playlist", "--windows-filenames", "--trim-filenames", "180", "--newline", "--progress", "--progress-delta", "1",
                "--format", task.selection.format_selector(),
            ]
            if task.selection.requires_merge:
                # No re-encode: yt-dlp/ffmpeg remux the exact selected tracks.
                command.extend(["--merge-output-format", "mp4", "--ffmpeg-location", str(Path(ffmpeg).parent)])
            elif task.partial_range is not None:
                command.extend(["--ffmpeg-location", str(Path(ffmpeg).parent)])
            if task.partial_range is not None:
                command.extend(["--download-sections", f"*{task.partial_range.start_seconds:.3f}-{task.partial_range.end_seconds:.3f}", "--downloader", "ffmpeg"])
            command.extend([
                "--progress-template", "download:researchtube_progress:%(progress._percent_str)s",
                "--progress-template", "postprocess:researchtube_postprocess:%(progress.status)s",
                "--print", "after_move:__RESEARCHTUBE_FINAL_FILE__:%(filepath)s", "--paths", str(task.output_directory),
                "--output", output_template, task.url,
            ])
            task.touch("Preparing yt-dlp download.")
            task.process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            self.record_event(task, "processStarted", message="yt-dlp process started.", process="ytDlp")
            stdout_task = asyncio.create_task(self.consume_stream(task, task.process.stdout, source="stdout"))
            stderr_task = asyncio.create_task(self.consume_stream(task, task.process.stderr, source="stderr"))
            heartbeat = asyncio.create_task(self.heartbeat(task))
            await asyncio.gather(stdout_task, stderr_task, task.process.wait())
            task.yt_dlp_exit_code = task.process.returncode
            self.record_event(task, "processExited", message="yt-dlp process exited.", process="ytDlp", exit_code=task.process.returncode)
            if task.cancel_requested:
                task.status = "cancelled"
                self.set_phase(task, "cancelled", "Download cancelled.")
                self.record_event(task, "taskCancelled", message="Download cancelled.")
                return
            if task.process.returncode != 0:
                if any("requested format is not available" in line.lower() for line in task.diagnostics):
                    self.fail_task(task, "FORMAT_NOT_AVAILABLE", "The selected YouTube format is not available to local yt-dlp.")
                else:
                    self.fail_task(task, "DOWNLOAD_FAILED", "yt-dlp could not download this video.")
                return
            output_file = self.valid_output_file(task)
            if output_file is None:
                if task.final_output_state == "reportedButMissing":
                    self.fail_task(task, "YTDLP_FINAL_OUTPUT_MISSING", "yt-dlp reported a final output file, but it was not present in the workspace.")
                else:
                    self.fail_task(task, "YTDLP_FINAL_PATH_NOT_REPORTED", "yt-dlp completed without reporting its final output path.")
                return
            relative_file = WorkspacePathResolver().logical_existing_file(output_file, error_code="OUTPUT_FILE_NOT_FOUND")
            task.final_output_state = "verified"
            self.record_event(task, "finalOutputVerified", message="yt-dlp final output verified in workspace.", workspace_path=relative_file)
            task.result = {"videoId": task.video_id, "filePath": relative_file, "fileName": output_file.name, "outputDir": task.output_directory_relative, "partial": None if task.partial_range is None else {"startSeconds": task.partial_range.start_seconds, "endSeconds": task.partial_range.end_seconds}}
            task.status = "completed"
            self.set_phase(task, "completed", "Download completed.")
            task.progress_percent = 100.0
            self.record_event(task, "taskCompleted", message="Download completed.", workspace_path=relative_file)
        except asyncio.CancelledError:
            task.status = "cancelled"
            self.set_phase(task, "cancelled", "Download cancelled.")
            self.record_event(task, "taskCancelled", message="Download cancelled.")
        except FileNotFoundError:
            self.fail_task(task, "YTDLP_NOT_AVAILABLE", "yt-dlp is no longer available.")
        except OSError as error:
            log(f"yt-dlp start failed for {task.task_id}: {error.__class__.__name__}", error=True)
            self.fail_task(task, "DOWNLOAD_START_FAILED", "yt-dlp could not be started.")
        except Exception as error:
            log(f"download task {task.task_id} failed unexpectedly: {error.__class__.__name__}", error=True)
            self.fail_task(task, "DOWNLOAD_INTERNAL_ERROR", "The download task encountered an unexpected error.")
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
        raw_text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", line).strip().replace("\x00", "")
        text = bounded_line(raw_text)
        if not text:
            return
        # New yt-dlp releases and wrappers may preserve the custom template or
        # emit the standard "[download] 37.4%" form. Both are authoritative.
        progress = re.search(r"(?:researchtube_progress:\s*|\[download\]\s+)([0-9]+(?:[.,][0-9]+)?)%", text)
        if progress:
            percentage = min(100.0, max(0.0, float(progress.group(1).replace(",", "."))))
            next_phase = self.download_phase(task, percentage)
            if next_phase != task.phase:
                self.set_phase(task, next_phase, "yt-dlp changed download phase.")
                task.progress_percent = None
            task.progress_percent = percentage
            label = {
                "downloadingCombined": "Downloading combined track",
                "downloadingVideo": "Downloading video track",
                "downloadingAudio": "Downloading audio track",
            }[task.phase]
            task.touch(f"{label}: {round(task.progress_percent)}%.")
        elif raw_text.startswith("__RESEARCHTUBE_FINAL_FILE__:"):
            candidate = Path(raw_text.removeprefix("__RESEARCHTUBE_FINAL_FILE__:").strip())
            task.output_file = candidate if candidate.is_absolute() else task.output_directory / candidate
            task.final_output_state = "reportedButMissing"
            self.record_event(task, "finalOutputReported", message="yt-dlp reported its final output path.")
        elif text.startswith("researchtube_postprocess:") or "[Merger]" in text:
            self.set_phase(task, "merging", "Merging selected video and audio tracks.")
            task.progress_percent = None
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
            removed: list[str] = []
            for item in task.output_directory.iterdir():
                if item.is_file() and marker in item.name:
                    try:
                        logical_path = WorkspacePathResolver().logical_existing_file(item, error_code="OUTPUT_FILE_NOT_FOUND")
                    except AgentApiError:
                        logical_path = None
                    item.unlink(missing_ok=True)
                    if logical_path is not None:
                        removed.append(logical_path)
            task.cleanup_removed_count += len(removed)
            self.record_event(task, "cleanupCompleted", message="Task-specific partial artifacts removed.", removed_workspace_paths=removed)
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
        "Access-Control-Allow-Headers: Content-Type", "Access-Control-Allow-Private-Network: true", "Connection: close", "", "",
    ]
    return "\r\n".join(headers).encode("ascii") + encoded


def image_response(status: str, image_bytes: bytes = b"", mime_type: str = "text/plain; charset=utf-8") -> bytes:
    headers = [
        f"HTTP/1.1 {status}", f"Content-Type: {mime_type}", f"Content-Length: {len(image_bytes)}",
        "X-Content-Type-Options: nosniff", "Cache-Control: no-store", "Access-Control-Allow-Origin: *", "Access-Control-Allow-Private-Network: true", "Connection: close", "", "",
    ]
    return "\r\n".join(headers).encode("ascii") + image_bytes


def public_file_response_headers(status: str, size: int, mime_type: str) -> bytes:
    headers = [
        f"HTTP/1.1 {status}", f"Content-Type: {mime_type}", f"Content-Length: {size}",
        "X-Content-Type-Options: nosniff", "Cache-Control: no-store", "Connection: close", "", "",
    ]
    return "\r\n".join(headers).encode("ascii")


def widget_image_response_headers(status: str, size: int, mime_type: str) -> bytes:
    headers = [
        f"HTTP/1.1 {status}", f"Content-Type: {mime_type}", f"Content-Length: {size}",
        "X-Content-Type-Options: nosniff", "Cache-Control: no-store", "Access-Control-Allow-Origin: *",
        "Access-Control-Allow-Methods: GET, OPTIONS", "Access-Control-Allow-Private-Network: true", "Connection: close", "", "",
    ]
    return "\r\n".join(headers).encode("ascii")


async def read_request(reader: asyncio.StreamReader) -> tuple[str, str, dict[str, list[str]], bytes]:
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
    parsed = urlparse(parts[1])
    maximum = MAX_GOOGLE_TRANSLATE_AUDIO_BYTES if re.fullmatch(r"/tasks/system-speech/tsk_[A-Za-z0-9_-]{10}/google-translate-audio", parsed.path) else MAX_REQUEST_BODY_BYTES
    if content_length < 0 or content_length > maximum:
        raise AgentApiError("REQUEST_TOO_LARGE", "Request body is too large.")
    body = await asyncio.wait_for(reader.readexactly(content_length), timeout=30 if maximum > MAX_REQUEST_BODY_BYTES else 5) if content_length else b""
    return parts[0].upper(), parsed.path, parse_qs(parsed.query, keep_blank_values=True), body


@dataclass(frozen=True)
class WorkspaceShareOptions:
    folder: ResolvedWorkspacePath | None
    file: ResolvedWorkspacePath | None
    file_types: tuple[str, ...]
    verify_external: bool
    probe_file: ResolvedWorkspacePath | None


def workspace_share_options(payload: Any) -> WorkspaceShareOptions:
    if not isinstance(payload, dict) or not set(payload).issubset({"folder", "file", "fileTypes", "verifyExternal", "probePath"}):
        raise AgentApiError("ONLINE_SHARE_INVALID", "online_share_start received unsupported fields.")
    has_folder, has_file = "folder" in payload, "file" in payload
    if has_folder == has_file:
        raise AgentApiError("ONLINE_SHARE_INVALID", "Specify exactly one of folder or file.")
    verify_external = payload.get("verifyExternal", False)
    if not isinstance(verify_external, bool):
        raise AgentApiError("ONLINE_SHARE_INVALID", "verifyExternal must be a boolean.")
    resolver = WorkspacePathResolver()
    if has_file:
        if "fileTypes" in payload or "probePath" in payload:
            raise AgentApiError("ONLINE_SHARE_INVALID", "A single-file share does not accept fileTypes or probePath.")
        shared_file = resolver.resolve_existing(payload["file"], field_name="file", expected_type="file")
        if verify_external and public_share_file_type(shared_file.physical_path) != "images":
            raise AgentApiError("ONLINE_SHARE_INVALID", "verifyExternal requires an image file for wsrv.nl.")
        return WorkspaceShareOptions(None, shared_file, (), verify_external, shared_file if verify_external else None)
    if "fileTypes" not in payload:
        raise AgentApiError("ONLINE_SHARE_INVALID", "A folder share requires fileTypes.")
    folder = resolver.resolve_existing(payload["folder"], field_name="folder", expected_type="directory", allow_root=True)
    file_types = payload["fileTypes"]
    if not isinstance(file_types, list) or not file_types or len(file_types) > len(PUBLIC_SHARE_FILE_TYPE_NAMES) or len(set(file_types)) != len(file_types):
        raise AgentApiError("ONLINE_SHARE_INVALID", "fileTypes must be a non-empty array of unique supported file categories.")
    if any(not isinstance(item, str) or item not in PUBLIC_SHARE_FILE_TYPE_NAMES for item in file_types):
        raise AgentApiError("ONLINE_SHARE_INVALID", "fileTypes contains an unsupported file category.")
    if "all" in file_types and len(file_types) != 1:
        raise AgentApiError("ONLINE_SHARE_INVALID", "fileTypes all cannot be combined with other categories.")
    if not verify_external:
        if "probePath" in payload:
            raise AgentApiError("ONLINE_SHARE_INVALID", "probePath is only valid when verifyExternal is true.")
        return WorkspaceShareOptions(folder, None, tuple(file_types), False, None)
    if "probePath" not in payload:
        raise AgentApiError("ONLINE_SHARE_INVALID", "A verified folder share requires probePath.")
    probe_file = resolver.resolve_existing(payload["probePath"], field_name="probePath", expected_type="file")
    if not path_is_within(probe_file.physical_path, folder.physical_path):
        raise AgentApiError("ONLINE_SHARE_INVALID", "probePath must be inside the shared folder.")
    if public_share_file_type(probe_file.physical_path) != "images" or ("all" not in file_types and "images" not in file_types):
        raise AgentApiError("ONLINE_SHARE_INVALID", "probePath must be an allowed image file for wsrv.nl.")
    return WorkspaceShareOptions(folder, None, tuple(file_types), True, probe_file)


def public_share_file_type(path: Path) -> str:
    suffix = path.suffix.lower()
    for name, suffixes in PUBLIC_SHARE_FILE_TYPE_SUFFIXES.items():
        if suffix in suffixes:
            return name
    return "other"


def public_share_directory_listing(path: str) -> bytes | None:
    """Return a small browseable listing for a directory within a folder share."""
    if PUBLIC_SHARE_FOLDER is None:
        return None
    encoded_segments = [segment for segment in path.removeprefix("/").split("/") if segment]
    try:
        segments = tuple(unquote(segment, encoding="utf-8", errors="strict") for segment in encoded_segments)
    except UnicodeDecodeError:
        return None
    if any(segment in {".", ".."} or "/" in segment or "\\" in segment for segment in segments):
        return None
    folder_parts, _ = WorkspacePathResolver.logical_parts(PUBLIC_SHARE_FOLDER.logical_path, field_name="shared folder", error_code="PUBLIC_SHARE_NOT_FOUND", allow_root=True)
    if tuple(segments[:len(folder_parts)]) != folder_parts:
        return None
    relative_parts = segments[len(folder_parts):]
    candidate = PUBLIC_SHARE_FOLDER.physical_path.joinpath(*relative_parts)
    try:
        resolved = candidate.resolve(strict=True)
    except OSError:
        return None
    if not path_is_within(resolved, PUBLIC_SHARE_FOLDER.physical_path) or not resolved.is_dir() or resolved.is_symlink():
        return None
    entries: list[tuple[str, bool]] = []
    try:
        children = sorted(resolved.iterdir(), key=lambda item: (not item.is_dir(), item.name.casefold()))[:MAX_PUBLIC_SHARE_DIRECTORY_ENTRIES]
        for child in children:
            is_junction = getattr(child, "is_junction", lambda: False)
            if child.is_symlink() or is_junction():
                continue
            if child.is_dir():
                entries.append((child.name, True))
            elif child.is_file() and ("all" in PUBLIC_SHARE_FILE_TYPES or public_share_file_type(child) in PUBLIC_SHARE_FILE_TYPES):
                entries.append((child.name, False))
    except OSError:
        return None
    title = "/".join((*folder_parts, *relative_parts)) or "Workspace"
    rows = []
    if relative_parts:
        rows.append('<li><a href="../">../</a></li>')
    for name, is_directory in entries:
        label = f"{name}/" if is_directory else name
        href = f"{quote(name, safe='')}/" if is_directory else quote(name, safe='')
        rows.append(f'<li><a href="{href}">{escape(label)}</a></li>')
    body = f"<!doctype html><meta charset=\"utf-8\"><title>Index of /{escape(title)}</title><h1>Index of /{escape(title)}</h1><ul>{''.join(rows)}</ul>"
    return body.encode("utf-8")


def public_share_file(path: str) -> tuple[Path, str]:
    """Resolve one public URL whose path begins with the shared folder path."""
    if PUBLIC_SHARE_FOLDER is None and PUBLIC_SHARE_FILE is None:
        raise AgentApiError("PUBLIC_SHARE_NOT_ACTIVE", "No workspace item is currently shared.")
    encoded_segments = path.removeprefix("/").split("/")
    if not encoded_segments or any(not segment for segment in encoded_segments):
        raise AgentApiError("PUBLIC_SHARE_NOT_FOUND", "The requested shared file was not found.")
    try:
        segments = tuple(unquote(segment, encoding="utf-8", errors="strict") for segment in encoded_segments)
    except UnicodeDecodeError as error:
        raise AgentApiError("PUBLIC_SHARE_NOT_FOUND", "The requested shared file was not found.") from error
    if any(not segment or segment in {".", ".."} or "/" in segment or "\\" in segment for segment in segments):
        raise AgentApiError("PUBLIC_SHARE_NOT_FOUND", "The requested shared file was not found.")
    if PUBLIC_SHARE_FILE is not None:
        file_parts, _ = WorkspacePathResolver.logical_parts(PUBLIC_SHARE_FILE.logical_path, field_name="shared file", error_code="PUBLIC_SHARE_NOT_FOUND")
        if tuple(segments) != file_parts:
            raise AgentApiError("PUBLIC_SHARE_NOT_FOUND", "The requested shared file was not found.")
        mime_type = mimetypes.guess_type(PUBLIC_SHARE_FILE.physical_path.name)[0] or "application/octet-stream"
        return PUBLIC_SHARE_FILE.physical_path, mime_type
    assert PUBLIC_SHARE_FOLDER is not None
    folder_parts, _ = WorkspacePathResolver.logical_parts(
        PUBLIC_SHARE_FOLDER.logical_path, field_name="shared folder", error_code="PUBLIC_SHARE_NOT_FOUND", allow_root=True,
    )
    if tuple(segments[:len(folder_parts)]) != folder_parts:
        raise AgentApiError("PUBLIC_SHARE_NOT_FOUND", "The requested shared file was not found.")
    relative_parts = segments[len(folder_parts):]
    if not relative_parts:
        raise AgentApiError("PUBLIC_SHARE_NOT_FOUND", "The requested shared file was not found.")
    candidate = PUBLIC_SHARE_FOLDER.physical_path
    for segment in relative_parts:
        candidate = candidate / segment
        is_junction = getattr(candidate, "is_junction", lambda: False)
        if candidate.is_symlink() or is_junction():
            raise AgentApiError("PUBLIC_SHARE_NOT_FOUND", "The requested shared file was not found.")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise AgentApiError("PUBLIC_SHARE_NOT_FOUND", "The requested shared file was not found.") from error
    if not path_is_within(resolved, PUBLIC_SHARE_FOLDER.physical_path) or not resolved.is_file():
        raise AgentApiError("PUBLIC_SHARE_NOT_FOUND", "The requested shared file was not found.")
    file_type = public_share_file_type(resolved)
    if "all" not in PUBLIC_SHARE_FILE_TYPES and file_type not in PUBLIC_SHARE_FILE_TYPES:
        raise AgentApiError("PUBLIC_SHARE_NOT_FOUND", "The requested shared file was not found.")
    mime_type = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
    return resolved, mime_type


async def handle_public_share_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        method, path, _query, body = await read_request(reader)
        if method not in {"GET", "HEAD"} or body:
            writer.write(image_response("404 Not Found"))
        else:
            directory_listing = public_share_directory_listing(path)
            if directory_listing is not None:
                writer.write(public_file_response_headers("200 OK", len(directory_listing), "text/html; charset=utf-8"))
                if method == "GET":
                    writer.write(directory_listing)
            else:
                shared_file, mime_type = public_share_file(path)
                size = shared_file.stat().st_size
                writer.write(public_file_response_headers("200 OK", size, mime_type))
                if method == "GET":
                    with shared_file.open("rb") as source:
                        while chunk := source.read(64 * 1024):
                            writer.write(chunk)
                            await writer.drain()
        await writer.drain()
    except (AgentApiError, OSError, UnicodeDecodeError, asyncio.TimeoutError, asyncio.IncompleteReadError):
        try:
            writer.write(image_response("404 Not Found"))
            await writer.drain()
        except ConnectionError:
            pass
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except ConnectionError:
            pass


async def watch_cloudflared_stream(stream: asyncio.StreamReader | None) -> None:
    global PUBLIC_TUNNEL_URL
    if stream is None:
        return
    try:
        while line := await stream.readline():
            message = line.decode("utf-8", errors="replace").strip()
            match = re.search(r"https://[A-Za-z0-9-]+\.trycloudflare\.com", message)
            if match and PUBLIC_TUNNEL_URL is None:
                PUBLIC_TUNNEL_URL = match.group(0)
                PUBLIC_TUNNEL_READY.set()
                log(f"Public workspace tunnel: {PUBLIC_TUNNEL_URL}")
    except (OSError, asyncio.CancelledError):
        return


async def start_public_share_tunnel(port: int) -> None:
    global PUBLIC_TUNNEL_PROCESS, PUBLIC_TUNNEL_WATCHERS
    cloudflared = find_component("cloudflared", COMPONENTS["cloudflared"][0])
    if cloudflared.error:
        raise AgentApiError("CLOUDFLARED_DISCOVERY_ERROR", "cloudflared discovery is ambiguous.", cloudflared.error)
    if not cloudflared.executable:
        raise AgentApiError("CLOUDFLARED_NOT_AVAILABLE", "cloudflared is not available. Extract it under tools/cloudflared or install it on PATH.")
    try:
        PUBLIC_TUNNEL_PROCESS = await asyncio.create_subprocess_exec(
            cloudflared.executable, "tunnel", "--url", f"http://127.0.0.1:{port}",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    except OSError as error:
        raise AgentApiError("CLOUDFLARED_START_FAILED", "cloudflared could not start.") from error
    PUBLIC_TUNNEL_WATCHERS = [
        asyncio.create_task(watch_cloudflared_stream(PUBLIC_TUNNEL_PROCESS.stdout)),
        asyncio.create_task(watch_cloudflared_stream(PUBLIC_TUNNEL_PROCESS.stderr)),
    ]


def public_share_file_url(shared_file: ResolvedWorkspacePath) -> str | None:
    if PUBLIC_TUNNEL_URL is None:
        return None
    parts, _ = WorkspacePathResolver.logical_parts(shared_file.logical_path, field_name="shared file", error_code="PUBLIC_SHARE_NOT_FOUND")
    return f"{PUBLIC_TUNNEL_URL}/{'/'.join(quote(part, safe='') for part in parts)}"


def wsrv_external_probe_sync(public_url: str) -> dict[str, Any]:
    probe_url = f"https://wsrv.nl/?url={quote(public_url, safe='')}&w=1&h=1&output=png"
    try:
        request = Request(probe_url, headers={"User-Agent": f"ResearchTube/{AGENT_VERSION}"})
        with urlopen(request, timeout=20) as response:
            content_type = response.headers.get_content_type().lower()
            response.read(1)
            return {"state": "passed" if 200 <= response.status < 300 and content_type.startswith("image/") else "failed", "provider": "wsrv.nl", "httpStatus": response.status, "contentType": content_type}
    except HTTPError as error:
        return {"state": "failed", "provider": "wsrv.nl", "httpStatus": error.code, "contentType": error.headers.get_content_type().lower() if error.headers else None}
    except (URLError, OSError, TimeoutError, ValueError):
        return {"state": "failed", "provider": "wsrv.nl", "httpStatus": None, "contentType": None}


async def run_external_share_probe(probe_file: ResolvedWorkspacePath | None) -> None:
    global PUBLIC_SHARE_EXTERNAL_PROBE
    if probe_file is None:
        PUBLIC_SHARE_EXTERNAL_PROBE = {"state": "not_requested", "provider": "wsrv.nl", "probePath": None, "httpStatus": None, "contentType": None}
        return
    public_url = public_share_file_url(probe_file)
    if public_url is None:
        PUBLIC_SHARE_EXTERNAL_PROBE = {"state": "failed", "provider": "wsrv.nl", "probePath": probe_file.logical_path, "httpStatus": None, "contentType": None}
        return
    result = await asyncio.to_thread(wsrv_external_probe_sync, public_url)
    PUBLIC_SHARE_EXTERNAL_PROBE = {**result, "probePath": probe_file.logical_path}


async def stop_public_share_unlocked() -> bool:
    global PUBLIC_SHARE_SERVER, PUBLIC_SHARE_FOLDER, PUBLIC_SHARE_FILE, PUBLIC_SHARE_FILE_TYPES, PUBLIC_SHARE_EXTERNAL_PROBE, PUBLIC_TUNNEL_PROCESS, PUBLIC_TUNNEL_URL, PUBLIC_TUNNEL_WATCHERS
    was_active = PUBLIC_SHARE_SERVER is not None or PUBLIC_TUNNEL_PROCESS is not None
    if PUBLIC_SHARE_SERVER is not None:
        PUBLIC_SHARE_SERVER.close()
        await PUBLIC_SHARE_SERVER.wait_closed()
    PUBLIC_SHARE_SERVER = None
    PUBLIC_SHARE_FOLDER = None
    PUBLIC_SHARE_FILE = None
    PUBLIC_SHARE_FILE_TYPES = ()
    PUBLIC_SHARE_EXTERNAL_PROBE = {"state": "not_requested", "provider": "wsrv.nl", "probePath": None, "httpStatus": None, "contentType": None}
    for watcher in PUBLIC_TUNNEL_WATCHERS:
        watcher.cancel()
    if PUBLIC_TUNNEL_WATCHERS:
        await asyncio.gather(*PUBLIC_TUNNEL_WATCHERS, return_exceptions=True)
    PUBLIC_TUNNEL_WATCHERS = []
    if PUBLIC_TUNNEL_PROCESS is not None and PUBLIC_TUNNEL_PROCESS.returncode is None:
        PUBLIC_TUNNEL_PROCESS.terminate()
        try:
            await asyncio.wait_for(PUBLIC_TUNNEL_PROCESS.wait(), timeout=5)
        except asyncio.TimeoutError:
            PUBLIC_TUNNEL_PROCESS.kill()
            await PUBLIC_TUNNEL_PROCESS.wait()
    PUBLIC_TUNNEL_PROCESS = None
    PUBLIC_TUNNEL_URL = None
    PUBLIC_TUNNEL_READY.clear()
    return was_active


async def workspace_share_start(payload: Any) -> dict[str, Any]:
    options = workspace_share_options(payload)
    async with PUBLIC_SHARE_LOCK:
        await stop_public_share_unlocked()
        global PUBLIC_SHARE_SERVER, PUBLIC_SHARE_FOLDER, PUBLIC_SHARE_FILE, PUBLIC_SHARE_FILE_TYPES
        server = await asyncio.start_server(handle_public_share_client, host="127.0.0.1", port=0)
        socket = next(iter(server.sockets or ()), None)
        if socket is None:
            server.close()
            await server.wait_closed()
            raise AgentApiError("PUBLIC_SHARE_START_FAILED", "The local workspace sharing server did not receive a port.")
        PUBLIC_SHARE_SERVER = server
        PUBLIC_SHARE_FOLDER = options.folder
        PUBLIC_SHARE_FILE = options.file
        PUBLIC_SHARE_FILE_TYPES = options.file_types
        try:
            await start_public_share_tunnel(socket.getsockname()[1])
            await asyncio.wait_for(PUBLIC_TUNNEL_READY.wait(), timeout=15)
            if PUBLIC_TUNNEL_URL is None:
                raise AgentApiError("PUBLIC_SHARE_START_FAILED", "cloudflared did not provide a public URL.")
        except (AgentApiError, asyncio.TimeoutError) as error:
            await stop_public_share_unlocked()
            if isinstance(error, AgentApiError):
                raise
            raise AgentApiError("PUBLIC_SHARE_START_FAILED", "cloudflared did not provide a public URL within 15 seconds.") from error
        await run_external_share_probe(options.probe_file)
        target = options.file.logical_path if options.file is not None else (options.folder.logical_path or "<root>")
        log(f"workspace_share_start target={target} mode={'file' if options.file is not None else 'folder'} verifyExternal={str(options.verify_external).lower()}")
        return workspace_share_status_document()


def public_share_base_url() -> str | None:
    if PUBLIC_TUNNEL_URL is None or PUBLIC_SHARE_FOLDER is None:
        return None
    parts, _ = WorkspacePathResolver.logical_parts(
        PUBLIC_SHARE_FOLDER.logical_path, field_name="shared folder", error_code="PUBLIC_SHARE_NOT_FOUND", allow_root=True,
    )
    route = "/".join(quote(part, safe="") for part in parts)
    return f"{PUBLIC_TUNNEL_URL}/{route}/" if route else f"{PUBLIC_TUNNEL_URL}/"


def workspace_share_status_document() -> dict[str, Any]:
    active = PUBLIC_SHARE_SERVER is not None and PUBLIC_TUNNEL_PROCESS is not None and PUBLIC_TUNNEL_PROCESS.returncode is None and PUBLIC_TUNNEL_URL is not None
    external_probe = PUBLIC_SHARE_EXTERNAL_PROBE if active else {"state": "not_requested", "provider": "wsrv.nl", "probePath": None, "httpStatus": None, "contentType": None}
    return {
        "state": "active" if active else "inactive",
        "folder": PUBLIC_SHARE_FOLDER.logical_path if active and PUBLIC_SHARE_FOLDER is not None else None,
        "file": PUBLIC_SHARE_FILE.logical_path if active and PUBLIC_SHARE_FILE is not None else None,
        "fileTypes": list(PUBLIC_SHARE_FILE_TYPES) if active else [],
        "publicBaseUrl": public_share_base_url() if active else None,
        "publicFileUrl": public_share_file_url(PUBLIC_SHARE_FILE) if active and PUBLIC_SHARE_FILE is not None else None,
        "methods": ["GET", "HEAD"] if active else [],
        "externallyReachable": True if external_probe["state"] == "passed" else False if external_probe["state"] == "failed" else None,
        "externalProbe": external_probe,
    }


async def workspace_share_status(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) - {"verifyExternal"}:
        raise AgentApiError("ONLINE_SHARE_INVALID", "online_share_status received unsupported fields.")
    verify_external = payload.get("verifyExternal", False)
    if not isinstance(verify_external, bool):
        raise AgentApiError("ONLINE_SHARE_INVALID", "verifyExternal must be a boolean.")
    async with PUBLIC_SHARE_LOCK:
        if verify_external and (PUBLIC_SHARE_FOLDER is not None or PUBLIC_SHARE_FILE is not None):
            if PUBLIC_SHARE_FILE is not None:
                probe_file = PUBLIC_SHARE_FILE
            else:
                probe_path = PUBLIC_SHARE_EXTERNAL_PROBE.get("probePath")
                probe_file = WorkspacePathResolver().resolve_existing(probe_path, field_name="probePath", expected_type="file") if isinstance(probe_path, str) else None
            if probe_file is None:
                raise AgentApiError("ONLINE_SHARE_INVALID", "This share has no image probePath. Restart it with verifyExternal and a probePath.")
            await run_external_share_probe(probe_file)
        return workspace_share_status_document()


async def workspace_share_stop() -> dict[str, Any]:
    async with PUBLIC_SHARE_LOCK:
        stopped = await stop_public_share_unlocked()
    log(f"workspace_share_stop stopped={str(stopped).lower()}")
    return {"state": "stopped", "stopped": stopped}


def parse_json_body(body: bytes) -> Any:
    if not body:
        return {}
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AgentApiError("INVALID_JSON", "The request body must be valid UTF-8 JSON.") from error


def response_log_suffix(path: str, body: dict[str, Any] | None) -> str:
    """Add a compact, user-visible state to task and MCP log lines."""
    if not isinstance(body, dict):
        return ""
    if path.startswith("/mcp/log/") and isinstance(body.get("status"), str):
        return f" {body['status']}"
    if not path.startswith("/tasks/") or "taskId" not in body:
        return ""
    progress = body.get("progressPercent")
    if isinstance(progress, (int, float)) and not isinstance(progress, bool) and 0 <= progress <= 100:
        percentage = f"{progress:.1f}".rstrip("0").rstrip(".")
        return f" {percentage}%"
    return ""


def internal_google_translate_speech_path(path: str) -> bool:
    """Google Translate callbacks are internal task plumbing, not user-facing actions."""
    return bool(re.fullmatch(
        r"/tasks/system-speech/tsk_[A-Za-z0-9_-]{10}/google-translate-(?:progress|complete|fail|audio)",
        path,
    ))


def compact_google_translate_speech_log_path(path: str, body: dict[str, Any] | None) -> str:
    """Show every Google TTS request, without repeating its long internal route."""
    callback = re.fullmatch(
        r"/tasks/system-speech/(tsk_[A-Za-z0-9_-]{10})/google-translate-(progress|complete|fail|audio)",
        path,
    )
    if callback:
        task_id, _action = callback.groups()
        return f"/tasks/{task_id}"
    if re.fullmatch(r"/tasks/system-speech/tsk_[A-Za-z0-9_-]{10}", path) and isinstance(body, dict) and body.get("engine") == "googleTranslate":
        return f"/tasks/{body['taskId']}"
    return path


def mcp_tool_log(tool: str, payload: Any) -> dict[str, Any]:
    if not re.fullmatch(r"[a-z0-9_]{1,80}", tool):
        raise AgentApiError("MCP_LOG_INVALID", "The MCP tool name is invalid.")
    if not isinstance(payload, dict) or set(payload) != {"status"} or not isinstance(payload["status"], str):
        raise AgentApiError("MCP_LOG_INVALID", "The MCP log request must contain only a status string.")
    status = payload["status"].strip()
    if not re.fullmatch(r"[a-z0-9_-]{1,40}", status):
        raise AgentApiError("MCP_LOG_INVALID", "The MCP log status is invalid.")
    return {"status": status}


try:
    from .storyboards import StoryboardService
except ImportError:  # Direct python researchtube_agent.py launch.
    from storyboards import StoryboardService

STORYBOARD_TASKS = StoryboardService(sys.modules[__name__])


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    method, path = "", ""
    try:
        method, path, query, body = await read_request(reader)
        if method == "OPTIONS":
            response_status, response_body = "204 No Content", None
        elif method == "GET" and path == "/health":
            response_status, response_body = "200 OK", public_health_document(await health_snapshot())
        elif method == "POST" and path == "/workspace/list":
            response_status, response_body = "200 OK", workspace_list(parse_json_body(body))
        elif method == "POST" and path == "/workspace/stat":
            response_status, response_body = "200 OK", workspace_stat(parse_json_body(body))
        elif method == "POST" and path == "/workspace/mkdir":
            response_status, response_body = "200 OK", workspace_mkdir(parse_json_body(body))
        elif method == "POST" and path == "/workspace/move":
            response_status, response_body = "200 OK", workspace_move(parse_json_body(body))
        elif method == "POST" and path == "/workspace/delete":
            response_status, response_body = "200 OK", workspace_delete(parse_json_body(body))
        elif method == "POST" and path == "/workspace/share/start":
            response_status, response_body = "200 OK", await workspace_share_start(parse_json_body(body))
        elif method == "POST" and path == "/workspace/share/status":
            response_status, response_body = "200 OK", await workspace_share_status(parse_json_body(body))
        elif method == "POST" and path == "/workspace/share/stop":
            response_status, response_body = "200 OK", await workspace_share_stop()
        elif method == "POST" and path == "/media/probe":
            response_status, response_body = "200 OK", await media_probe(parse_json_body(body))
        elif method == "POST" and path == "/system/speech/voices":
            response_status, response_body = "200 OK", await system_speech_list_voices(parse_json_body(body))
        elif method == "POST" and path == "/tasks/system-speech":
            response_status, response_body = "201 Created", await SPEECH_TASKS.create(parse_json_body(body))
        elif method == "POST" and re.fullmatch(r"/tasks/system-speech/tsk_[A-Za-z0-9_-]{10}/google-translate-progress", path):
            task_id = path.removeprefix("/tasks/system-speech/").removesuffix("/google-translate-progress")
            response_status, response_body = "200 OK", SPEECH_TASKS.google_progress(task_id, parse_json_body(body))
        elif method == "POST" and re.fullmatch(r"/tasks/system-speech/tsk_[A-Za-z0-9_-]{10}/google-translate-complete", path):
            task_id = path.removeprefix("/tasks/system-speech/").removesuffix("/google-translate-complete")
            response_status, response_body = "200 OK", SPEECH_TASKS.google_complete(task_id, parse_json_body(body))
        elif method == "POST" and re.fullmatch(r"/tasks/system-speech/tsk_[A-Za-z0-9_-]{10}/google-translate-fail", path):
            task_id = path.removeprefix("/tasks/system-speech/").removesuffix("/google-translate-fail")
            response_status, response_body = "200 OK", SPEECH_TASKS.google_fail(task_id, parse_json_body(body))
        elif method == "POST" and re.fullmatch(r"/tasks/system-speech/tsk_[A-Za-z0-9_-]{10}/google-translate-audio", path):
            task_id = path.removeprefix("/tasks/system-speech/").removesuffix("/google-translate-audio")
            tokens = query.get("token")
            if not isinstance(tokens, list) or len(tokens) != 1:
                raise AgentApiError("GOOGLE_TRANSLATE_TASK_INVALID", "The Google Translate speech task is invalid.")
            response_status, response_body = "200 OK", await SPEECH_TASKS.google_audio(task_id, tokens[0], body)
        elif method == "POST" and path == "/tasks/capture-frame":
            response_status, response_body = "201 Created", await CAPTURE_FRAME_TASKS.create(parse_json_body(body))
        elif method == "POST" and path == "/media/camera/list":
            response_status, response_body = "200 OK", {"cameras": [camera_public_device(device) for device in await camera_devices()]}
        elif method == "POST" and path == "/media/camera/capture-frame":
            response_status, response_body = "200 OK", await camera_capture_frame(parse_json_body(body))
        elif method == "POST" and path == "/tasks/camera-record":
            response_status, response_body = "201 Created", await CAMERA_RECORD_TASKS.create(parse_json_body(body))
        elif method == "POST" and path == "/tasks/camera-record-audio":
            response_status, response_body = "201 Created", await CAMERA_RECORD_TASKS.create(parse_json_body(body), recording_kind="audio")
        elif method == "POST" and path in {"/youtube/storyboards/info", "/youtube/storyboards/download", "/youtube/storyboards/status", "/youtube/storyboards/cancel"}:
            response_status, response_body = "200 OK", await STORYBOARD_TASKS.dispatch(path.rsplit("/", 1)[1], parse_json_body(body))
        elif method == "POST" and path == "/tasks/visual-map":
            response_status, response_body = "201 Created", await VISUAL_MAP_TASKS.create(parse_json_body(body))
        elif method == "POST" and path == "/media/capture-screen":
            response_status, response_body = "200 OK", await capture_screen(parse_json_body(body))
        elif method == "POST" and path == "/media/image-crop":
            response_status, response_body = "200 OK", await image_crop(parse_json_body(body))
        elif method == "POST" and path == "/media/workspace-image-info":
            _item, response_body = workspace_image_metadata(parse_json_body(body))
            response_status = "200 OK"
        elif method == "POST" and path == "/media/inspect-image":
            response_status, response_body = "200 OK", await inspect_workspace_image(parse_json_body(body))
        elif method == "POST" and path == "/clipboard/status":
            response_status, response_body = "200 OK", clipboard_status(parse_json_body(body))
        elif method == "POST" and path == "/clipboard/get":
            response_status, response_body = "200 OK", await clipboard_get(parse_json_body(body))
        elif method == "POST" and path == "/clipboard/set":
            response_status, response_body = "200 OK", await clipboard_set(parse_json_body(body))
        elif method == "POST" and path == "/internal/library-store-files":
            response_status, response_body = "200 OK", library_store_files(parse_json_body(body))
        elif method == "POST" and path.startswith("/mcp/log/"):
            response_status, response_body = "200 OK", mcp_tool_log(path.removeprefix("/mcp/log/"), parse_json_body(body))
        elif method == "POST" and path == "/youtube/download-formats":
            response_status, response_body = "200 OK", await youtube_download_formats(parse_json_body(body))
        elif method == "POST" and path == "/tasks/youtube-download":
            response_status, response_body = "201 Created", await TASKS.create_download(parse_json_body(body))
        elif method == "POST" and path.startswith("/tasks/visual-map/") and path.endswith("/cancel"):
            task_id = path.removeprefix("/tasks/visual-map/").removesuffix("/cancel").rstrip("/")
            await VISUAL_MAP_TASKS.cancel(task_id)
            response_status, response_body = "202 Accepted", {"accepted": True}
        elif method == "POST" and path.startswith("/tasks/system-speech/") and path.endswith("/cancel"):
            task_id = path.removeprefix("/tasks/system-speech/").removesuffix("/cancel").rstrip("/")
            response_status, response_body = "200 OK", await SPEECH_TASKS.cancel(task_id)
        elif method == "POST" and path.startswith("/tasks/capture-frame/") and path.endswith("/cancel"):
            task_id = path.removeprefix("/tasks/capture-frame/").removesuffix("/cancel").rstrip("/")
            await CAPTURE_FRAME_TASKS.cancel(task_id)
            response_status, response_body = "202 Accepted", {"accepted": True}
        elif method == "POST" and path.startswith("/tasks/capture-frame/") and path.endswith("/diagnostics"):
            task_id = path.removeprefix("/tasks/capture-frame/").removesuffix("/diagnostics").rstrip("/")
            response_status, response_body = "200 OK", CAPTURE_FRAME_TASKS.diagnostics_snapshot(task_id)
        elif method == "POST" and path.startswith("/tasks/camera-record/") and path.endswith("/stop"):
            task_id = path.removeprefix("/tasks/camera-record/").removesuffix("/stop").rstrip("/")
            response_status, response_body = "202 Accepted", await CAMERA_RECORD_TASKS.stop(task_id)
        elif method == "POST" and path.startswith("/tasks/") and path.endswith("/diagnostics"):
            task_id = path.removeprefix("/tasks/").removesuffix("/diagnostics").rstrip("/")
            response_status, response_body = "200 OK", TASKS.diagnostics_snapshot(task_id, parse_json_body(body))
        elif method == "POST" and path.startswith("/tasks/") and path.endswith("/cancel"):
            task_id = path.removeprefix("/tasks/").removesuffix("/cancel").rstrip("/")
            await TASKS.cancel(task_id)
            response_status, response_body = "202 Accepted", {"accepted": True}
        elif method == "GET" and path.startswith("/tasks/visual-map/"):
            response_status, response_body = "200 OK", VISUAL_MAP_TASKS.snapshot(VISUAL_MAP_TASKS.get(path.removeprefix("/tasks/visual-map/")))
        elif method == "GET" and path.startswith("/tasks/system-speech/"):
            response_status, response_body = "200 OK", SPEECH_TASKS.snapshot(SPEECH_TASKS.get(path.removeprefix("/tasks/system-speech/")))
        elif method == "GET" and path.startswith("/tasks/capture-frame/"):
            response_status, response_body = "200 OK", CAPTURE_FRAME_TASKS.snapshot(CAPTURE_FRAME_TASKS.get(path.removeprefix("/tasks/capture-frame/")))
        elif method == "GET" and path.startswith("/tasks/camera-record/"):
            response_status, response_body = "200 OK", CAMERA_RECORD_TASKS.snapshot(CAMERA_RECORD_TASKS.get(path.removeprefix("/tasks/camera-record/")))
        elif method == "GET" and path.startswith("/tasks/"):
            response_status, response_body = "200 OK", TASKS.snapshot(TASKS.get(path.removeprefix("/tasks/")))
        elif method == "POST":
            logical_path = unquote(path.removeprefix("/"))
            response_body = await copy_widget_workspace_path(logical_path)
            writer.write(http_response("200 OK", response_body))
            await writer.drain()
            log("POST /<workspace-image> -> 200 copied")
            return
        elif method == "GET":
            image_file, mime_type = widget_image_file(unquote(path.removeprefix("/")))
            size = image_file.stat().st_size
            writer.write(widget_image_response_headers("200 OK", size, mime_type))
            with image_file.open("rb") as source:
                while chunk := source.read(64 * 1024):
                    writer.write(chunk)
                    await writer.drain()
            await writer.drain()
            log("GET /<workspace-image> -> 200")
            return
        elif not method:
            response_status, response_body = "400 Bad Request", error_document(AgentApiError("BAD_REQUEST", "Invalid HTTP request."))
        else:
            response_status, response_body = "404 Not Found", error_document(AgentApiError("NOT_FOUND", "Unknown local Agent endpoint."))
        writer.write(http_response(response_status, response_body))
        await writer.drain()
        log_path = compact_google_translate_speech_log_path(path, response_body)
        log(f"{method or 'INVALID'} {log_path or '/'} -> {response_status.split()[0]}{response_log_suffix(path, response_body)}")
    except AgentApiError as error:
        status = "404 Not Found" if error.code in {"TASK_NOT_FOUND", "VISUAL_MAP_TASK_NOT_FOUND", "CAMERA_RECORD_TASK_NOT_FOUND", "CAPTURE_FRAME_TASK_NOT_FOUND"} else "400 Bad Request"
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
        async with PUBLIC_SHARE_LOCK:
            await stop_public_share_unlocked()
        await CAPTURE_FRAME_TASKS.shutdown()
        await SPEECH_TASKS.shutdown()
        await STORYBOARD_TASKS.shutdown()
        await VISUAL_MAP_TASKS.shutdown()
        await CAMERA_RECORD_TASKS.shutdown()
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
    clear_console()
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
