#!/usr/bin/env python3
"""Source-mode entry point for the shared ResearchTube Windows speech helper."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from windows_speech import main

if __name__ == "__main__":
    raise SystemExit(main())
