#!/usr/bin/env python3
"""
Minimal Windows WinRT TTS playback test.

Uses the current default Windows SpeechSynthesizer voice and plays
the generated speech through the normal Windows audio output.

Install dependencies once:

    py -m pip install ^
        winrt-runtime ^
        winrt-Windows.Foundation ^
        winrt-Windows.Foundation.Collections ^
        winrt-Windows.Media.SpeechSynthesis ^
        winrt-Windows.Media.Playback ^
        winrt-Windows.Storage ^
        winrt-Windows.Storage.Streams

Run:

    py test_windows_tts.py
"""

import asyncio
import platform
import sys


TEXT = (
    "Здравствуйте. Это тест синтеза речи Windows. "
    "Если вы слышите это сообщение, синтез и воспроизведение работают нормально."
)


async def speak():
    try:
        from winrt.system import Object
        from winrt.windows.media.speechsynthesis import SpeechSynthesizer
        from winrt.windows.media.playback import MediaPlayer, MediaPlayerAudioCategory
    except ImportError as exc:
        print(f"IMPORT ERROR: {exc}", file=sys.stderr)
        print(
            "\nInstall the required packages with:\n"
            "py -m pip install "
            "winrt-runtime "
            "winrt-Windows.Foundation "
            "winrt-Windows.Foundation.Collections "
            "winrt-Windows.Media.SpeechSynthesis "
            "winrt-Windows.Media.Playback "
            "winrt-Windows.Storage "
            "winrt-Windows.Storage.Streams",
            file=sys.stderr,
        )
        return 2

    synth = SpeechSynthesizer()

    default_voice = SpeechSynthesizer.default_voice
    print("Default voice:")
    print(f"  Name:     {default_voice.display_name}")
    print(f"  Language: {default_voice.language}")
    print(f"  ID:       {default_voice.id}")
    print()

    print("Synthesizing...")
    try:
        stream = await synth.synthesize_text_to_stream_async(TEXT)
    except Exception as exc:
        print(f"SYNTHESIS ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 3

    print(f"Synthesis OK. Content type: {stream.content_type}")
    print("Playing...")

    finished = asyncio.Event()
    loop = asyncio.get_running_loop()
    playback_error = {"error": None}

    player = MediaPlayer()
    player.audio_category = MediaPlayerAudioCategory.SPEECH
    player.set_stream_source(stream)

    def on_media_ended(sender, args: Object):
        loop.call_soon_threadsafe(finished.set)

    def on_media_failed(sender, args):
        try:
            message = getattr(args, "error_message", None)
            code = getattr(args, "extended_error_code", None)
            playback_error["error"] = f"{message or 'Media playback failed'}; code={code}"
        except Exception as exc:
            playback_error["error"] = repr(exc)
        loop.call_soon_threadsafe(finished.set)

    ended_token = player.add_media_ended(on_media_ended)
    failed_token = player.add_media_failed(on_media_failed)

    try:
        player.play()

        # A generous timeout so that a broken playback path doesn't hang forever.
        try:
            await asyncio.wait_for(finished.wait(), timeout=60)
        except asyncio.TimeoutError:
            print("PLAYBACK ERROR: timed out waiting for playback to finish.", file=sys.stderr)
            return 4

        if playback_error["error"]:
            print(f"PLAYBACK ERROR: {playback_error['error']}", file=sys.stderr)
            return 5

        print("Playback completed successfully.")
        return 0

    finally:
        # Remove WinRT event handlers before Python exits.
        try:
            player.remove_media_ended(ended_token)
        except Exception:
            pass
        try:
            player.remove_media_failed(failed_token)
        except Exception:
            pass
        try:
            player.pause()
        except Exception:
            pass
        try:
            player.close()
        except Exception:
            pass
        try:
            stream.close()
        except Exception:
            pass
        try:
            synth.close()
        except Exception:
            pass


def main():
    if platform.system() != "Windows":
        print("ERROR: This script must be run on Windows.", file=sys.stderr)
        return 1

    try:
        return asyncio.run(speak())
    except Exception as exc:
        print(f"UNEXPECTED ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 10


if __name__ == "__main__":
    raise SystemExit(main())
