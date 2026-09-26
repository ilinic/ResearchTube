"""Private storyboard resolution, bounded HTTPS transfers, and asynchronous tasks.

The public boundary is an explicit allowlist. No source URLs or player data are
serialized, logged, persisted, or passed to media download tools.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import secrets
import ssl
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit, parse_qsl, urlencode

MAX_SHEET_BYTES = 20 * 1024 * 1024
MAX_FRAMES = 1_000_000
CACHE_SECONDS = 300
TIMESTAMP_POSITIONS = {'none', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'}
PUBLIC_FIELDS = ('variantId', 'cellWidth', 'cellHeight', 'columns', 'rows',
                 'framesPerSheet', 'frameIntervalSeconds', 'frameIntervalEstimated', 'sheetCount', 'format')


class StoryboardError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def reject(code, message):
    return {'status': 'rejected', 'error': {'code': code, 'message': message}}


def invalid(message):
    raise StoryboardError('STORYBOARD_INVALID', message)


def video_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[\w-]{11}', value, flags=re.ASCII):
        invalid('videoId must be an 11-character YouTube video ID.')
    return value


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def sheet_url(value):
    if not isinstance(value, str) or any(ord(c) < 33 for c in value):
        raise ValueError('Invalid sheet URL')
    url = urlsplit(value)
    if (url.scheme != 'https' or not re.fullmatch(r'(?:[a-z0-9-]+\.)*ytimg\.com', url.hostname or '')
            or url.username or url.password or url.port not in (None, 443)
            or not url.path.startswith('/sb/') or url.fragment):
        raise ValueError('Invalid sheet URL')
    return value


def variant(level, width, height, count, columns, rows, interval, urls, estimated=False):
    if any(type(v) is not int or v <= 0 for v in (width, height, count, columns, rows)):
        raise ValueError('Invalid geometry')
    if count > MAX_FRAMES or width * height * columns * rows > 100_000_000 or not number(interval) or interval <= 0:
        raise ValueError('Invalid geometry')
    if len(urls) != math.ceil(count / (columns * rows)):
        raise ValueError('Invalid sheet count')
    return dict(variantId=f'storyboard_{level + 1}', cellWidth=width, cellHeight=height,
                columns=columns, rows=rows, framesPerSheet=columns * rows,
                frameIntervalSeconds=interval, frameIntervalEstimated=estimated, sheetCount=len(urls), format='jpeg',
                count=count, urls=[sheet_url(url) for url in urls])


def parse_spec(spec, duration):
    if not isinstance(spec, str) or len(spec) > 50000:
        return []
    parts = spec.split('|')
    variants = []
    for level, item in enumerate(parts[1:]):
        try:
            width, height, count, columns, rows, milliseconds, name, signature = item.split('#')
            width, height, count, columns, rows, milliseconds = map(int, (width, height, count, columns, rows, milliseconds))
            if min(count, columns, rows) <= 0 or count > MAX_FRAMES or milliseconds < 0:
                continue
            # YouTube's overview level can have interval=0. Its cells sample
            # the whole duration, rather than all representing time zero.
            interval = milliseconds / 1000 if milliseconds else duration / count
            template = parts[0].replace('$L', str(level)).replace('$N', name)
            urls = []
            for index in range(math.ceil(count / (columns * rows))):
                url = urlsplit(template.replace('$M', str(index)))
                query = [(k, v) for k, v in parse_qsl(url.query, keep_blank_values=True) if k != 'sigh']
                query.append(('sigh', signature))
                urls.append(urlunsplit(url._replace(query=urlencode(query))))
            variants.append(variant(level, width, height, count, columns, rows, interval, urls, milliseconds == 0))
        except (ValueError, TypeError, OverflowError, ZeroDivisionError):
            continue
    return variants


def parse_formats(document, duration):
    variants = []
    for item in document.get('formats') or []:
        if not isinstance(item, dict) or item.get('format_note') != 'storyboard':
            continue
        try:
            fragments = item.get('fragments') or []
            base = item.get('fragment_base_url') or item.get('url') or ''
            urls = [urljoin(base, fragment.get('url') or fragment.get('path') or '') for fragment in fragments]
            if not urls:
                urls = [base]
            match = re.search(r'_L(\d+)(?:/|\.)', urls[0])
            if not match:
                continue  # Never confuse yt-dlp sbN ordering with YouTube's L index.
            fps = item.get('fps')
            if not number(fps) or fps <= 0:
                continue
            columns, rows = item['columns'], item['rows']
            capacity = columns * rows
            # yt-dlp supplies durations for the final, possibly partial sheet.
            count = min(len(urls) * capacity, max((len(urls) - 1) * capacity + 1, math.ceil(duration * fps - 1e-7)))
            variants.append(variant(int(match[1]), item['width'], item['height'], count,
                                    columns, rows, 1 / fps, urls, True))
        except (ValueError, KeyError, TypeError, OverflowError):
            continue
    return sorted(variants, key=lambda v: int(v['variantId'].split('_')[1]))


def select_sheets(selection, v, duration):
    if not isinstance(selection, dict):
        invalid('selection must specify all, range, or sheets.')
    mode = selection.get('mode')
    if mode == 'all' and set(selection) == {'mode'}:
        return list(range(v['sheetCount']))
    if mode == 'sheets' and set(selection) == {'mode', 'sheetIndexes'}:
        values = selection['sheetIndexes']
        if not isinstance(values, list) or not values or any(type(i) is not int for i in values):
            invalid('sheetIndexes must be a non-empty array of integers.')
        if any(i < 0 or i >= v['sheetCount'] for i in values):
            raise StoryboardError('STORYBOARD_SHEET_NOT_FOUND', 'Every sheet index must exist in the selected variant.')
        return sorted(set(values))
    if mode == 'range' and set(selection) == {'mode', 'startSeconds', 'endSeconds'}:
        start, end = selection['startSeconds'], selection['endSeconds']
        if not number(start) or not number(end) or not 0 <= start <= end <= duration:
            invalid('Range must satisfy 0 <= startSeconds <= endSeconds <= video duration.')
        span = v['framesPerSheet'] * v['frameIntervalSeconds']
        # Sheet coverage is [start, next start); only the final sheet includes
        # duration. A requested range is inclusive at both ends.
        return [i for i in range(v['sheetCount']) if i * span <= end and
                (start < min(duration, (i + 1) * span) or i == v['sheetCount'] - 1 and start == duration)]
    invalid('selection must contain exactly the fields documented for its mode.')


def filename(title, vid, v, index):
    step = format(v['frameIntervalSeconds'], '.9f').rstrip('0').rstrip('.')
    suffix = (f" [yt_{vid}] [sz_{v['cellWidth']}x{v['cellHeight']}]"
              f" [tstp_{step}] [mesh_{v['columns']}x{v['rows']}] [sheet_{index:04d}].jpeg")
    title = re.sub(r'[\x00-\x1f<>:"/\\|?*]', '', title).strip(' .') or 'YouTube'
    if title.split('.', 1)[0].upper() in {'CON', 'PRN', 'AUX', 'NUL', *('COM' + str(i) for i in range(1, 10)), *('LPT' + str(i) for i in range(1, 10))}:
        title = '_' + title
    # Windows counts UTF-16 code units, not Python code points.
    title = title.encode('utf-16-le')[:(240 - len(suffix)) * 2].decode('utf-16-le', errors='ignore').rstrip(' .')
    return 'storyboards/' + title + suffix


def timestamp_label(seconds):
    """Format one storyboard cell time exactly as Visual Map does."""
    total = max(0, int(round(seconds)))
    hours, remainder = divmod(total, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f'{hours}:{minutes:02d}:{seconds:02d}' if hours else f'{minutes}:{seconds:02d}'


def sheet_frame_timestamps(v, sheet_index, duration):
    """Return the absolute time of every real cell in one sheet."""
    first = sheet_index * v['framesPerSheet']
    last = min(first + v['framesPerSheet'], v['count'])
    return [round(min(duration, frame_index * v['frameIntervalSeconds']), 9)
            for frame_index in range(first, last)]


def sheet_timestamp_filter(v, sheet_index, duration, position, font_file, escape):
    """Place one absolute timestamp inside every real tile of one ready sheet."""
    if position not in TIMESTAMP_POSITIONS - {'none'}:
        raise ValueError('Timestamp position is unavailable')
    font_size = max(1, min(24, math.floor(v['cellHeight'] * 0.15)))
    padding = max(1, round(font_size * 0.30))
    escaped_font = escape(font_file.as_posix())
    filters = []
    for cell_index, timestamp in enumerate(sheet_frame_timestamps(v, sheet_index, duration)):
        frame_index = sheet_index * v['framesPerSheet'] + cell_index
        row, column = divmod(cell_index, v['columns'])
        x_origin, y_origin = column * v['cellWidth'], row * v['cellHeight']
        x = (x_origin + padding if position.endswith('Left')
             else x_origin + v['cellWidth'] - padding)
        y = (y_origin + padding if position.startswith('top')
             else y_origin + v['cellHeight'] - padding)
        label = timestamp_label(timestamp)
        filters.append(
            f"drawtext=fontfile='{escaped_font}':text='{escape(label)}':x={x if position.endswith('Left') else str(x) + '-text_w'}:y={y if position.startswith('top') else str(y) + '-text_h'}:"
            f"fontsize={font_size}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw={padding}"
        )
    if not filters:
        raise ValueError('Storyboard sheet contains no frames')
    return ','.join(filters)


async def fetch_sheet(url, progress):
    return await asyncio.wait_for(_fetch_https_body(url, progress), 45)


async def _fetch_https_body(url, progress, metadata=False):
    """Cancellable HTTPS, with bounded body/header sizes and checked redirects."""
    writer = None
    try:
        for _ in range(4):
            if metadata:
                parsed = urlsplit(url)
                if (parsed.scheme != 'https' or parsed.hostname != 'www.youtube.com' or parsed.username
                        or parsed.password or parsed.port not in (None, 443) or parsed.path != '/watch'):
                    raise ValueError('Invalid metadata URL')
            else:
                parsed = urlsplit(sheet_url(url))
            reader, writer = await asyncio.open_connection(parsed.hostname, 443, ssl=ssl.create_default_context())
            target = parsed.path + ('?' + parsed.query if parsed.query else '')
            accept = 'text/html' if metadata else 'image/jpeg'
            writer.write(f'GET {target} HTTP/1.1\r\nHost: {parsed.hostname}\r\nUser-Agent: Mozilla/5.0\r\nAccept: {accept}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n'.encode('ascii'))
            await writer.drain()
            header = await reader.readuntil(b'\r\n\r\n')
            lines = header.decode('iso-8859-1').split('\r\n')
            status = int(lines[0].split()[1])
            headers = dict(line.split(':', 1) for line in lines[1:] if ':' in line)
            headers = {k.lower(): v.strip() for k, v in headers.items()}
            if status in (301, 302, 303, 307, 308):
                url = urljoin(url, headers.get('location', ''))
                writer.close()
                await writer.wait_closed()
                writer = None
                continue
            accepted_types = ('text/html',) if metadata else ('image/jpeg', 'image/jpg')
            if status != 200 or headers.get('content-type', '').split(';')[0].lower() not in accepted_types:
                raise ValueError('Sheet unavailable')
            total = int(headers['content-length']) if 'content-length' in headers else None
            if total is not None and not 0 < total <= MAX_SHEET_BYTES:
                raise ValueError('Invalid sheet length')
            chunked = headers.get('transfer-encoding', '').lower() == 'chunked'
            if headers.get('transfer-encoding') and not chunked:
                raise ValueError('Unsupported transfer encoding')
            data = bytearray()
            while True:
                if chunked:
                    chunk_size = int((await reader.readline()).split(b';', 1)[0], 16)
                    if chunk_size == 0:
                        break
                    if chunk_size + len(data) > MAX_SHEET_BYTES:
                        raise ValueError('Sheet too large')
                    # Do not wait for a whole large HTTP chunk before reporting progress.
                    while chunk_size:
                        chunk = await reader.readexactly(min(65536, chunk_size))
                        data.extend(chunk)
                        chunk_size -= len(chunk)
                        progress(len(data), total)
                    if await reader.readexactly(2) != b'\r\n':
                        raise ValueError('Invalid chunk')
                else:
                    remaining = total - len(data) if total is not None else 65536
                    if remaining == 0:
                        break
                    chunk = await reader.read(min(65536, remaining))
                    if not chunk:
                        break
                    data.extend(chunk)
                    progress(len(data), total)
                if len(data) > MAX_SHEET_BYTES:
                    raise ValueError('Sheet too large')
            if total is not None and len(data) != total:
                raise ValueError('Truncated sheet')
            if not metadata and (not data.startswith(b'\xff\xd8\xff') or not data.endswith(b'\xff\xd9')):
                raise ValueError('Invalid JPEG')
            return bytes(data)
        raise ValueError('Too many redirects')
    finally:
        if writer is not None:
            writer.close()
            # Closing the transport stops an in-progress transfer on cancellation.
            try:
                await asyncio.wait_for(writer.wait_closed(), 1)
            except (Exception, asyncio.CancelledError):
                pass


async def player_metadata(vid):
    """Read the original interval from a public watch-page player response.

    yt-dlp's mhtml fps is frame_count/duration, not YouTube's original interval;
    retain that only as an explicitly estimated last fallback.
    """
    body = await asyncio.wait_for(_fetch_https_body(
        f'https://www.youtube.com/watch?v={vid}', lambda *_: None, metadata=True), 8)
    text = body.decode('utf-8')
    for match in re.finditer(r'ytInitialPlayerResponse\s*=\s*', text):
        try:
            player, _ = json.JSONDecoder().raw_decode(text, match.end())
            details = player.get('videoDetails') or {}
            if details.get('videoId') != vid:
                continue
            spec = (player.get('storyboards') or {}).get('playerStoryboardSpecRenderer', {}).get('spec')
            live = bool(details.get('isLive') or details.get('isUpcoming') or details.get('isPostLiveDvr'))
            if spec or live:
                return dict(id=vid, title=details.get('title'), duration=float(details.get('lengthSeconds') or 0),
                            is_live=live, storyboardSpec=spec)
        except (ValueError, TypeError, AttributeError):
            continue
    return None


@dataclass
class Task:
    task_id: str
    source: dict
    variant: dict
    indexes: list
    timestamp_position: str
    status: str = 'working'
    phase: str = 'resolving'
    progress: float = 0
    completed: int = 0
    downloaded: int = 0
    reused: int = 0
    failed_index: int | None = None
    error: dict | None = None
    runner: asyncio.Task | None = None

    def snapshot(self):
        result = dict(taskId=self.task_id, status=self.status, phase=self.phase,
                      progressPercent=round(self.progress, 3), totalSheets=len(self.indexes),
                      completedSheets=self.completed, downloadedSheets=self.downloaded,
                      reusedSheets=self.reused, workspaceDirectory='storyboards', pollIntervalMs=1000,
                      frameTimestampPosition=self.timestamp_position,
                      sheetTimestamps=[dict(sheetIndex=index,
                                            frameTimestampsSeconds=sheet_frame_timestamps(
                                                self.variant, index, self.source['durationSeconds']))
                                       for index in self.indexes])
        if self.error:
            result.update(error=self.error, failedSheetIndex=self.failed_index)
        return result


class StoryboardService:
    def __init__(self, host):
        self.host = host
        self.cache = {}
        self.tasks = {}
        self.published = {}
        self.slots = asyncio.Semaphore(3)

    async def metadata(self, vid):
        try:
            document = await player_metadata(vid)
            if document is not None:
                return document
        except Exception:
            pass  # Metadata-only fallback, with no raw network errors in logs.
        component = self.host.find_component('ytDlp', self.host.COMPONENTS['ytDlp'][0])
        if component.error or not component.executable:
            return None
        process = None
        try:
            command = [component.executable, *self.host.yt_dlp_youtube_arguments(self.host.resolve_deno_runtime()),
                       '--ignore-config', '--no-playlist', '--skip-download', '--no-warnings', '--ignore-no-formats-error',
                       '--dump-single-json', f'https://www.youtube.com/watch?v={vid}']
            process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            stdout, _ = await asyncio.wait_for(process.communicate(), 30)
            if process.returncode:
                return None
            document = json.loads(stdout)
            return document if isinstance(document, dict) and document.get('id') == vid else None
        except (Exception, asyncio.CancelledError) as error:
            if isinstance(error, asyncio.CancelledError):
                raise
            return None
        finally:
            if process is not None and process.returncode is None:
                process.kill()
                await process.communicate()

    async def resolve(self, vid, context=None):
        self.cache.pop(vid, None)
        source = None
        if isinstance(context, dict) and context.get('videoId') == vid:
            if context.get('isLive') is True:
                return {'videoId': vid, 'available': False, 'reason': 'STORYBOARD_VIDEO_LIVE'}
            duration = context.get('durationSeconds')
            if number(duration) and duration > 0:
                variants = parse_spec(context.get('spec'), duration)
                if variants:
                    source = dict(videoId=vid, title=str(context.get('title') or vid), durationSeconds=duration, variants=variants)
        if source is None:
            document = await self.metadata(vid)
            if document is None:
                reason = 'STORYBOARD_NOT_AVAILABLE' if context and context.get('videoId') == vid else 'STORYBOARD_CONTEXT_UNAVAILABLE'
                return {'videoId': vid, 'available': False, 'reason': reason}
            if document.get('is_live') or document.get('live_status') in ('is_live', 'is_upcoming', 'post_live'):
                return {'videoId': vid, 'available': False, 'reason': 'STORYBOARD_VIDEO_LIVE'}
            duration = document.get('duration')
            variants = []
            if number(duration) and duration > 0:
                variants = parse_spec(document.get('storyboardSpec'), duration) or parse_formats(document, duration)
            if not variants:
                return {'videoId': vid, 'available': False, 'reason': 'STORYBOARD_NOT_AVAILABLE'}
            source = dict(videoId=vid, title=str(document.get('title') or vid), durationSeconds=duration, variants=variants)
        source['expires'] = time.monotonic() + CACHE_SECONDS
        self.cache[vid] = source
        # Metadata cache is private and bounded; tasks own their own source reference.
        if len(self.cache) > 100:
            self.cache.pop(next(iter(self.cache)))
        return source

    async def info(self, payload):
        if not isinstance(payload, dict) or set(payload) - {'videoId', 'context'}:
            invalid('Specify videoId only.')
        vid = video_id(payload.get('videoId'))
        source = await self.resolve(vid, payload.get('context'))
        if source.get('available') is False:
            self.cache.pop(vid, None)
            return source
        return dict(videoId=vid, available=True, durationSeconds=source['durationSeconds'],
                    variants=[{key: v[key] for key in PUBLIC_FIELDS} for v in source['variants']])

    async def create(self, payload):
        if not isinstance(payload, dict) or set(payload) - {'videoId', 'variantId', 'selection', 'frameTimestampPosition', 'context'}:
            invalid('Specify videoId, variantId and selection.')
        vid = video_id(payload.get('videoId'))
        if not isinstance(payload.get('variantId'), str) or not re.fullmatch(r'storyboard_[1-9]\d*', payload['variantId']):
            invalid('variantId must be returned by youtube_storyboard_get_info.')
        source = self.cache.get(vid)
        if payload.get('context') is not None or source is None or source['expires'] <= time.monotonic():
            source = await self.resolve(vid, payload.get('context'))
        if source.get('available') is False:
            return reject(source['reason'], 'No storyboard is available for this video in the current context.')
        v = next((v for v in source['variants'] if v['variantId'] == payload['variantId']), None)
        if v is None:
            raise StoryboardError('STORYBOARD_VARIANT_NOT_FOUND', 'Discover the available variants with youtube_storyboard_get_info.')
        indexes = select_sheets(payload.get('selection'), v, source['durationSeconds'])
        if not indexes:
            invalid('The requested range contains no storyboard sheets.')
        timestamp_position = payload.get('frameTimestampPosition', 'bottomRight')
        if timestamp_position not in TIMESTAMP_POSITIONS:
            invalid('frameTimestampPosition is invalid.')
        task_id = 'tsk_' + secrets.token_urlsafe(8)[:10]
        while task_id in self.tasks:
            task_id = 'tsk_' + secrets.token_urlsafe(8)[:10]
        task = Task(task_id, source, v, indexes, timestamp_position)
        self.tasks[task_id] = task
        task.runner = asyncio.create_task(self.run(task))
        return task.snapshot()

    def path(self, logical):
        return self.host.WorkspacePathResolver().resolve_destination(logical, field_name='storyboard output', error_code='STORYBOARD_INVALID').physical_path

    async def annotate_sheet(self, source, output, v, sheet_index, duration, position):
        """Render labels directly over the received sheet; never rebuild its grid."""
        ffmpeg = self.host.find_component('ffmpeg', self.host.COMPONENTS['ffmpeg'][0])
        font_file = self.host.visual_map_font_file()
        if ffmpeg.error or not ffmpeg.executable or font_file is None:
            raise ValueError('Timestamp renderer is unavailable')
        filters = sheet_timestamp_filter(v, sheet_index, duration, position, font_file, self.host.ffmpeg_filter_value)
        command = [ffmpeg.executable, '-hide_banner', '-nostdin', '-v', 'error', '-i', str(source),
                   '-map', '0:v:0', '-an', '-frames:v', '1', '-vf', filters, '-q:v', '2', '-y', str(output)]
        returncode, _stderr = await self.host.run_visual_map_ffmpeg(command, 30)
        if returncode != 0 or not output.is_file() or output.stat().st_size > MAX_SHEET_BYTES:
            raise ValueError('Timestamp rendering failed')
        result = output.read_bytes()
        if not result.startswith(b'\xff\xd8\xff') or not result.endswith(b'\xff\xd9'):
            raise ValueError('Timestamp renderer produced an invalid JPEG')
        return result

    async def run(self, task):
        try:
            async with self.slots:
                for index in task.indexes:
                    task.failed_index = index
                    logical = filename(task.source['title'], task.source['videoId'], task.variant, index)
                    destination = self.path(logical)
                    identity = (task.timestamp_position, task.source['videoId'], task.variant['variantId'], index,
                                tuple(task.variant[key] for key in PUBLIC_FIELDS))
                    known = self.published.get(logical)
                    reused = False
                    task.phase = 'downloading'
                    if known and known[0] == identity and destination.is_file() and destination.stat().st_size <= MAX_SHEET_BYTES:
                        reused = hashlib.sha256(destination.read_bytes()).digest() == known[1]
                    if not reused:
                        def progress(received, total):
                            fraction = min(0.99, received / total) if total else 0
                            task.progress = max(task.progress, 100 * (task.completed + fraction) / len(task.indexes))
                        data = await fetch_sheet(task.variant['urls'][index], progress)
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination = self.path(logical)  # Recheck redirects after network await.
                        task.phase = 'publishing'
                        with tempfile.TemporaryDirectory(prefix='researchtube-storyboard-', dir=destination.parent.parent.parent) as temp:
                            temporary = Path(temp) / 'source.jpeg'
                            rendered = Path(temp) / 'sheet.jpeg'
                            temporary.write_bytes(data)
                            if task.timestamp_position == 'none':
                                rendered.write_bytes(data)
                            else:
                                await self.annotate_sheet(temporary, rendered, task.variant, index,
                                                          task.source['durationSeconds'], task.timestamp_position)
                            rendered_data = rendered.read_bytes()
                            digest = hashlib.sha256(rendered_data).digest()
                            if destination.exists():
                                if destination.is_symlink() or not destination.is_file():
                                    raise ValueError('Destination belongs to another file')
                                existing = destination.read_bytes()
                                if existing == rendered_data:
                                    reused = True
                                else:
                                    raise ValueError('Destination belongs to another file')
                            else:
                                # The rendered temporary is linked atomically, never
                                # replacing a concurrently created destination.
                                try:
                                    os.link(rendered, destination)
                                except FileExistsError:
                                    if destination.is_symlink() or destination.read_bytes() != rendered_data:
                                        raise ValueError('Destination already exists')
                                    reused = True
                        self.published[logical] = (identity, digest)
                    task.reused += int(reused)
                    task.downloaded += int(not reused)
                    task.completed += 1
                    task.progress = 100 * task.completed / len(task.indexes)
                    await asyncio.sleep(0)
                task.status = task.phase = 'completed'
                task.progress = 100
                task.failed_index = None
        except asyncio.CancelledError:
            task.status = task.phase = 'cancelled'
        except Exception:
            task.status = task.phase = 'failed'
            task.error = {'code': 'STORYBOARD_DOWNLOAD_FAILED',
                          'message': f'Could not download or safely publish storyboard sheet {task.failed_index}. Check availability, free space, and conflicting files.'}

    def get(self, task_id):
        if not isinstance(task_id, str) or task_id not in self.tasks:
            raise StoryboardError('TASK_NOT_FOUND', 'The storyboard task does not exist in this Agent session.')
        return self.tasks[task_id]

    async def cancel(self, task_id):
        task = self.get(task_id)
        if task.status == 'working':
            task.runner.cancel()
            await asyncio.gather(task.runner, return_exceptions=True)
            task.status = task.phase = 'cancelled'  # Includes cancellation before runner starts.
        return {'taskId': task.task_id, 'status': task.status}

    async def dispatch(self, operation, payload):
        try:
            if operation == 'info':
                return await self.info(payload)
            if operation == 'download':
                return await self.create(payload)
            if not isinstance(payload, dict) or set(payload) != {'taskId'}:
                invalid('Specify taskId only.')
            if operation == 'cancel':
                return await self.cancel(payload['taskId'])
            return self.get(payload['taskId']).snapshot()
        except StoryboardError as error:
            return reject(error.code, error.message)
        except Exception:
            return reject('STORYBOARD_CONTEXT_UNAVAILABLE', 'Storyboard context could not be read. Check the Agent and try again.')

    async def shutdown(self):
        runners = [t.runner for t in self.tasks.values() if not t.runner.done()]
        for runner in runners:
            runner.cancel()
        await asyncio.gather(*runners, return_exceptions=True)
