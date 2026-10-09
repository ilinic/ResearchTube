"""Read the WinRT stream through its writable-buffer API without Windows."""
import unittest

from agent.windows_speech import stream_bytes


class SpeechStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_reads_into_buffer_and_closes_reader(self):
        payload = bytes(range(64))

        class Stream:
            size = len(payload)

            def get_input_stream_at(self, position):
                self.position = position
                return self

        class Reader:
            def __init__(self, stream):
                self.stream = stream
                self.closed = False

            async def load_async(self, size):
                return size

            def read_bytes(self, buffer):
                # WinRT returns None and fills a writable buffer, not a count.
                if not isinstance(buffer, bytearray):
                    raise TypeError('Expected a writable byte buffer')
                buffer[:] = payload

            def close(self):
                self.closed = True

        stream = Stream()
        reader = Reader(stream)
        self.assertEqual(await stream_bytes(stream, lambda _: reader), payload)
        self.assertEqual(stream.position, 0)
        self.assertTrue(reader.closed)

    async def test_truncated_load_fails_and_closes_reader(self):
        class Stream:
            size = 64

            def get_input_stream_at(self, position):
                return self

        class Reader:
            closed = False

            async def load_async(self, size):
                return size - 1

            def close(self):
                self.closed = True

        reader = Reader()
        with self.assertRaisesRegex(RuntimeError, 'truncated speech stream'):
            await stream_bytes(Stream(), lambda _: reader)
        self.assertTrue(reader.closed)
