#!/usr/bin/env python3
"""
List all Windows text-to-speech voices exposed through
Windows.Media.SpeechSynthesis.SpeechSynthesizer.

Windows only.

Install dependency:
    py -m pip install winrt-Windows.Media.SpeechSynthesis

Run:
    py list_windows_tts_voices.py
"""

import platform
import sys


def enum_name(value):
    if value is None:
        return ""
    name = getattr(value, "name", None)
    if name:
        return str(name)
    return str(value)


def main():
    if platform.system() != "Windows":
        print("ERROR: This script must be run on Windows.", file=sys.stderr)
        return 1

    try:
        from winrt.windows.media.speechsynthesis import SpeechSynthesizer
    except ImportError:
        print(
            "ERROR: PyWinRT SpeechSynthesis package is not installed.\n\n"
            "Install it with:\n"
            "    py -m pip install winrt-Windows.Media.SpeechSynthesis\n",
            file=sys.stderr,
        )
        return 2

    try:
        voices = list(SpeechSynthesizer.all_voices)
        default_voice = SpeechSynthesizer.default_voice
    except Exception as exc:
        print(f"ERROR: Could not enumerate Windows TTS voices: {exc}", file=sys.stderr)
        return 3

    default_id = getattr(default_voice, "id", None)

    print(f"Windows TTS voices visible to SpeechSynthesizer: {len(voices)}")
    if default_voice is not None:
        print(
            "Default voice: "
            f"{getattr(default_voice, 'display_name', '')} "
            f"[{getattr(default_voice, 'language', '')}]"
        )
    print()

    for index, voice in enumerate(voices, start=1):
        voice_id = getattr(voice, "id", "")
        marker = "  <-- DEFAULT" if voice_id == default_id else ""

        print(f"{index}. {getattr(voice, 'display_name', '')}{marker}")
        print(f"   Language:    {getattr(voice, 'language', '')}")
        print(f"   Gender:      {enum_name(getattr(voice, 'gender', None))}")
        print(f"   Description: {getattr(voice, 'description', '')}")
        print(f"   ID:          {voice_id}")
        print()

    print(
        "Note: this list is exactly what Windows.Media.SpeechSynthesis "
        "exposes to an application. If a Narrator Natural voice is installed "
        "but does not appear here, this WinRT API is not exposing it."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
