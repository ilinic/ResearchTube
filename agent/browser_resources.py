"""Private browser-byte ingestion; no URL fetching, cookies or host paths."""
from __future__ import annotations

import re


def resource_format(data: bytes, declared: str) -> tuple[str, str]:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", "jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif", "gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp", "webp"
    if data.startswith(b"RIFF") and data[8:12] == b"WAVE":
        return "audio/wav", "wav"
    if data.startswith(b"%PDF-"):
        return "application/pdf", "pdf"
    if data.startswith(b"ID3") or len(data) >= 2 and data[0] == 255 and data[1] & 224 == 224:
        return "audio/mpeg", "mp3"
    if data.startswith(b"OggS"):
        return "audio/ogg", "ogg"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand in (b"avif", b"avis"):
            return "image/avif", "avif"
        return ("audio/mp4", "m4a") if declared == "audio/mp4" else ("video/mp4", "mp4")
    if data.startswith(b"\x1aE\xdf\xa3"):
        return ("audio/webm", "webm") if declared == "audio/webm" else ("video/webm", "webm")
    if re.match(rb"\s*(?:<\?xml[^>]*>\s*)?(?:<!DOCTYPE\s+svg[^>]*>\s*)?<svg(?:\s|>)", data[:4096]):
        return "image/svg+xml", "svg"
    extensions = {"text/plain": "txt", "text/html": "html", "application/json": "json", "application/zip": "zip", "application/octet-stream": "bin"}
    if declared in extensions:
        return declared, extensions[declared]
    raise ValueError("The browser response does not contain a supported resource format.")


def save_browser_resource(body: bytes, task_id: str, mime_type: str, maximum: int, resolver, error_type) -> dict:
    if not re.fullmatch(r"tsk_[A-Za-z0-9_-]{10}", task_id or ""):
        raise error_type("BROWSER_INVALID", "Browser resource taskId must use the standard task format.")
    if not body or len(body) > maximum:
        raise error_type("BROWSER_RESOURCE_TOO_LARGE", f"Browser resource must contain 1–{maximum} bytes (configured upload maximum).")
    try:
        normalized_mime, extension = resource_format(body, mime_type.split(";", 1)[0].strip().lower())
    except ValueError as error:
        raise error_type("BROWSER_RESOURCE_INVALID", str(error)) from error
    logical = f"study-this-site/resource [browser_{task_id}].{extension}"
    output = resolver.resolve_destination(logical, field_name="workspacePath", error_code="BROWSER_INVALID")
    output.physical_path.parent.mkdir(parents=True, exist_ok=True)
    # Re-resolve after mkdir to detect a substituted/symlinked output directory.
    output = resolver.resolve_destination(logical, field_name="workspacePath", error_code="BROWSER_INVALID")
    try:
        with output.physical_path.open("xb") as stream:
            stream.write(body)
    except FileExistsError as error:
        raise error_type("BROWSER_DESTINATION_EXISTS", "This browser resource output already exists; it was not overwritten.") from error
    except OSError as error:
        raise error_type("BROWSER_RESOURCE_UNAVAILABLE", "The browser resource could not be saved in Workspace.") from error
    return {"workspacePath": logical, "mimeType": normalized_mime, "sizeBytes": len(body)}
