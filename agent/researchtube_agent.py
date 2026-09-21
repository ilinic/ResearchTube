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
import hashlib
import json
import math
import mimetypes
import os
import platform
import re
import secrets
import shutil
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlparse

AGENT_VERSION = "0.16.2"
INTERFACE_VERSION = 15
DEFAULT_PORT = 17843
MAX_REQUEST_BODY_BYTES = 64 * 1024
TASK_POLL_INTERVAL_MS = 1_000
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
DEFAULT_DOWNLOAD_DIRECTORY = "downloads"
MAX_LOGICAL_PATH_LENGTH = 1_024
MAX_LOGICAL_COMPONENT_LENGTH = 240
MAX_WORKSPACE_LIST_ENTRIES = 500
MEDIA_PROBE_TIMEOUT_SECONDS = 15
CAPTURE_FRAME_TIMEOUT_SECONDS = 60
YOUTUBE_CAPTURE_FRAME_TIMEOUT_SECONDS = 90
YOUTUBE_CAPTURE_PRE_ROLL_SECONDS = 12.0
YOUTUBE_CAPTURE_POST_ROLL_SECONDS = 3.0
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


def executable_names(name: str) -> tuple[str, ...]:
    return (f"{name}.exe", name) if os.name == "nt" else (name, f"{name}.exe")


COMPONENTS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "ytDlp": (executable_names("yt-dlp"), ("--version",)),
    "deno": (executable_names("deno"), ("--version",)),
    "ffmpeg": (executable_names("ffmpeg"), ("-version",)),
    "ffprobe": (executable_names("ffprobe"), ("-version",)),
    "cloudflared": (executable_names("cloudflared"), ("--version",)),
}
COMPONENT_LABELS = {"ytDlp": "yt-dlp", "deno": "Deno", "ffmpeg": "ffmpeg", "ffprobe": "ffprobe", "cloudflared": "cloudflared"}
COMPONENT_TOOL_DIRECTORIES = {"ytDlp": "yt-dlp", "deno": "deno", "ffmpeg": "ffmpeg", "ffprobe": "ffmpeg", "cloudflared": "cloudflared"}
PUBLIC_TUNNEL_URL: str | None = None
PUBLIC_TUNNEL_PROCESS: asyncio.subprocess.Process | None = None
PUBLIC_TUNNEL_READY = asyncio.Event()
PUBLIC_TUNNEL_WATCHERS: list[asyncio.Task[None]] = []
PUBLIC_IMAGE_ROUTE_PREFIX = "/image/"
PUBLIC_IMAGE_CAPTURE_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{8,64}")
PUBLIC_ROBOTS_TEXT = b"""# ResearchTube captured-frame endpoint: public access is intentional.\n# These groups are repeated after any Cloudflare-managed directives so the\n# origin explicitly grants the OpenAI crawlers and user-directed fetcher access.\n\nUser-agent: OAI-SearchBot\nContent-Signal: search=yes,ai-input=yes,ai-train=no,use=full\nAllow: /\n\nUser-agent: ChatGPT-User\nContent-Signal: search=yes,ai-input=yes,ai-train=no,use=full\nAllow: /\n\nUser-agent: GPTBot\nContent-Signal: search=yes,ai-input=yes,ai-train=no,use=full\nAllow: /\n\nUser-agent: *\nContent-Signal: search=yes,ai-input=yes,ai-train=no,use=full\nAllow: /\n"""


@dataclass(frozen=True)
class ComponentDiscovery:
    source: str | None
    executable: str | None
    error: str | None = None


def log(message: str, *, error: bool = False) -> None:
    prefix = datetime.now().strftime("[%H:%M:%S]")
    print(f"{prefix} {'ERROR ' if error else ''}{message}", file=sys.stderr if error else sys.stdout, flush=True)


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
        "platform": public_platform_metadata(), "workspace": workspace_health(), "components": dict(results),
    }


def public_platform_metadata() -> dict[str, str]:
    """Return portable OS facts without host, user, path, or network identity."""
    return {
        "operatingSystem": platform.system() or "Unknown",
        "release": platform.release() or "Unknown",
        "version": platform.version() or "Unknown",
        "architecture": platform.machine() or "Unknown",
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
    }


def log_startup_health(health: dict[str, Any], port: int) -> None:
    log(f"ResearchTube Agent {AGENT_VERSION} started")
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
    youtube_get_download_formats workflow, not the advisory YouTube snapshot.
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
        raise AgentApiError("INVALID_REQUEST", "youtube_get_download_formats requires a JSON object.")
    video_id = validate_video_id(payload.get("videoId"))
    yt_dlp = find_component("ytDlp", COMPONENTS["ytDlp"][0])
    if yt_dlp.error:
        raise AgentApiError("YTDLP_DISCOVERY_ERROR", "yt-dlp discovery is ambiguous.", yt_dlp.error)
    if not yt_dlp.executable:
        raise AgentApiError("YTDLP_NOT_AVAILABLE", "yt-dlp is not available. Place it in tools/yt-dlp or install it on PATH.")
    deno_executable = resolve_deno_runtime()
    command = [
        yt_dlp.executable, *yt_dlp_js_runtime_arguments(deno_executable),
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
    limit = payload.get("limit", 100)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_WORKSPACE_LIST_ENTRIES:
        raise AgentApiError("INVALID_REQUEST", f"limit must be an integer from 1 to {MAX_WORKSPACE_LIST_ENTRIES}.")
    directory = WorkspacePathResolver().resolve_existing(path, field_name="path", expected_type="directory", allow_root=True)
    try:
        children = sorted(directory.physical_path.iterdir(), key=lambda item: (item.name.casefold(), item.name))[:limit]
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
        logical_path = f"{directory.logical_path}/{child.name}" if directory.logical_path else child.name
        entries.append({"name": child.name, "path": logical_path, "type": entry_type, "size": size})
    log(f"workspace_list path={directory.logical_path or '<root>'} -> ok")
    return {"path": directory.logical_path, "entries": entries, "returned": len(entries), "limit": limit}


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


def capture_default_workspace_path(source_path: str, timestamp_seconds: float, image_format: str) -> str:
    """Name an automatically created capture as a normal workspace artifact.

    Use the source filename's human-readable title and stable yt ID when
    available.  The download task ID is intentionally not propagated: it
    identifies one download operation, whereas a capture needs to identify
    the video it depicts.  Its own random capture ID prevents collisions.
    """
    source_stem = Path(source_path).stem.strip()
    match = re.search(r"\s+\[yt_([A-Za-z0-9_-]+)\]", source_stem)
    title = source_stem[:match.start()].strip() if match else source_stem
    title = title or "ResearchTube frame"
    video_part = f" [yt_{match.group(1)}]" if match else ""
    timestamp_part = f"{timestamp_seconds:.3f}".replace("-", "_")
    capture_id = secrets.token_urlsafe(12)
    return f"captures/{title}{video_part} [t_{timestamp_part}] [cap_{capture_id}].{image_format}"


def capture_output_path(value: Any, source_path: str, timestamp_seconds: float, image_format: str) -> dict[str, Any]:
    if value is not None and (not isinstance(value, str) or not value):
        raise AgentApiError("CAPTURE_FRAME_INVALID", "outputPath must be a non-empty logical workspace path.")
    return {
        "path": value or capture_default_workspace_path(source_path, timestamp_seconds, image_format),
        "provided": value is not None,
    }


def capture_public_id(logical_path: str) -> str:
    """Return a stable opaque ID without retaining a path-to-ID table.

    Automatically named captures already contain a random [cap_<id>] marker.
    A caller may supply a custom workspace filename, though, so fall back to a
    deterministic digest of the logical path.  The image server derives this
    value again while scanning only the requested directory.
    """
    match = re.search(r"\[cap_([A-Za-z0-9_-]{8,64})\]", logical_path)
    if match:
        return match.group(1)
    return hashlib.sha256(logical_path.encode("utf-8")).hexdigest()[:32]


def public_image_url(logical_path: str) -> str:
    if PUBLIC_TUNNEL_URL is None:
        raise AgentApiError("PUBLIC_IMAGE_URL_UNAVAILABLE", "The public image tunnel is not ready. Confirm that cloudflared is available and wait for the Agent startup message.")
    parts, _ = WorkspacePathResolver.logical_parts(logical_path, field_name="workspace output", error_code="CAPTURE_FRAME_FAILED")
    if len(parts) < 2:
        directory_parts: tuple[str, ...] = ()
    else:
        directory_parts = parts[:-1]
    route = "/".join(quote(part, safe="") for part in (*directory_parts, capture_public_id(logical_path)))
    return f"{PUBLIC_TUNNEL_URL}{PUBLIC_IMAGE_ROUTE_PREFIX}{route}"


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
            "formatId": parse_download_selection({"video": youtube_item["formatId"]}).video or "",
        }
        if not re.fullmatch(r"[0-9]+", youtube["formatId"]):
            raise AgentApiError("CAPTURE_FRAME_INVALID", "youtube.formatId must be a numeric ID returned by youtube_get_download_formats.")
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
                "publicUrl": public_image_url(logical_output_path),
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
    title = re.sub(r'[\x00-\x1f<>:"/\\|?*]+', " ", value)
    title = re.sub(r"\s+", " ", title).strip(" .")
    if not title:
        return "YouTube frame"
    if title.split(".", 1)[0].upper() in WINDOWS_RESERVED_BASENAMES:
        title = f"YouTube {title}"
    return title[:160].rstrip(" .") or "YouTube frame"


def youtube_capture_default_workspace_path(title: str, video_id: str, timestamp_seconds: float, image_format: str) -> str:
    timestamp_part = f"{timestamp_seconds:.3f}".replace("-", "_")
    capture_id = secrets.token_urlsafe(12)
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
        raise AgentApiError("CAPTURE_VIDEO_FORMAT_NOT_AVAILABLE", "youtube.formatId must be a currently available video or combined format from youtube_get_download_formats.")

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
        yt_dlp.executable, *yt_dlp_js_runtime_arguments(resolve_deno_runtime()), "--ignore-config", "--no-playlist", "--no-part",
        "--windows-filenames", "--download-sections", f"*{section_start:.3f}-{section_end:.3f}", "--downloader", "ffmpeg",
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


IMAGE_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


def workspace_image(payload: Any) -> dict[str, Any]:
    """Read one workspace image for the capture-frame MCP App only.

    The Agent remains the sole filesystem owner.  This endpoint deliberately
    returns a logical path plus encoded bytes, never a host path; the
    Extension places the bytes in widget-only MCP metadata.
    """
    if not isinstance(payload, dict) or set(payload) != {"path"}:
        raise AgentApiError("WORKSPACE_IMAGE_INVALID", "workspace image retrieval requires only path.")
    item = WorkspacePathResolver().resolve_existing(payload.get("path"), field_name="path", expected_type="file")
    mime_type = IMAGE_MIME_TYPES.get(item.physical_path.suffix.lower())
    if mime_type is None:
        raise AgentApiError("WORKSPACE_IMAGE_INVALID", "path must identify a PNG, JPEG, or WebP image in the workspace.")
    try:
        image_bytes = item.physical_path.read_bytes()
    except OSError as error:
        raise AgentApiError("WORKSPACE_IMAGE_UNAVAILABLE", "The workspace image could not be read.") from error
    return {
        "path": item.logical_path,
        "mimeType": mime_type,
        "imageSizeBytes": len(image_bytes),
        "inlineImageBase64": base64.b64encode(image_bytes).decode("ascii"),
    }


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
            task.result = {"videoId": task.video_id, "filePath": relative_file, "fileName": output_file.name, "outputDir": task.output_directory_relative}
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
        "Access-Control-Allow-Headers: Content-Type", "Connection: close", "", "",
    ]
    return "\r\n".join(headers).encode("ascii") + encoded


def image_response(status: str, image_bytes: bytes = b"", mime_type: str = "text/plain; charset=utf-8") -> bytes:
    headers = [
        f"HTTP/1.1 {status}", f"Content-Type: {mime_type}", f"Content-Length: {len(image_bytes)}",
        "X-Content-Type-Options: nosniff", "Cache-Control: no-store", "Connection: close", "", "",
    ]
    return "\r\n".join(headers).encode("ascii") + image_bytes


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


def public_image_file(path: str) -> tuple[Path, str]:
    """Resolve a single captured image from the intentionally narrow public route."""
    if not path.startswith(PUBLIC_IMAGE_ROUTE_PREFIX):
        raise AgentApiError("PUBLIC_IMAGE_NOT_FOUND", "Unknown public image path.")
    encoded_segments = path.removeprefix(PUBLIC_IMAGE_ROUTE_PREFIX).split("/")
    if not encoded_segments or any(not segment for segment in encoded_segments):
        raise AgentApiError("PUBLIC_IMAGE_NOT_FOUND", "Invalid public image path.")
    try:
        segments = tuple(unquote(segment, encoding="utf-8", errors="strict") for segment in encoded_segments)
    except UnicodeDecodeError as error:
        raise AgentApiError("PUBLIC_IMAGE_NOT_FOUND", "Invalid public image path.") from error
    if any("/" in segment or "\\" in segment for segment in segments):
        raise AgentApiError("PUBLIC_IMAGE_NOT_FOUND", "Invalid public image path.")
    capture_id = segments[-1]
    if not PUBLIC_IMAGE_CAPTURE_ID_PATTERN.fullmatch(capture_id):
        raise AgentApiError("PUBLIC_IMAGE_NOT_FOUND", "Invalid capture ID.")
    directory_path = "/".join(segments[:-1])
    resolver = WorkspacePathResolver()
    try:
        directory = resolver.resolve_existing(directory_path, field_name="public image directory", expected_type="directory", allow_root=True)
    except AgentApiError as error:
        raise AgentApiError("PUBLIC_IMAGE_NOT_FOUND", "Captured image was not found.") from error
    candidates: list[Path] = []
    try:
        for candidate in directory.physical_path.iterdir():
            if candidate.is_symlink() or not candidate.is_file() or candidate.suffix.lower() not in IMAGE_MIME_TYPES:
                continue
            logical_path = resolver.logical_existing_file(candidate, error_code="PUBLIC_IMAGE_NOT_FOUND")
            if capture_public_id(logical_path) == capture_id:
                candidates.append(candidate.resolve(strict=True))
    except OSError as error:
        raise AgentApiError("PUBLIC_IMAGE_NOT_FOUND", "Captured image is unavailable.") from error
    if len(candidates) != 1:
        raise AgentApiError("PUBLIC_IMAGE_NOT_FOUND", "Captured image was not found.")
    image_file = candidates[0]
    mime_type = IMAGE_MIME_TYPES.get(image_file.suffix.lower())
    if mime_type is None:
        raise AgentApiError("PUBLIC_IMAGE_NOT_FOUND", "Captured image was not found.")
    return image_file, mime_type


async def handle_public_image_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        method, path, body = await read_request(reader)
        if method == "GET" and path == "/robots.txt" and not body:
            writer.write(image_response("200 OK", PUBLIC_ROBOTS_TEXT, "text/plain; charset=utf-8"))
        elif method != "GET" or body:
            writer.write(image_response("404 Not Found"))
        else:
            image_file, mime_type = public_image_file(path)
            writer.write(image_response("200 OK", image_file.read_bytes(), mime_type))
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
                log(f"Public image tunnel: {PUBLIC_TUNNEL_URL}")
    except (OSError, asyncio.CancelledError):
        return


async def start_public_image_tunnel(port: int) -> None:
    global PUBLIC_TUNNEL_PROCESS, PUBLIC_TUNNEL_WATCHERS
    cloudflared = find_component("cloudflared", COMPONENTS["cloudflared"][0])
    if cloudflared.error:
        log("cloudflared discovery is ambiguous; public image URLs are unavailable.", error=True)
        return
    if not cloudflared.executable:
        log("cloudflared is unavailable; public image URLs are unavailable.", error=True)
        return
    try:
        PUBLIC_TUNNEL_PROCESS = await asyncio.create_subprocess_exec(
            cloudflared.executable, "tunnel", "--url", f"http://127.0.0.1:{port}",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    except OSError as error:
        log(f"cloudflared could not start: {error.__class__.__name__}", error=True)
        return
    PUBLIC_TUNNEL_WATCHERS = [
        asyncio.create_task(watch_cloudflared_stream(PUBLIC_TUNNEL_PROCESS.stdout)),
        asyncio.create_task(watch_cloudflared_stream(PUBLIC_TUNNEL_PROCESS.stderr)),
    ]


async def stop_public_image_tunnel() -> None:
    global PUBLIC_TUNNEL_PROCESS, PUBLIC_TUNNEL_URL, PUBLIC_TUNNEL_WATCHERS
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


def parse_json_body(body: bytes) -> Any:
    if not body:
        return {}
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AgentApiError("INVALID_JSON", "The request body must be valid UTF-8 JSON.") from error


def task_response_log_suffix(path: str, body: dict[str, Any] | None) -> str:
    """Add the available native download percentage to the HTTP console line."""
    if not path.startswith("/tasks/") or not isinstance(body, dict) or "taskId" not in body:
        return ""
    progress = body.get("progressPercent")
    if isinstance(progress, (int, float)) and not isinstance(progress, bool) and 0 <= progress <= 100:
        percentage = f"{progress:.1f}".rstrip("0").rstrip(".")
        return f" ({percentage}%)"
    return ""


async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    method, path = "", ""
    try:
        method, path, body = await read_request(reader)
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
        elif method == "POST" and path == "/media/probe":
            response_status, response_body = "200 OK", await media_probe(parse_json_body(body))
        elif method == "POST" and path == "/media/capture-frame":
            response_status, response_body = "200 OK", await capture_frame(parse_json_body(body))
        elif method == "POST" and path == "/media/workspace-image":
            response_status, response_body = "200 OK", workspace_image(parse_json_body(body))
        elif method == "POST" and path == "/youtube/download-formats":
            response_status, response_body = "200 OK", await youtube_download_formats(parse_json_body(body))
        elif method == "POST" and path == "/tasks/youtube-download":
            response_status, response_body = "201 Created", await TASKS.create_download(parse_json_body(body))
        elif method == "POST" and path.startswith("/tasks/") and path.endswith("/diagnostics"):
            task_id = path.removeprefix("/tasks/").removesuffix("/diagnostics").rstrip("/")
            response_status, response_body = "200 OK", TASKS.diagnostics_snapshot(task_id, parse_json_body(body))
        elif method == "POST" and path.startswith("/tasks/") and path.endswith("/cancel"):
            task_id = path.removeprefix("/tasks/").removesuffix("/cancel").rstrip("/")
            await TASKS.cancel(task_id)
            response_status, response_body = "202 Accepted", {"accepted": True}
        elif method == "GET" and path.startswith("/tasks/"):
            response_status, response_body = "200 OK", TASKS.snapshot(TASKS.get(path.removeprefix("/tasks/")))
        elif not method:
            response_status, response_body = "400 Bad Request", error_document(AgentApiError("BAD_REQUEST", "Invalid HTTP request."))
        else:
            response_status, response_body = "404 Not Found", error_document(AgentApiError("NOT_FOUND", "Unknown local Agent endpoint."))
        writer.write(http_response(response_status, response_body))
        await writer.drain()
        log(f"{method or 'INVALID'} {path or '/'} -> {response_status.split()[0]}{task_response_log_suffix(path, response_body)}")
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
    image_server = await asyncio.start_server(handle_public_image_client, host="127.0.0.1", port=0)
    image_socket = next(iter(image_server.sockets or ()), None)
    if image_socket is None:
        image_server.close()
        await image_server.wait_closed()
        server.close()
        await server.wait_closed()
        raise OSError("The public image server did not receive a local port.")
    image_port = image_socket.getsockname()[1]
    await start_public_image_tunnel(image_port)
    if PUBLIC_TUNNEL_PROCESS is not None:
        try:
            await asyncio.wait_for(PUBLIC_TUNNEL_READY.wait(), timeout=15)
        except asyncio.TimeoutError:
            log("cloudflared did not provide a public URL within 15 seconds; capture_frame will report the tunnel as unavailable.", error=True)
    log_startup_health(initial_health, port)
    log(f"Image-only server listening on 127.0.0.1:{image_port}")
    try:
        async with server, image_server:
            await server.serve_forever()
    finally:
        await stop_public_image_tunnel()
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
