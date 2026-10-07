import asyncio
import tempfile
import json
import unittest
from pathlib import Path
from unittest.mock import patch
from agent import researchtube_agent as agent
from agent.browser_resources import save_browser_resource, resource_format


class BrowserResourceTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.workspace = Path(self.folder.name) / 'workspace'
        self.override = patch.object(agent, 'WORKSPACE_PATH', self.workspace)
        self.override.start()
        self.png = b'\x89PNG\r\n\x1a\n' + bytes(range(256))

    def tearDown(self):
        self.override.stop()
        self.folder.cleanup()

    def save(self, data=None, task_id='tsk_abcdefghij', mime='image/png', maximum=1048576):
        return save_browser_resource(self.png if data is None else data, task_id, mime, maximum, agent.WorkspacePathResolver(), agent.AgentApiError)

    def test_original_bytes_saved_private_path_not_exposed(self):
        result = self.save()
        self.assertEqual(set(result), {'workspacePath', 'mimeType', 'sizeBytes'})
        self.assertEqual(result['mimeType'], 'image/png')
        self.assertTrue(result['workspacePath'].startswith('study-this-site/'))
        self.assertEqual((self.workspace / result['workspacePath']).read_bytes(), self.png)
        self.assertNotIn(str(self.workspace), str(result))

    def test_multiple_receipts_keep_distinct_files_and_original_bytes(self):
        receipts = [self.save(data=self.png + suffix, task_id=task_id) for task_id, suffix in [("tsk_abcdefghij", b"first"), ("tsk_klmnopqrst", b"second")]]
        self.assertEqual(len({item["workspacePath"] for item in receipts}), 2)
        for item, suffix in zip(receipts, [b"first", b"second"]):
            self.assertTrue(item["workspacePath"].startswith("study-this-site/"))
            self.assertEqual((self.workspace / item["workspacePath"]).read_bytes(), self.png + suffix)

    def test_does_not_overwrite(self):
        first = self.save()
        with self.assertRaises(agent.AgentApiError) as caught:
            self.save(data=self.png + b'new')
        self.assertEqual(caught.exception.code, 'BROWSER_DESTINATION_EXISTS')
        self.assertEqual((self.workspace / first['workspacePath']).read_bytes(), self.png)

    def test_oversize_empty_malformed_and_path_escape_rejected(self):
        for kwargs, expected in [({'maximum': 2}, 'BROWSER_RESOURCE_TOO_LARGE'), ({'data': b''}, 'BROWSER_RESOURCE_TOO_LARGE'), ({'task_id': '../../bad'}, 'BROWSER_INVALID'), ({'data': b'<html>not a PNG</html>'}, 'BROWSER_RESOURCE_INVALID')]:
            with self.subTest(kwargs=kwargs), self.assertRaises(agent.AgentApiError) as caught:
                self.save(**kwargs)
            self.assertEqual(caught.exception.code, expected)

    def test_symlink_directory_rejected(self):
        outside = Path(self.folder.name) / 'outside'
        outside.mkdir()
        self.workspace.mkdir()
        try:
            (self.workspace / 'study-this-site').symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest('symlinks unavailable')
        with self.assertRaises(agent.AgentApiError) as caught:
            self.save()
        self.assertEqual(caught.exception.code, 'BROWSER_INVALID')
        self.assertEqual(list(outside.iterdir()), [])

    def test_formats_and_mime_sniffing(self):
        for data, declared, expected in [(b'\xff\xd8\xffx', 'application/octet-stream', 'image/jpeg'), (b'GIF89ax', 'image/gif', 'image/gif'), (b'RIFF0000WEBPx', 'image/webp', 'image/webp'), (b'<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'image/svg+xml', 'image/svg+xml'), (b'%PDF-1.7x', 'application/pdf', 'application/pdf'), (b'ID3x', 'audio/mpeg', 'audio/mpeg'), (b'0000ftypisomx', 'video/mp4', 'video/mp4')]:
            self.assertEqual(resource_format(data, declared)[0], expected)

    def test_real_loopback_route_and_collision(self):
        async def run():
            server = await asyncio.start_server(agent.handle_client, '127.0.0.1', 0)
            port = server.sockets[0].getsockname()[1]
            try:
                results = []
                for _ in range(2):
                    reader, writer = await asyncio.open_connection('127.0.0.1', port)
                    writer.write(f'POST /internal/browser-resource?taskId=tsk_httpabcdef HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: image/png\r\nContent-Length: {len(self.png)}\r\n\r\n'.encode() + self.png)
                    await writer.drain()
                    header = await reader.readuntil(b'\r\n\r\n')
                    length = int(next(line.split(b':',1)[1] for line in header.split(b'\r\n') if line.lower().startswith(b'content-length:')))
                    body = json.loads(await reader.readexactly(length))
                    results.append((header, body))
                    writer.close(); await writer.wait_closed()
                return results
            finally:
                server.close(); await server.wait_closed()
        with patch.object(agent, 'configured_tool_limits', return_value={'mediaToChatMaxFileSizeMiB': 1, 'completedTaskHistoryLimit': 2000}):
            results = asyncio.run(run())
        self.assertIn(b'201 Created', results[0][0])
        self.assertEqual(results[0][1]['mimeType'], 'image/png')
        self.assertEqual(results[1][1]['error']['code'], 'BROWSER_DESTINATION_EXISTS')

    def test_request_parser_has_narrow_binary_limit(self):
        async def read(path, size, limit=1):
            reader = asyncio.StreamReader()
            reader.feed_data(f'POST {path} HTTP/1.1\r\nContent-Length: {size}\r\n\r\n'.encode() + b'x' * size)
            reader.feed_eof()
            with patch.object(agent, 'configured_tool_limits', return_value={'mediaToChatMaxFileSizeMiB': limit}):
                return await agent.read_request(reader)
        self.assertEqual(len(asyncio.run(read('/internal/browser-resource?taskId=tsk_abcdefghij', 70000))[3]), 70000)
        with self.assertRaises(agent.AgentApiError) as caught:
            asyncio.run(read('/other', 70000))
        self.assertEqual(caught.exception.code, 'REQUEST_TOO_LARGE')
        with self.assertRaises(agent.AgentApiError):
            asyncio.run(read('/internal/browser-resource', 1048577))


if __name__ == '__main__':
    unittest.main()
