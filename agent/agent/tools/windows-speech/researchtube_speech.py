#!/usr/bin/env python3
"""Windows WinRT speech helper for ResearchTube Local Agent.

Writes compact JSONL progress events to stdout.  Text and voice IDs are passed
as UTF-8 base64 so arbitrary Unicode never depends on a command-line encoding.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
from pathlib import Path
import struct
import sys


def emit(event: str, completed: int = 0, total: int = 0, progress_percent: float | None = None) -> None:
    document: dict[str, object] = {"event": event, "completedChunks": completed, "totalChunks": total}
    if progress_percent is not None:
        document["progressPercent"] = round(max(0.0, min(100.0, progress_percent)), 1)
    print(json.dumps(document, separators=(",", ":")), flush=True)


def decode(value: str) -> str:
    return base64.b64decode(value.encode("ascii")).decode("utf-8") if value else ""


def chunks(text: str, maximum: int = 300) -> list[str]:
    remaining = text.strip()
    result: list[str] = []
    while len(remaining) > maximum:
        cut = max((remaining.rfind(mark, 0, maximum) for mark in ".!?;:\n"), default=-1)
        if cut < int(maximum * 0.55):
            cut = remaining.rfind(" ", 0, maximum)
        if cut < 1:
            cut = maximum
        else:
            cut += 1
        result.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
    if remaining:
        result.append(remaining)
    return result


def load_winrt():
    from winrt.system import Object
    from winrt.windows.media.playback import MediaPlayer, MediaPlayerAudioCategory
    from winrt.windows.media.speechsynthesis import SpeechSynthesizer
    from winrt.windows.storage.streams import DataReader
    return Object, MediaPlayer, MediaPlayerAudioCategory, SpeechSynthesizer, DataReader


def voice_gender(value) -> str:
    """Map all Windows VoiceGender variants to the compact MCP vocabulary."""
    text = str(value).lower()
    if "female" in text:
        return "female"
    if "male" in text:
        return "male"
    # Windows also exposes UNKNOWN on some installed or legacy voices.
    return "neutral"


def seconds(value) -> float | None:
    """Return a WinRT TimeSpan-like value in seconds when it is available."""
    try:
        result = value.total_seconds()
    except (AttributeError, TypeError, ValueError, OverflowError):
        return None
    return result if result >= 0 else None


def list_voices() -> int:
    _Object, _MediaPlayer, _Category, SpeechSynthesizer, _DataReader = load_winrt()
    synthesizer = SpeechSynthesizer()
    try:
        default_id = SpeechSynthesizer.default_voice.id
        voices = [{
            "voiceId": voice.id,
            "name": voice.display_name,
            "language": voice.language,
            "gender": voice_gender(voice.gender),
            "isDefault": voice.id == default_id,
        } for voice in SpeechSynthesizer.all_voices]
        print(json.dumps({"voices": voices}, ensure_ascii=False, separators=(",", ":")), flush=True)
        return 0
    finally:
        synthesizer.close()


def voice_info(voice_id: str) -> int:
    """Return only the selected voice's display name for Agent-side filenames."""
    _Object, _MediaPlayer, _Category, SpeechSynthesizer, _DataReader = load_winrt()
    synthesizer = SpeechSynthesizer()
    try:
        if voice_id:
            voice = next((item for item in SpeechSynthesizer.all_voices if item.id == voice_id), None)
            if voice is None:
                raise RuntimeError("VOICE_NOT_FOUND")
        else:
            voice = synthesizer.voice
        print(json.dumps({"name": voice.display_name}, ensure_ascii=False, separators=(",", ":")), flush=True)
        return 0
    finally:
        synthesizer.close()


async def stream_bytes(stream, DataReader) -> bytes:
    """Read one small WinRT speech stream without exposing it to the Agent."""
    size = int(stream.size)
    if size < 44 or size > 64 * 1024 * 1024:
        raise RuntimeError("SPEECH_FILE_FAILED: Windows returned an invalid speech stream.")
    reader = DataReader(stream.get_input_stream_at(0))
    try:
        loaded = int(await reader.load_async(size))
        if loaded != size:
            raise RuntimeError("SPEECH_FILE_FAILED: Windows returned a truncated speech stream.")
        return bytes(reader.read_bytes(size))
    finally:
        reader.close()


def wav_parts(value: bytes) -> tuple[bytes, bytes]:
    """Extract fmt/data chunks from the WAV container emitted by WinRT."""
    if len(value) < 20 or value[:4] != b"RIFF" or value[8:12] != b"WAVE":
        raise RuntimeError("SPEECH_FILE_FAILED: Windows returned unsupported speech audio.")
    position, fmt, data = 12, None, None
    while position + 8 <= len(value):
        chunk_id = value[position:position + 4]
        size = struct.unpack_from("<I", value, position + 4)[0]
        start, end = position + 8, position + 8 + size
        if end > len(value):
            raise RuntimeError("SPEECH_FILE_FAILED: Windows returned malformed speech audio.")
        if chunk_id == b"fmt ":
            fmt = value[start:end]
        elif chunk_id == b"data":
            data = value[start:end]
        position = end + (size % 2)
    if fmt is None or data is None or not fmt:
        raise RuntimeError("SPEECH_FILE_FAILED: Windows returned incomplete speech audio.")
    return fmt, data


class WaveWriter:
    """Atomically-ready WAV payload builder for individually synthesized chunks."""
    def __init__(self, output_path: str):
        self.path = Path(output_path)
        self.raw_path = self.path.with_suffix(self.path.suffix + ".pcm")
        self.fmt: bytes | None = None
        self.data_size = 0
        self.raw = None

    def append(self, value: bytes) -> None:
        fmt, data = wav_parts(value)
        if self.fmt is None:
            self.fmt = fmt
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.raw = self.raw_path.open("xb")
        elif self.fmt != fmt:
            raise RuntimeError("SPEECH_FILE_FAILED: Windows changed the speech audio format during synthesis.")
        assert self.raw is not None
        self.raw.write(data)
        self.data_size += len(data)

    def close(self) -> None:
        if self.raw is not None:
            self.raw.close()
            self.raw = None
        if self.fmt is None or self.data_size <= 0:
            raise RuntimeError("SPEECH_FILE_FAILED: Windows produced no speech audio.")
        pad = self.data_size % 2
        riff_size = 4 + 8 + len(self.fmt) + (len(self.fmt) % 2) + 8 + self.data_size + pad
        if riff_size > 0xFFFFFFFF:
            raise RuntimeError("SPEECH_FILE_FAILED: Generated speech audio is too large for WAV.")
        with self.path.open("xb") as destination, self.raw_path.open("rb") as raw:
            destination.write(b"RIFF" + struct.pack("<I", riff_size) + b"WAVE")
            destination.write(b"fmt " + struct.pack("<I", len(self.fmt)) + self.fmt)
            if len(self.fmt) % 2:
                destination.write(b"\x00")
            destination.write(b"data" + struct.pack("<I", self.data_size))
            while chunk := raw.read(64 * 1024):
                destination.write(chunk)
            if pad:
                destination.write(b"\x00")
        self.raw_path.unlink(missing_ok=True)

    def discard(self) -> None:
        if self.raw is not None:
            self.raw.close()
            self.raw = None
        self.path.unlink(missing_ok=True)
        self.raw_path.unlink(missing_ok=True)


async def speak(text: str, voice_id: str, output_path: str | None, play_through_speakers: bool) -> int:
    Object, MediaPlayer, MediaPlayerAudioCategory, SpeechSynthesizer, DataReader = load_winrt()
    synthesizer = SpeechSynthesizer()
    player = MediaPlayer() if play_through_speakers else None
    if player is not None:
        player.audio_category = MediaPlayerAudioCategory.SPEECH
    writer = WaveWriter(output_path) if output_path else None
    ended_token = failed_token = None
    try:
        if voice_id:
            voice = next((item for item in SpeechSynthesizer.all_voices if item.id == voice_id), None)
            if voice is None:
                raise RuntimeError("VOICE_NOT_FOUND")
            synthesizer.voice = voice
        pieces = chunks(text)
        total = len(pieces)
        total_characters = sum(len(piece) for piece in pieces)
        completed_characters = 0
        for index, piece in enumerate(pieces):
            emit("synthesizing", index, total)
            stream = await synthesizer.synthesize_text_to_stream_async(piece)
            if writer is not None:
                emit("saving", index, total)
                writer.append(await stream_bytes(stream, DataReader))
                stream.seek(0)
            if player is None:
                stream.close()
                completed_characters += len(piece)
                emit("chunkCompleted", index + 1, total, completed_characters * 100.0 / total_characters)
                continue
            finished = asyncio.Event()
            playback_error: dict[str, str | None] = {"message": None}
            loop = asyncio.get_running_loop()

            def on_ended(sender, args: Object) -> None:
                loop.call_soon_threadsafe(finished.set)

            def on_failed(sender, args) -> None:
                message = getattr(args, "error_message", None) or "Media playback failed"
                playback_error["message"] = str(message)
                loop.call_soon_threadsafe(finished.set)

            ended_token = player.add_media_ended(on_ended)
            failed_token = player.add_media_failed(on_failed)
            started_at = asyncio.get_running_loop().time()

            async def report_playback_progress() -> None:
                while not finished.is_set():
                    await asyncio.sleep(0.5)
                    if finished.is_set():
                        break
                    # NaturalDuration/Position are present on supported Windows
                    # builds after playback starts.  Fall back to a conservative
                    # text-length estimate while they are still unavailable.
                    ratio: float | None = None
                    try:
                        session = player.playback_session
                        duration = seconds(session.natural_duration)
                        position = seconds(session.position)
                        if duration is not None and duration > 0.05 and position is not None:
                            ratio = position / duration
                    except Exception:
                        pass
                    if ratio is None:
                        estimated_seconds = max(2.0, len(piece) / 14.0)
                        ratio = (asyncio.get_running_loop().time() - started_at) / estimated_seconds
                    overall = (completed_characters + len(piece) * min(0.98, max(0.0, ratio))) * 100.0 / total_characters
                    emit("speaking", index, total, min(99.0, overall))

            progress_reporter: asyncio.Task[None] | None = None
            try:
                player.set_stream_source(stream)
                emit("speaking", index, total)
                player.play()
                progress_reporter = asyncio.create_task(report_playback_progress())
                await finished.wait()
                if playback_error["message"]:
                    raise RuntimeError(f"AUDIO_PLAYBACK_FAILED: {playback_error['message']}")
            finally:
                if progress_reporter is not None:
                    progress_reporter.cancel()
                    await asyncio.gather(progress_reporter, return_exceptions=True)
                if ended_token is not None:
                    player.remove_media_ended(ended_token)
                    ended_token = None
                if failed_token is not None:
                    player.remove_media_failed(failed_token)
                    failed_token = None
                stream.close()
            completed_characters += len(piece)
            emit("chunkCompleted", index + 1, total, completed_characters * 100.0 / total_characters)
        if writer is not None:
            writer.close()
            writer = None
            emit("saved", total, total, 100.0)
        emit("completed", total, total)
        return 0
    finally:
        if ended_token is not None:
            player.remove_media_ended(ended_token)
        if failed_token is not None:
            player.remove_media_failed(failed_token)
        if writer is not None:
            writer.discard()
        if player is not None:
            player.pause()
            player.close()
        synthesizer.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", required=True, choices=("list-voices", "voice-info", "speak"))
    parser.add_argument("--text-base64", default="")
    parser.add_argument("--voice-id-base64", default="")
    parser.add_argument("--output-path-base64", default="")
    parser.add_argument("--play-through-speakers", choices=("true", "false"), default="true")
    args = parser.parse_args()
    try:
        if args.action == "list-voices":
            return list_voices()
        if args.action == "voice-info":
            return voice_info(decode(args.voice_id_base64))
        encoded_text = sys.stdin.read() if args.text_base64 == "__STDIN__" else args.text_base64
        text = decode(encoded_text)
        if not text.strip():
            raise RuntimeError("Text is required.")
        return asyncio.run(speak(text, decode(args.voice_id_base64), decode(args.output_path_base64) or None, args.play_through_speakers == "true"))
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
