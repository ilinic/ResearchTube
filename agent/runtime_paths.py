"""Writable installation paths shared by source and frozen Agent launches."""
from pathlib import Path
import sys


def installation_root(script_path: str) -> Path:
    return Path(sys.executable if getattr(sys, 'frozen', False) else script_path).resolve().parent
