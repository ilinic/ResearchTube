"""Stateless Streamable HTTP MCP and a private, bounded Chrome WebSocket bridge.

No new listener, browser credentials, third-party runtime or cloud route is used.
The existing Agent HTTP parser hands only these dedicated endpoints to us.
"""
from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass, field
import hashlib
import json
import math
from pathlib import Path
import re
import secrets
import struct
import time

try:
    from .local_mcp_catalog import CATALOG_JSON, EXTENSION_ID
    from .task_history import TaskHistory
except ImportError:
    from local_mcp_catalog import CATALOG_JSON, EXTENSION_ID
    from task_history import TaskHistory

MAX_MESSAGE = 2 * 1024 * 1024
BASE_TOOLS = frozenset(("youtube_search", "youtube_get_video", "youtube_get_transcript", "youtube_get_comments", "youtube_get_comment_replies", "youtube_get_channel_videos", "youtube_get_channel_playlists", "youtube_get_playlist_videos"))
CATALOG = json.loads(CATALOG_JSON)
DEFINITIONS = {tool["name"]: tool for tool in CATALOG}
RECORD_SCHEMA = DEFINITIONS["youtube_dataset_read"]["outputSchema"]["properties"]["records"]["items"]
ERROR_MESSAGES = {
    "YOUTUBE_LOGIN_REQUIRED": "Sign in to YouTube in the Chrome profile running ResearchTube, then retry.",
    "YOUTUBE_LOGIN_UNKNOWN": "YouTube login state is not ready. Let the page finish loading, then retry.",
    "YOUTUBE_BRIDGE_OFFLINE": "The local YouTube extension connection is unavailable. Keep Chrome open and reload the updated extension.",
    "YOUTUBE_BRIDGE_TIMEOUT": "The YouTube browser request timed out. Check Chrome and retry later.",
    "MCP_TOOL_DISABLED": "This tool is disabled in ResearchTube Settings.",
    "YOUTUBE_REQUEST_FAILED": "YouTube could not complete the request. Check availability and retry delay.",
    "YOUTUBE_EXPORT_SESSION_LOST": "The browser collection session ended. Saved comments are preserved; start a new export.",
    "YOUTUBE_EXPORT_LIMIT": "The collection time or page budget was reached. Saved comments are preserved.",
}


class LocalError(Exception):
    def __init__(self, code, message=None):
        super().__init__(message or ERROR_MESSAGES.get(code, "The local YouTube operation could not complete."))
        self.code = code


def normalized(schema, value, *, project=False):
    """Validate supported schema keywords; output projection drops unknown fields."""
    if "anyOf" in schema:
        for choice in schema["anyOf"]:
            try:
                return normalized(choice, value, project=project)
            except LocalError:
                pass
        raise LocalError("INVALID_ARGUMENT", "Value does not match the tool schema.")
    if "const" in schema and value != schema["const"] or "enum" in schema and value not in schema["enum"]:
        raise LocalError("INVALID_ARGUMENT", "Value is outside the tool's allowed choices.")
    kinds = schema.get("type", [])
    kinds = [kinds] if isinstance(kinds, str) else kinds
    checks = {"null": value is None, "boolean": isinstance(value, bool), "string": isinstance(value, str),
              "integer": isinstance(value, int) and not isinstance(value, bool),
              "number": isinstance(value, (int, float)) and not isinstance(value, bool),
              "object": isinstance(value, dict), "array": isinstance(value, list)}
    if kinds and not any(checks.get(kind, False) for kind in kinds):
        raise LocalError("INVALID_ARGUMENT", "Value has an invalid type.")
    if value is None:
        return None
    if isinstance(value, str):
        if not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", 100000) or "pattern" in schema and re.search(schema["pattern"], value) is None:
            raise LocalError("INVALID_ARGUMENT", "String is outside the tool's limits.")
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(value) or value < schema.get("minimum", -math.inf) or value > schema.get("maximum", math.inf) or value <= schema.get("exclusiveMinimum", -math.inf):
            raise LocalError("INVALID_ARGUMENT", "Number is outside the tool's limits.")
    elif isinstance(value, list):
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 10000):
            raise LocalError("INVALID_ARGUMENT", "Array is outside the tool's limits.")
        return [normalized(schema.get("items", {}), item, project=project) for item in value]
    elif isinstance(value, dict):
        properties = schema.get("properties", {})
        if any(key not in value for key in schema.get("required", [])) or not project and schema.get("additionalProperties") is False and set(value) - set(properties):
            raise LocalError("INVALID_ARGUMENT", "Object fields do not match the tool schema.")
        return {key: normalized(properties[key], item, project=project) for key, item in value.items() if key in properties}
    return value


def response(status, document=None):
    encoded = b"" if document is None else json.dumps(document, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    return (f"HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {len(encoded)}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n").encode("ascii") + encoded


async def read_message(reader, writer=None):
    fragments, opcode = bytearray(), None
    while True:
        first, second = await asyncio.wait_for(reader.readexactly(2), 65)
        final, kind = bool(first & 128), first & 15
        if first & 112 or not second & 128:
            raise LocalError("BRIDGE_PROTOCOL_ERROR")
        size = second & 127
        if size == 126:
            size = struct.unpack("!H", await reader.readexactly(2))[0]
        elif size == 127:
            size = struct.unpack("!Q", await reader.readexactly(8))[0]
        if size > MAX_MESSAGE or len(fragments) + size > MAX_MESSAGE or kind >= 8 and (not final or size > 125):
            raise LocalError("BRIDGE_PROTOCOL_ERROR")
        mask = await reader.readexactly(4)
        raw = await asyncio.wait_for(reader.readexactly(size), 15)
        data = bytes(value ^ mask[index % 4] for index, value in enumerate(raw))
        if kind >= 8:
            if opcode is not None and kind in (9, 10):
                if kind == 9 and writer is not None:
                    await send_frame(writer, data, 10)
                continue
            return kind, data
        if kind not in (0, 1) or kind == 0 and opcode is None or kind == 1 and opcode is not None:
            raise LocalError("BRIDGE_PROTOCOL_ERROR")
        opcode = opcode or kind
        fragments.extend(data)
        if final:
            return opcode, bytes(fragments)


async def send_frame(writer, value, kind=1):
    data = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_MESSAGE:
        raise LocalError("BRIDGE_RESPONSE_TOO_LARGE")
    header = bytes([128 | kind])
    header += bytes([len(data)]) if len(data) < 126 else bytes([126]) + struct.pack("!H", len(data)) if len(data) < 65536 else bytes([127]) + struct.pack("!Q", len(data))
    writer.write(header + data)
    await writer.drain()


@dataclass
class ExportTask:
    task_id: str
    video_id: str
    maximum: int
    sort: str
    include_replies: bool
    status: str = "working"
    phase: str = "queued"
    progress: float = 0
    collected: int = 0
    top_level: int = 0
    replies: int = 0
    pages: int = 0
    truncated: bool = False
    workspace_path: str | None = None
    error: dict | None = None
    runner: asyncio.Task | None = None
    seen: set = field(default_factory=set)


class LocalMcpService:
    def __init__(self, agent):
        self.agent = agent
        self.token = secrets.token_urlsafe(32)
        self.writer = None
        self.extension_version = None
        self.enabled = set(DEFINITIONS)
        self.pending = {}
        self.tasks = TaskHistory(lambda: agent.configured_tool_limits()["completedTaskHistoryLimit"])
        self.send_lock = asyncio.Lock()

    def trusted_host(self, headers, writer):
        address = writer.get_extra_info("sockname")
        return bool(address and headers.get("host") == f"127.0.0.1:{address[1]}")

    async def http(self, method, path, headers, body, reader, writer):
        if not self.trusted_host(headers, writer):
            writer.write(response("403 Forbidden"))
        elif path == "/mcp":
            if headers.get("origin"):
                writer.write(response("403 Forbidden"))
            elif method == "DELETE":
                writer.write(response("405 Method Not Allowed"))  # Stateless: no sessions to delete.
            elif method != "POST":
                writer.write(response("405 Method Not Allowed"))  # No optional SSE stream.
            elif headers.get("content-type", "").split(";", 1)[0].lower() != "application/json":
                writer.write(response("415 Unsupported Media Type"))
            elif headers.get("mcp-protocol-version", "2025-06-18") not in {"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"}:
                writer.write(response("400 Bad Request"))
            else:
                try:
                    document = json.loads(body)
                except (ValueError, UnicodeError):
                    result = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Invalid JSON."}}
                else:
                    result = await self.rpc(document)
                writer.write(response("202 Accepted" if result is None else "200 OK", result))
        elif path == "/internal/local-mcp/bootstrap":
            origin = headers.get("origin")
            if method != "POST" or body != b"{}" or headers.get("x-researchtube-extension") != EXTENSION_ID or origin not in (None, f"chrome-extension://{EXTENSION_ID}"):
                writer.write(response("403 Forbidden"))
            else:
                writer.write(response("200 OK", {"token": self.token, "interfaceVersion": self.agent.INTERFACE_VERSION}))
        elif path == "/internal/local-mcp/bridge":
            await self.attach(method, headers, reader, writer)
            return
        else:
            writer.write(response("404 Not Found"))
        await writer.drain()

    async def attach(self, method, headers, reader, writer):
        try:
            key = headers.get("sec-websocket-key", "")
            valid_key = len(base64.b64decode(key, validate=True)) == 16
        except ValueError:
            valid_key = False
        if method != "GET" or headers.get("origin") != f"chrome-extension://{EXTENSION_ID}" or headers.get("upgrade", "").lower() != "websocket" or "upgrade" not in headers.get("connection", "").lower() or headers.get("sec-websocket-version") != "13" or not valid_key:
            writer.write(response("403 Forbidden"))
            await writer.drain()
            return
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()).decode("ascii")
        writer.write(f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n".encode("ascii"))
        await writer.drain()
        authenticated = False
        try:
            while True:
                kind, raw = await asyncio.wait_for(read_message(reader, writer), 65 if authenticated else 5)
                if kind == 8:
                    break
                if kind == 9:
                    await send_frame(writer, raw, 10)
                    continue
                if kind == 10:
                    continue
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise LocalError("BRIDGE_PROTOCOL_ERROR")
                if message.get("type") == "hello":
                    if set(message) != {"type", "token", "interfaceVersion", "extensionVersion", "enabledTools"} or not secrets.compare_digest(str(message["token"]), self.token) or message["interfaceVersion"] != self.agent.INTERFACE_VERSION or not isinstance(message["extensionVersion"], str) or not re.fullmatch(r"\d+\.\d+\.\d+", message["extensionVersion"]) or not isinstance(message["enabledTools"], list) or any(name not in DEFINITIONS for name in message["enabledTools"]):
                        raise LocalError("BRIDGE_PROTOCOL_ERROR")
                    if self.writer is not None and self.writer is not writer:
                        raise LocalError("BRIDGE_ALREADY_CONNECTED")
                    self.writer, self.extension_version = writer, message["extensionVersion"]
                    self.enabled = set(message["enabledTools"])
                    authenticated = True
                elif not authenticated:
                    raise LocalError("BRIDGE_PROTOCOL_ERROR")
                elif message == {"type": "ping"}:
                    async with self.send_lock:
                        await send_frame(writer, {"type": "pong"})
                elif message.get("type") == "response" and set(message) in ({"type", "id", "result"}, {"type", "id", "error"}):
                    future = self.pending.get(message.get("id"))
                    if future is None or future.done():
                        continue
                    if "error" in message:
                        code = message["error"].get("code") if isinstance(message["error"], dict) else None
                        future.set_exception(LocalError(code if code in ERROR_MESSAGES else "YOUTUBE_REQUEST_FAILED"))
                    else:
                        future.set_result(message["result"])
                else:
                    raise LocalError("BRIDGE_PROTOCOL_ERROR")
        except (LocalError, ValueError, UnicodeError, TypeError, asyncio.TimeoutError, asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            if self.writer is writer:
                self.writer, self.extension_version = None, None
                for future in tuple(self.pending.values()):
                    if not future.done():
                        future.set_exception(LocalError("YOUTUBE_BRIDGE_OFFLINE"))

    async def browser(self, name, arguments):
        writer = self.writer
        if writer is None or writer.is_closing():
            raise LocalError("YOUTUBE_BRIDGE_OFFLINE")
        if len(self.pending) >= 32:
            raise LocalError("YOUTUBE_BRIDGE_BUSY", "The browser request queue is full. Retry later.")
        identifier = secrets.token_hex(16)
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        try:
            async with self.send_lock:
                await send_frame(writer, {"type": "request", "id": identifier, "name": name, "arguments": arguments})
            try:
                return await asyncio.wait_for(future, 90)
            except asyncio.TimeoutError as error:
                raise LocalError("YOUTUBE_BRIDGE_TIMEOUT") from error
        except (ConnectionError, OSError) as error:
            raise LocalError("YOUTUBE_BRIDGE_OFFLINE") from error
        finally:
            self.pending.pop(identifier, None)

    async def rpc(self, request):
        identifier = request.get("id") if isinstance(request, dict) else None
        if not isinstance(request, dict) or request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str) or set(request) - {"jsonrpc", "id", "method", "params"} or identifier is not None and (isinstance(identifier, bool) or not isinstance(identifier, (int, str))):
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid JSON-RPC request."}}
        method, params = request["method"], request.get("params", {})
        if "id" not in request:
            return None
        envelope = {"jsonrpc": "2.0", "id": identifier}
        if method == "initialize":
            requested = params.get("protocolVersion") if isinstance(params, dict) else None
            return {**envelope, "result": {"protocolVersion": requested if requested in {"2025-03-26", "2025-06-18", "2025-11-25"} else "2025-06-18", "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "researchtube-local-youtube", "version": self.agent.AGENT_VERSION}, "instructions": "YouTube research through the local Chrome extension. Productive browser calls require YouTube sign-in. Requests retain the established anonymous page-context transport without account cookies. Export large comment datasets and read them in bounded batches; use local yt-dlp/FFmpeg directly for media."}}
        if method == "ping":
            return {**envelope, "result": {}}
        if method == "tools/list":
            error_schema = {"type": "object", "additionalProperties": False, "properties": {"error": {"type": "object", "additionalProperties": False, "properties": {"code": {"type": "string"}, "message": {"type": "string"}}, "required": ["code", "message"]}}, "required": ["error"]}
            return {**envelope, "result": {"tools": [{**tool, "outputSchema": {"type": "object", "anyOf": [tool["outputSchema"], error_schema]}} for tool in CATALOG]}}
        if method != "tools/call":
            return {**envelope, "error": {"code": -32601, "message": "Method not found."}}
        if not isinstance(params, dict) or set(params) - {"name", "arguments", "_meta"} or params.get("name") not in DEFINITIONS:
            return {**envelope, "error": {"code": -32602, "message": "Unknown tool or invalid call."}}
        name = params["name"]
        try:
            arguments = normalized(DEFINITIONS[name]["inputSchema"], params.get("arguments", {}))
            if name != "youtube_bridge_status" and name not in self.enabled:
                raise LocalError("MCP_TOOL_DISABLED")
            value = await self.call(name, arguments)
            try:
                value = normalized(DEFINITIONS[name]["outputSchema"], value, project=True)
            except LocalError as error:
                raise RuntimeError("Invalid browser response") from error
            if len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > MAX_MESSAGE:
                raise LocalError("YOUTUBE_RESULT_TOO_LARGE", "Request a smaller result or use dataset export.")
            return {**envelope, "result": {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}], "structuredContent": value, "isError": False}}
        except LocalError as error:
            value = {"error": {"code": error.code, "message": str(error)}}
            return {**envelope, "result": {"content": [{"type": "text", "text": json.dumps(value)}], "structuredContent": value, "isError": False}}
        except Exception:
            return {**envelope, "error": {"code": -32603, "message": "The local YouTube operation failed unexpectedly."}}

    async def call(self, name, arguments):
        if name in BASE_TOOLS:
            return await self.browser(name, arguments)
        if name == "youtube_bridge_status":
            return {"connected": self.writer is not None and not self.writer.is_closing(), "extensionVersion": self.extension_version, "interfaceVersion": self.agent.INTERFACE_VERSION, "authentication": "public-page-context"}
        if name == "youtube_comments_export":
            if sum(task.status == "working" for task in self.tasks.values()) >= 4:
                raise LocalError("YOUTUBE_BRIDGE_BUSY", "At most four comment exports may be active.")
            if self.writer is None:
                raise LocalError("YOUTUBE_BRIDGE_OFFLINE")
            # Fail missing login/disabled source tools before creating files or a task.
            await self.browser("__comments_check", {"includeReplies": arguments.get("includeReplies", True)})
            task = ExportTask("tsk_" + secrets.token_urlsafe(7), arguments["videoId"], arguments.get("maxComments", 10000), arguments.get("sort", "newest"), arguments.get("includeReplies", True))
            self.tasks[task.task_id] = task
            task.runner = asyncio.create_task(self.collect(task), name="youtube-comments-export")
            return self.snapshot(task)
        task = self.tasks.get(arguments["taskId"])
        if task is None:
            raise LocalError("YOUTUBE_RESEARCH_TASK_NOT_FOUND", "The task is unavailable after restart or history eviction. Existing Workspace files are preserved.")
        if name == "youtube_research_task_status":
            print(f"[youtube research] {task.task_id} {task.status} {task.progress:g}% ({task.collected} records)")
            return self.snapshot(task)
        if name == "youtube_research_task_cancel":
            if task.status == "working":
                task.status, task.phase = "cancelled", "cancelled"
                task.runner.cancel()
                await asyncio.gather(task.runner, return_exceptions=True)
            return self.snapshot(task)
        if name == "youtube_dataset_read":
            return await asyncio.to_thread(self.read_dataset, task, arguments)
        raise LocalError("INVALID_ARGUMENT")

    def snapshot(self, task):
        return {"taskId": task.task_id, "status": task.status, "phase": task.phase, "progressPercent": task.progress, "pollIntervalMs": 1000, "videoId": task.video_id, "collected": task.collected, "topLevel": task.top_level, "replies": task.replies, "pages": task.pages, "maxComments": task.maximum, "truncated": task.truncated, "workspacePath": task.workspace_path, "error": task.error}

    async def collect(self, task):
        session = None
        started = time.monotonic()
        try:
            task.phase = "collecting"
            destination = self.agent.WorkspacePathResolver().resolve_destination(f"youtube-research/{task.video_id}-{task.task_id}.jsonl", field_name="outputWorkspacePath", error_code="WORKSPACE_PATH_INVALID")
            destination.physical_path.parent.mkdir(parents=True, exist_ok=True)
            with destination.physical_path.open("x", encoding="utf-8", newline="\n") as output:
                task.workspace_path = destination.logical_path
                empty_pages = 0
                while task.collected < task.maximum:
                    if task.pages >= 10000 or time.monotonic() - started > 3600 or empty_pages >= 100:
                        raise LocalError("YOUTUBE_EXPORT_LIMIT")
                    page = await self.browser("__comments_page", {"videoId": task.video_id, "sort": task.sort, "includeReplies": task.include_replies, "sessionId": session})
                    if not isinstance(page, dict) or set(page) != {"sessionId", "records", "hasMore"} or not isinstance(page["sessionId"], str) or not re.fullmatch(r"exp_[A-Za-z0-9_-]{16,64}", page["sessionId"]) or not isinstance(page["records"], list) or len(page["records"]) > 1000 or not isinstance(page["hasMore"], bool):
                        raise LocalError("YOUTUBE_REQUEST_FAILED")
                    session = page["sessionId"]
                    task.pages += 1
                    before = task.collected
                    unread = False
                    for raw in page["records"]:
                        record = normalized(RECORD_SCHEMA, raw, project=True)
                        if record["videoId"] != task.video_id:
                            raise LocalError("YOUTUBE_REQUEST_FAILED")
                        if record["commentId"] in task.seen:
                            continue
                        if task.collected >= task.maximum:
                            unread = True
                            break
                        output.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")
                        task.seen.add(record["commentId"])
                        task.collected += 1
                        if record["parentCommentId"] is None:
                            task.top_level += 1
                        else:
                            task.replies += 1
                    output.flush()
                    task.progress = max(task.progress, min(99, round(100 * task.collected / task.maximum, 2)))
                    empty_pages = empty_pages + 1 if before == task.collected else 0
                    if not page["hasMore"]:
                        task.truncated = unread
                        break
                    if task.collected >= task.maximum:
                        task.truncated = True
                        break
                    await asyncio.sleep(0.3)
            task.status, task.phase, task.progress = "completed", "completed", 100
        except asyncio.CancelledError:
            task.status, task.phase = "cancelled", "cancelled"
        except Exception as error:
            code = error.code if isinstance(error, LocalError) else "YOUTUBE_EXPORT_FAILED"
            task.status, task.phase = "failed", "failed"
            task.error = {"code": code, "message": ERROR_MESSAGES.get(code, "Comment collection failed. Saved records are preserved.")}
        finally:
            task.seen.clear()
            if session and self.writer is not None:
                try:
                    await asyncio.wait_for(self.browser("__comments_close", {"sessionId": session}), 5)
                except (Exception, asyncio.CancelledError):
                    pass

    def read_dataset(self, task, arguments):
        limit, offset = arguments.get("limit", 20), arguments.get("offset", 0)
        matches, records = 0, []
        if task.workspace_path:
            source = self.agent.WorkspacePathResolver().resolve_existing(task.workspace_path, field_name="workspacePath", expected_type="file")
            with source.physical_path.open(encoding="utf-8") as stream:
                for line in stream:
                    if not line.endswith("\n"):
                        break  # A concurrent page publication has not finished this record.
                    record = normalized(RECORD_SCHEMA, json.loads(line), project=True)
                    if arguments.get("query", "").casefold() not in record["text"].casefold() or "parentCommentId" in arguments and record["parentCommentId"] != arguments["parentCommentId"]:
                        continue
                    if matches >= offset:
                        records.append(record)
                    matches += 1
                    if len(records) > limit:
                        break
        return {"records": records[:limit], "returned": min(len(records), limit), "nextOffset": offset + limit if len(records) > limit else None, "collected": task.collected}

    async def shutdown(self):
        for task in self.tasks.values():
            if task.runner and not task.runner.done():
                task.runner.cancel()
        await asyncio.gather(*(task.runner for task in self.tasks.values() if task.runner), return_exceptions=True)
        if self.writer:
            self.writer.close()
