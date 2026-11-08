"""Local MCP wire protocol, paired browser transport and bounded research tasks."""
import asyncio
import base64
import json
from pathlib import Path
import secrets
import struct
import tempfile
import unittest
from unittest.mock import patch

from agent import researchtube_agent as agent
from agent.local_mcp import LocalMcpService, LocalError, EXTENSION_ID, CATALOG, normalized


def record(index, parent=None):
    return {"videoId": "abcdefghijk", "commentId": str(index), "parentCommentId": parent,
            "author": {"name": "Автор", "channelId": None}, "text": f"Comment {index} Привет",
            "publishedAt": None, "publishedText": "today", "likes": 0,
            "authorIsCreator": False, "isHearted": False}


async def client_frame(writer, value):
    data = json.dumps(value).encode()
    mask = b"abcd"
    header = bytes([129, 128 | len(data)]) if len(data) < 126 else bytes([129, 254]) + struct.pack("!H", len(data)) if len(data) < 65536 else bytes([129, 255]) + struct.pack("!Q", len(data))
    writer.write(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
    await writer.drain()


async def server_frame(reader):
    first, size = await asyncio.wait_for(reader.readexactly(2), 3)
    size &= 127
    if size == 126:
        size = struct.unpack("!H", await reader.readexactly(2))[0]
    elif size == 127:
        size = struct.unpack("!Q", await reader.readexactly(8))[0]
    return json.loads(await reader.readexactly(size))


class LocalMcpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.workspace = patch.object(agent, "WORKSPACE_PATH", Path(self.folder.name))
        self.workspace.start()
        self.service = LocalMcpService(agent)
        self.service_patch = patch.object(agent, "LOCAL_MCP", self.service)
        self.service_patch.start()
        self.server = await asyncio.start_server(agent.handle_client, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        self.clients = []

    async def asyncTearDown(self):
        await self.service.shutdown()
        for writer in self.clients:
            writer.close()
            await writer.wait_closed()
        self.server.close()
        await self.server.wait_closed()
        await asyncio.sleep(0)
        self.service_patch.stop()
        self.workspace.stop()
        self.folder.cleanup()

    async def http(self, path="/mcp", payload=None, headers=None, method="POST"):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        body = b"" if payload is None else json.dumps(payload).encode()
        fields = {"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json", "Content-Length": str(len(body)), **(headers or {})}
        writer.write((f"{method} {path} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in fields.items()) + "\r\n").encode() + body)
        await writer.drain()
        raw = await asyncio.wait_for(reader.read(), 5)
        writer.close()
        await writer.wait_closed()
        header, raw_body = raw.split(b"\r\n\r\n", 1)
        return int(header.split()[1]), json.loads(raw_body) if raw_body else None

    async def rpc(self, name, arguments=None):
        return await self.service.rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments or {}}})

    async def bridge(self, token=None):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        self.clients.append(writer)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        writer.write((f"GET /internal/local-mcp/bridge HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nOrigin: chrome-extension://{EXTENSION_ID}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n\r\n").encode())
        await writer.drain()
        header = await reader.readuntil(b"\r\n\r\n")
        self.assertIn(b"101 Switching Protocols", header)
        await client_frame(writer, {"type": "hello", "token": token or self.service.token, "interfaceVersion": agent.INTERFACE_VERSION, "extensionVersion": "2.11.0", "enabledTools": [t["name"] for t in CATALOG]})
        # Ping is an acknowledgement that the hello was accepted.
        await client_frame(writer, {"type": "ping"})
        return reader, writer

    async def test_mcp_initialize_catalog_and_notifications_without_extension(self):
        code, reply = await self.http(payload={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}})
        self.assertEqual((code, reply["result"]["protocolVersion"]), (200, "2025-06-18"))
        _, reply = await self.http(payload={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual(len(reply["result"]["tools"]), 13)
        self.assertEqual(await self.http(payload={"jsonrpc": "2.0", "method": "notifications/initialized"}), (202, None))
        _, status = await self.http(payload={"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "youtube_bridge_status"}})
        self.assertFalse(status["result"]["structuredContent"]["connected"])

    async def test_http_rejects_web_origins_dns_rebinding_and_wrong_content_type(self):
        for headers in ({"Origin": "https://evil.invalid"}, {"Host": "evil.invalid"}):
            self.assertEqual((await self.http(payload={}, headers=headers))[0], 403)
        self.assertEqual((await self.http(payload={}, headers={"Content-Type": "text/plain"}))[0], 415)
        self.assertEqual((await self.http(method="GET"))[0], 405)
        self.assertEqual((await self.http(payload={}, headers={"MCP-Protocol-Version": "bad"}))[0], 400)

    async def test_bootstrap_requires_exact_extension_and_no_external_origin(self):
        path = "/internal/local-mcp/bootstrap"
        self.assertEqual((await self.http(path, {}))[0], 403)
        self.assertEqual((await self.http(path, {}, {"X-ResearchTube-Extension": EXTENSION_ID, "Origin": "https://evil.invalid"}))[0], 403)
        code, value = await self.http(path, {}, {"X-ResearchTube-Extension": EXTENSION_ID})
        self.assertEqual(code, 200)
        self.assertEqual(value["token"], self.service.token)

    async def test_paired_websocket_roundtrip_projects_output_and_fails_pending_on_disconnect(self):
        reader, writer = await self.bridge()
        self.assertEqual(await server_frame(reader), {"type": "pong"})
        request = asyncio.create_task(self.rpc("youtube_search", {"query": "topic"}))
        command = await server_frame(reader)
        await client_frame(writer, {"type": "response", "id": command["id"], "result": {"query": "topic", "results": [], "returned": 0, "requested": 10, "hasMore": False, "Cookie": "SECRET"}})
        reply = await request
        self.assertEqual(reply["result"]["structuredContent"]["query"], "topic")
        self.assertNotIn("SECRET", json.dumps(reply))
        pending = asyncio.create_task(self.service.browser("youtube_search", {"query": "again"}))
        await server_frame(reader)
        writer.close()
        with self.assertRaisesRegex(LocalError, "extension connection"):
            await pending

    async def test_wrong_pairing_token_cannot_connect(self):
        reader, _ = await self.bridge("x" * 43)
        self.assertEqual(await asyncio.wait_for(reader.read(), 2), b"")
        self.assertIsNone(self.service.writer)

    async def test_strict_inputs_and_offline_are_structured(self):
        for arguments in ({"query": "x", "cookies": "SECRET"}, {"query": "x", "limit": True}):
            result = await self.rpc("youtube_search", arguments)
            self.assertEqual(result["result"]["structuredContent"]["error"]["code"], "INVALID_ARGUMENT")
            self.assertNotIn("SECRET", json.dumps(result))
        result = await self.rpc("youtube_search", {"query": "x"})
        self.assertEqual(result["result"]["structuredContent"]["error"]["code"], "YOUTUBE_BRIDGE_OFFLINE")
        self.assertFalse(result["result"]["isError"])

    async def start_export(self, pages, maximum=10000):
        self.service.writer = type("Writer", (), {"is_closing": lambda s: False, "close": lambda s: None})()
        async def browser(name, args):
            if name == "__comments_check":
                return {"ready": True}
            if name == "__comments_close":
                return {"closed": True}
            value = next(pages)
            if isinstance(value, Exception):
                raise value
            return value
        self.service.browser = browser
        value = await self.service.call("youtube_comments_export", {"videoId": "abcdefghijk", "maxComments": maximum})
        return self.service.tasks[value["taskId"]]

    async def test_large_export_deduplication_projection_and_dataset_pagination(self):
        rows = [record(i, "0" if i % 2 else None) for i in range(5000)]
        rows[0]["cookie"] = "SECRET"
        pages = [{"sessionId": "exp_" + "a" * 32, "records": rows[i:i+1000], "hasMore": i < 4000} for i in range(0, 5000, 1000)]
        pages.insert(1, {"sessionId": "exp_" + "a" * 32, "records": rows[:3], "hasMore": True})
        task = await self.start_export(iter(pages))
        await task.runner
        self.assertEqual((task.status, task.collected, task.top_level, task.replies, task.progress), ("completed", 5000, 2500, 2500, 100))
        path = Path(self.folder.name) / task.workspace_path
        self.assertEqual(len(path.read_text(encoding="utf-8").splitlines()), 5000)
        self.assertNotIn("SECRET", path.read_text(encoding="utf-8"))
        first = await self.service.call("youtube_dataset_read", {"taskId": task.task_id, "query": "Привет", "offset": 0, "limit": 2})
        self.assertEqual((first["returned"], first["nextOffset"]), (2, 2))
        self.assertNotIn(str(Path(self.folder.name)), json.dumps(self.service.snapshot(task)))

    async def test_ceiling_exhaustion_and_partial_failure_preserve_results(self):
        page = {"sessionId": "exp_" + "a" * 32, "records": [record(1), record(2)], "hasMore": True}
        task = await self.start_export(iter([page]), 1)
        await task.runner
        self.assertEqual((task.status, task.collected, task.truncated), ("completed", 1, True))
        task = await self.start_export(iter([page, LocalError("YOUTUBE_BRIDGE_OFFLINE")]))
        await task.runner
        self.assertEqual((task.status, task.collected), ("failed", 2))
        self.assertEqual((await self.service.call("youtube_dataset_read", {"taskId": task.task_id}))["returned"], 2)

    async def test_cancel_retains_dataset_and_missing_task_has_stable_code(self):
        page = {"sessionId": "exp_" + "a" * 32, "records": [record(1)], "hasMore": True}
        task = await self.start_export(iter([page]))
        while not task.collected:
            await asyncio.sleep(0)
        value = await self.service.call("youtube_research_task_cancel", {"taskId": task.task_id})
        self.assertEqual((value["status"], value["collected"]), ("cancelled", 1))
        self.assertTrue((Path(self.folder.name) / task.workspace_path).is_file())
        reply = await self.rpc("youtube_research_task_status", {"taskId": "tsk_abcdefghij"})
        self.assertEqual(reply["result"]["structuredContent"]["error"]["code"], "YOUTUBE_RESEARCH_TASK_NOT_FOUND")

    async def test_login_error_creates_no_export_task_or_file(self):
        self.service.writer = object()
        async def browser(name, args):
            raise LocalError("YOUTUBE_LOGIN_REQUIRED")
        self.service.browser = browser
        with self.assertRaisesRegex(LocalError, "Sign in"):
            await self.service.call("youtube_comments_export", {"videoId": "abcdefghijk"})
        self.assertFalse(self.service.tasks)
        self.assertFalse(list(Path(self.folder.name).iterdir()))
        self.service.writer = None
