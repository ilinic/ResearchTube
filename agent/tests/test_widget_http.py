"""Exercise the real loopback media route, not only its byte-range helper."""
import asyncio
import struct
import tempfile
import shutil
import subprocess
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

from agent import researchtube_agent as agent


class WidgetHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.image = self.root / 'crops' / 'test-crop.png'
        self.image.parent.mkdir()
        def chunk(kind, value):
            return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind + value))
        self.data = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00')) + chunk(b'IEND', b''))
        self.image.write_bytes(self.data)
        self.before = self.image.stat()
        self.workspace_patch = patch.object(agent, 'WORKSPACE_PATH', self.root)
        self.workspace_patch.start()
        self.server = await asyncio.start_server(agent.handle_client, '127.0.0.1', 0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        self.workspace_patch.stop()
        self.temp.cleanup()

    async def request(self, range_value=None, header_name='Range', path='/crops/test-crop.png'):
        reader, writer = await asyncio.open_connection('127.0.0.1', self.port)
        range_line = f'{header_name}: {range_value}\r\n' if range_value is not None else ''
        writer.write(f'GET {path}?viewer=123 HTTP/1.1\r\nHost: localhost\r\n{range_line}\r\n'.encode('ascii'))
        await writer.drain()
        raw = await asyncio.wait_for(reader.read(), 2)
        writer.close()
        await writer.wait_closed()
        head, body = raw.split(b'\r\n\r\n', 1)
        lines = head.decode('ascii').split('\r\n')
        headers = {key.lower(): value.strip() for key, value in (line.split(':', 1) for line in lines[1:])}
        return lines[0], headers, body

    async def test_plain_get_returns_complete_image_without_range_header(self):
        status, headers, body = await self.request()
        self.assertEqual(status, 'HTTP/1.1 200 OK')
        self.assertEqual(headers['content-type'], 'image/png')
        self.assertEqual(headers['content-length'], str(len(self.data)))
        self.assertEqual(headers['accept-ranges'], 'bytes')
        self.assertNotIn('content-range', headers)
        self.assertEqual(body, self.data)
        self.assertEqual(self.image.stat().st_mtime_ns, self.before.st_mtime_ns)

    async def test_real_range_headers_return_exact_bytes_and_mixed_case_names(self):
        cases = [('bytes=1-5', 'Range', 1, 5), ('bytes=5-', 'rAnGe', 5, len(self.data) - 1),
                 ('bytes=-8', 'range', len(self.data) - 8, len(self.data) - 1)]
        for value, name, start, end in cases:
            with self.subTest(range=value):
                status, headers, body = await self.request(value, name)
                self.assertEqual(status, 'HTTP/1.1 206 Partial Content')
                self.assertEqual(headers['content-range'], f'bytes {start}-{end}/{len(self.data)}')
                self.assertEqual(int(headers['content-length']), len(body))
                self.assertEqual(body, self.data[start:end + 1])
        self.assertEqual(self.image.read_bytes(), self.data)
        self.assertEqual(self.image.stat().st_mtime_ns, self.before.st_mtime_ns)

    async def test_invalid_ranges_return_http_416_without_hanging_or_exception(self):
        for value in ['bytes=999-1000', 'bytes=5-1', 'bytes=0-1,3-4', 'bytes=-0']:
            with self.subTest(range=value):
                status, headers, body = await self.request(value)
                self.assertEqual(status, 'HTTP/1.1 416 Range Not Satisfiable')
                self.assertEqual(headers['content-range'], f'bytes */{len(self.data)}')
                self.assertEqual(headers['content-length'], '0')
                self.assertEqual(body, b'')

    @unittest.skipUnless(shutil.which('ffmpeg'), 'Real media integration requires FFmpeg')
    async def test_real_audio_and_video_support_head_middle_tail_and_invalid_ranges(self):
        audio, video = self.root / 'test.wav', self.root / 'test.mp4'
        def generate():
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
                            'sine=frequency=440:duration=1', str(audio)], check=True, timeout=15, capture_output=True)
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
                            'testsrc2=size=64x64:rate=10:duration=1', '-f', 'lavfi', '-i',
                            'sine=frequency=440:duration=1', '-c:v', 'libx264', '-c:a', 'aac',
                            '-movflags', '+faststart', '-shortest', str(video)], check=True, timeout=15, capture_output=True)
        await asyncio.to_thread(generate)
        for file, mime in [(audio, 'audio/wav'), (video, 'video/mp4')]:
            data, before = file.read_bytes(), file.stat()
            for start, end in [(0, 31), (len(data) // 2, len(data) // 2 + 31), (len(data) - 32, len(data) - 1)]:
                status, headers, body = await self.request(f'bytes={start}-{end}', path=f'/{file.name}')
                self.assertEqual(status, 'HTTP/1.1 206 Partial Content')
                self.assertEqual(headers['content-type'], mime)
                self.assertEqual(headers['content-range'], f'bytes {start}-{end}/{len(data)}')
                self.assertEqual(headers['accept-ranges'], 'bytes')
                self.assertEqual(body, data[start:end + 1])
            status, headers, body = await self.request(f'bytes={len(data)}-', path=f'/{file.name}')
            self.assertEqual(status, 'HTTP/1.1 416 Range Not Satisfiable')
            self.assertEqual(headers['content-range'], f'bytes */{len(data)}')
            self.assertEqual(body, b'')
            self.assertEqual(file.stat().st_mtime_ns, before.st_mtime_ns)
            self.assertEqual(file.read_bytes(), data)
