"""Double-click launcher for source-mode Windows tray operation."""
import sys
from researchtube_agent import main

if __name__ == "__main__":
    raise SystemExit(main(["--tray", *sys.argv[1:]]))
