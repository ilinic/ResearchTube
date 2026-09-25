"""Behavioral checks for private metadata, selection, transfers and publication."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from agent import researchtube_agent as agent
from agent import storyboards as sb

VID = 'aqz-KE-bpKQ'
SPEC = ('https://i.ytimg.com/sb/' + VID + '/storyboard3_L$L/$N.jpg?sqp=private'
        '|48#27#100#10#10#0#default#secret0'
        '|160#90#53#5#5#5000#M$M#secret1')
CONTEXT = dict(videoId=VID, title='Видео / тест: ☀', durationSeconds=263.2, isLive=False, spec=SPEC)
JPEG = b'\xff\xd8\xff\xe0' + b'image' * 100 + b'\xff\xd9'


class MetadataTests(unittest.TestCase):
    def test_levels_geometry_partial_sheet_and_private_signature(self):
        levels = sb.parse_spec(SPEC, 263.2)
        self.assertEqual([v['variantId'] for v in levels], ['storyboard_1', 'storyboard_2'])
        self.assertEqual(levels[1]['sheetCount'], 3)
        self.assertEqual(levels[1]['framesPerSheet'], 25)
        self.assertEqual(levels[1]['frameIntervalSeconds'], 5)
        self.assertIn('/storyboard3_L1/M2.jpg?', levels[1]['urls'][2])
        self.assertIn('sigh=secret1', levels[1]['urls'][2])
        self.assertAlmostEqual(levels[0]['frameIntervalSeconds'], 2.632)
        self.assertTrue(levels[0]['frameIntervalEstimated'])
        self.assertFalse(levels[1]['frameIntervalEstimated'])
        self.assertIn('/default.jpg?', levels[0]['urls'][0])

    def test_fallback_does_not_confuse_sb_order_with_level(self):
        document = {'formats': [{'format_id': 'sb0', 'format_note': 'storyboard', 'width': 160, 'height': 90,
            'columns': 5, 'rows': 5, 'fps': 53 / 263.2,
            'fragments': [{'url': f'https://i.ytimg.com/sb/{VID}/storyboard3_L1/M{i}.jpg?sigh=secret'} for i in range(3)]}]}
        level = sb.parse_formats(document, 263.2)[0]
        self.assertEqual(level['variantId'], 'storyboard_2')
        self.assertEqual(level['count'], 53)
        self.assertTrue(level['frameIntervalEstimated'])
        self.assertEqual(level['sheetCount'], 3)

    def test_all_index_dedup_and_inclusive_range_boundaries(self):
        v = sb.parse_spec(SPEC, 263.2)[1]
        self.assertEqual(sb.select_sheets({'mode': 'all'}, v, 263.2), [0, 1, 2])
        self.assertEqual(sb.select_sheets({'mode': 'sheets', 'sheetIndexes': [2, 0, 2]}, v, 263.2), [0, 2])
        cases = [(0, 0, [0]), (124, 125, [0, 1]), (125, 125, [1]), (250, 263.2, [2]), (263.2, 263.2, [2])]
        for start, end, expected in cases:
            self.assertEqual(sb.select_sheets({'mode': 'range', 'startSeconds': start, 'endSeconds': end}, v, 263.2), expected)

    def test_invalid_inputs_are_rejected_not_clamped(self):
        v = sb.parse_spec(SPEC, 263.2)[1]
        for selection in [{'mode': 'all', 'unexpected': True}, {'mode': 'sheets', 'sheetIndexes': []},
                          {'mode': 'sheets', 'sheetIndexes': [True]}, {'mode': 'sheets', 'sheetIndexes': [-1]},
                          {'mode': 'sheets', 'sheetIndexes': [3]}, {'mode': 'range', 'startSeconds': 0, 'endSeconds': 264},
                          {'mode': 'range', 'startSeconds': float('nan'), 'endSeconds': 20},
                          {'mode': 'range', 'startSeconds': 20, 'endSeconds': 10}]:
            with self.assertRaises(sb.StoryboardError): sb.select_sheets(selection, v, 263.2)
        self.assertEqual(sb.parse_spec(SPEC.replace('160#90#53', '160#90#-53'), 263.2)[0]['variantId'], 'storyboard_1')

    def test_flat_unicode_windows_filename(self):
        path = sb.filename('Привет / мир: ☀?', VID, sb.parse_spec(SPEC, 263.2)[1], 4)
        self.assertEqual(path, 'storyboards/Привет  мир ☀ [yt_aqz-KE-bpKQ] [sz_160x90] [tstp_5] [mesh_5x5] [sheet_0004].jpeg')
        name = sb.filename('😀' * 300, VID, sb.parse_spec(SPEC, 263.2)[1], 0).split('/')[1]
        self.assertLessEqual(len(name.encode('utf-16-le')) // 2, 240)
        agent.WorkspacePathResolver.logical_parts('storyboards/' + name, field_name='test', error_code='TEST')

    def test_non_youtube_urls_and_redirect_targets_are_rejected(self):
        for url in ['http://i.ytimg.com/sb/id/a.jpg', 'https://i.ytimg.com.evil.test/sb/id/a.jpg',
                    'https://127.0.0.1/sb/a.jpg', 'https://user@i.ytimg.com/sb/a.jpg',
                    'https://i.ytimg.com:444/sb/a.jpg', 'https://i.ytimg.com/other/a.jpg',
                    'https://i.ytimg.com/sb/a.jpg\r\nx: y']:
            with self.assertRaises(ValueError): sb.sheet_url(url)


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.workspace = self.root / 'workspace'
        self.patch = patch.object(agent, 'WORKSPACE_PATH', self.workspace)
        self.patch.start()
        self.service = sb.StoryboardService(agent)
        self.fallback = AsyncMock(return_value=None)
        self.service.metadata = self.fallback

    async def asyncTearDown(self):
        await self.service.shutdown()
        self.patch.stop()
        self.temp.cleanup()

    async def start(self, selection=None):
        return await self.service.dispatch('download', dict(videoId=VID, variantId='storyboard_2',
            selection=selection or {'mode': 'all'}, context=CONTEXT))

    async def test_info_creates_no_files_and_leaks_no_internals(self):
        result = await self.service.dispatch('info', {'videoId': VID, 'context': CONTEXT})
        self.assertTrue(result['available'])
        self.assertFalse(self.workspace.exists())
        self.fallback.assert_not_called()
        text = json.dumps(result)
        for private in ['sigh', 'secret', 'https', 'spec', 'title', str(self.root)]: self.assertNotIn(private, text)

    async def test_unavailable_live_mismatch_and_bad_input_create_no_task(self):
        for payload, reason in [({'videoId': VID}, 'STORYBOARD_CONTEXT_UNAVAILABLE'),
            ({'videoId': VID, 'context': {**CONTEXT, 'spec': None}}, 'STORYBOARD_NOT_AVAILABLE'),
            ({'videoId': VID, 'context': {**CONTEXT, 'isLive': True}}, 'STORYBOARD_VIDEO_LIVE')]:
            info = await self.service.dispatch('info', payload)
            self.assertFalse(info['available']); self.assertEqual(info['reason'], reason)
        result = await self.service.dispatch('download', {'videoId': VID, 'variantId': 'storyboard_2', 'selection': {'mode': 'all'}})
        self.assertEqual(result['status'], 'rejected')
        result = await self.start({'mode': 'sheets', 'sheetIndexes': [20]})
        self.assertEqual(result['error']['code'], 'STORYBOARD_SHEET_NOT_FOUND')
        self.assertEqual(await self.service.dispatch('status', {'taskId': 'missing'}), sb.reject('TASK_NOT_FOUND', 'The storyboard task does not exist in this Agent session.'))
        self.assertFalse(self.service.tasks)
        self.assertFalse(self.workspace.exists())
        info = await self.service.dispatch('info', {'videoId': VID, 'context': {**CONTEXT, 'videoId': 'other-video'}})
        self.assertFalse(info['available'])

    async def test_complete_progress_reuse_and_restart_reuse(self):
        updates = []
        async def transfer(url, progress):
            task = list(self.service.tasks.values())[-1]
            for n in [10, 5, len(JPEG)]:
                progress(n, len(JPEG)); updates.append(task.progress)
            return JPEG
        with patch.object(sb, 'fetch_sheet', transfer):
            result = await self.start()
            self.assertRegex(result['taskId'], r'^tsk_[A-Za-z0-9_-]{10}$')
            task = self.service.get(result['taskId']); await task.runner
            self.assertEqual(task.status, 'completed'); self.assertEqual(task.downloaded, 3)
            self.assertEqual(updates, sorted(updates)); self.assertEqual(task.progress, 100)
            files = list((self.workspace / 'storyboards').iterdir())
            self.assertEqual(len(files), 3); self.assertTrue(all(p.is_file() for p in files))
            self.assertEqual([p.name for p in self.root.iterdir()], ['workspace'])
            with patch.object(sb, 'fetch_sheet', AsyncMock(side_effect=AssertionError('must reuse'))):
                result2 = await self.start(); task2 = self.service.get(result2['taskId']); await task2.runner
                self.assertEqual(task2.reused, 3); self.assertEqual(task2.downloaded, 0)
            self.service.published.clear()  # Simulates restart: verify bytes before reusing.
            result3 = await self.start(); task3 = self.service.get(result3['taskId']); await task3.runner
            self.assertEqual(task3.reused, 3)
            snapshot = json.dumps(task.snapshot())
            for private in ['sigh', 'secret', 'https', 'spec', str(self.root), 'sheet_0000']: self.assertNotIn(private, snapshot)

    async def test_range_downloads_only_intersecting_sheet(self):
        transfer = AsyncMock(return_value=JPEG)
        with patch.object(sb, 'fetch_sheet', transfer):
            result = await self.start({'mode': 'range', 'startSeconds': 130, 'endSeconds': 140})
            task = self.service.get(result['taskId']); await task.runner
        self.assertEqual(task.completed, 1)
        self.assertIn('/M1.jpg?', transfer.call_args.args[0])

    async def test_cancel_mid_transfer_preserves_completed_and_removes_partial(self):
        entered = asyncio.Event()
        async def transfer(url, progress):
            if '/M1.jpg?' in url:
                progress(20, 100); entered.set(); await asyncio.Event().wait()
            return JPEG
        with patch.object(sb, 'fetch_sheet', transfer):
            result = await self.start(); task = self.service.get(result['taskId'])
            await asyncio.wait_for(entered.wait(), 2)
            snapshot = await self.service.dispatch('cancel', {'taskId': task.task_id})
        self.assertEqual(snapshot['status'], 'cancelled'); self.assertEqual(task.completed, 1)
        self.assertEqual(len(list((self.workspace / 'storyboards').iterdir())), 1)
        self.assertEqual([p.name for p in self.root.iterdir()], ['workspace'])
        self.assertEqual((await self.service.cancel(task.task_id))['status'], 'cancelled')

    async def test_cancel_before_runner_starts(self):
        result = await self.start(); task = self.service.get(result['taskId'])
        self.assertEqual((await self.service.cancel(task.task_id))['status'], 'cancelled')
        self.assertFalse(self.workspace.exists())

    async def test_failure_preserves_completed_files_and_redacts_exception(self):
        transfer = AsyncMock(side_effect=[JPEG, RuntimeError('https://private?sigh=secret C:\\host')])
        with patch.object(sb, 'fetch_sheet', transfer):
            result = await self.start(); task = self.service.get(result['taskId']); await task.runner
        self.assertEqual(task.status, 'failed'); self.assertEqual(task.completed, 1)
        self.assertEqual(task.failed_index, 1)
        self.assertNotIn('secret', json.dumps(task.snapshot()))
        self.assertEqual(len(list((self.workspace / 'storyboards').iterdir())), 1)

    async def test_conflicting_file_is_not_overwritten(self):
        destination = self.service.path(sb.filename(CONTEXT['title'], VID, sb.parse_spec(SPEC, 263.2)[1], 0))
        destination.parent.mkdir(parents=True); destination.write_bytes(b'unrelated')
        with patch.object(sb, 'fetch_sheet', AsyncMock(return_value=JPEG)):
            result = await self.start(); task = self.service.get(result['taskId']); await task.runner
        self.assertEqual(task.status, 'failed'); self.assertEqual(destination.read_bytes(), b'unrelated')

    async def test_workspace_symlink_is_rejected(self):
        self.workspace.mkdir(); outside = self.root / 'outside'; outside.mkdir()
        (self.workspace / 'storyboards').symlink_to(outside, target_is_directory=True)
        with patch.object(sb, 'fetch_sheet', AsyncMock(return_value=JPEG)):
            result = await self.start(); task = self.service.get(result['taskId']); await task.runner
        self.assertEqual(task.status, 'failed'); self.assertEqual(list(outside.iterdir()), [])

    async def test_agent_http_routes_are_real_and_normal_results(self):
        with patch.object(agent, 'STORYBOARD_TASKS', self.service):
            server = await asyncio.start_server(agent.handle_client, '127.0.0.1', 0)
            try:
                reader, writer = await asyncio.open_connection('127.0.0.1', server.sockets[0].getsockname()[1])
                body = json.dumps({'videoId': VID, 'context': CONTEXT}).encode()
                writer.write(f'POST /youtube/storyboards/info HTTP/1.1\r\nContent-Length: {len(body)}\r\n\r\n'.encode() + body)
                await writer.drain(); response = await reader.read(); writer.close(); await writer.wait_closed()
                self.assertTrue(response.startswith(b'HTTP/1.1 200 OK'))
                self.assertTrue(json.loads(response.split(b'\r\n\r\n')[1])['available'])
                self.assertNotIn(b'secret', response)
            finally:
                server.close(); await server.wait_closed()


class Writer:
    def __init__(self): self.closed = False
    def write(self, data): pass
    async def drain(self): pass
    def close(self): self.closed = True
    async def wait_closed(self): pass


class TransferTests(unittest.IsolatedAsyncioTestCase):
    async def transfer(self, header, body, eof=True):
        reader = asyncio.StreamReader(); reader.feed_data(header + b'\r\n\r\n' + body)
        if eof: reader.feed_eof()
        writer = Writer(); updates = []
        with patch.object(sb.asyncio, 'open_connection', AsyncMock(return_value=(reader, writer))):
            result = await sb.fetch_sheet(f'https://i.ytimg.com/sb/{VID}/storyboard3_L1/M0.jpg', lambda *args: updates.append(args))
        self.assertTrue(writer.closed)
        return result, updates

    async def test_content_length_chunked_and_eof(self):
        for framing, body in [(f'Content-Length: {len(JPEG)}'.encode(), JPEG),
                              (b'Transfer-Encoding: chunked', f'{len(JPEG):x}\r\n'.encode() + JPEG + b'\r\n0\r\n\r\n'),
                              (b'Connection: close', JPEG)]:
            result, updates = await self.transfer(b'HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\n' + framing, body)
            self.assertEqual(result, JPEG); self.assertTrue(updates)

    async def test_truncated_and_html_responses_are_rejected(self):
        for header, data in [(b'HTTP/1.1 200 OK\r\nContent-Type: text/html', b'login'),
                             (b'HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 9999', JPEG),
                             (b'HTTP/1.1 403 Forbidden', b''),
                             (b'HTTP/1.1 200 OK\r\nContent-Type: image/jpeg', b'not jpeg')]:
            with self.assertRaises(ValueError): await self.transfer(header, data)

    async def test_cancel_closes_active_http_transport(self):
        reader = asyncio.StreamReader(); writer = Writer()
        reader.feed_data(b'HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 9999\r\n\r\n' + JPEG[:10])
        entered = asyncio.Event()
        with patch.object(sb.asyncio, 'open_connection', AsyncMock(return_value=(reader, writer))):
            task = asyncio.create_task(sb.fetch_sheet(f'https://i.ytimg.com/sb/{VID}/a.jpg', lambda *args: entered.set()))
            await asyncio.wait_for(entered.wait(), 2); task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(writer.closed)

    async def test_public_player_metadata_preserves_original_interval(self):
        player = {'videoDetails': {'videoId': VID, 'title': 'Video', 'lengthSeconds': '263'},
                  'storyboards': {'playerStoryboardSpecRenderer': {'spec': SPEC}}}
        body = ('<script>var ytInitialPlayerResponse = ' + json.dumps(player) + ';</script>').encode()
        with patch.object(sb, '_fetch_https_body', AsyncMock(return_value=body)):
            metadata = await sb.player_metadata(VID)
        self.assertEqual(metadata['storyboardSpec'], SPEC)
        self.assertEqual(sb.parse_spec(metadata['storyboardSpec'], metadata['duration'])[1]['frameIntervalSeconds'], 5)

    async def test_redirect_preserves_case_in_signature(self):
        first = asyncio.StreamReader()
        first.feed_data(b'HTTP/1.1 302 Found\r\nLocation: https://i.ytimg.com/sb/id/M1.jpg?sigh=MixedCASE\r\n\r\n')
        first.feed_eof()
        second = asyncio.StreamReader()
        second.feed_data(b'HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\n\r\n' + JPEG)
        second.feed_eof()
        writers = [Writer(), Writer()]
        captured = []
        writers[1].write = captured.append
        with patch.object(sb.asyncio, 'open_connection', AsyncMock(side_effect=[(first, writers[0]), (second, writers[1])])):
            await sb.fetch_sheet(f'https://i.ytimg.com/sb/{VID}/a.jpg', lambda *_: None)
        self.assertIn(b'M1.jpg?sigh=MixedCASE', captured[0])

    async def test_redirect_cannot_escape_allowed_hosts(self):
        with self.assertRaises(ValueError):
            await self.transfer(b'HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1/sb/private', b'')
