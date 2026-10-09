# Config, Workspace, optional executables and Custom Tools remain external.
from pathlib import Path
import importlib.util
import sys
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

root = Path(SPECPATH)
hidden = []
data = []
if sys.platform == "win32":
    for module in ["winrt.system", "winrt.windows.foundation", "winrt.windows.media.playback",
                   "winrt.windows.media.speechsynthesis", "winrt.windows.storage.streams"]:
        if importlib.util.find_spec(module) is None:
            raise RuntimeError("Install agent/requirements-build.txt before building: " + module)
    hidden = collect_submodules("winrt", on_error="raise")
    data = collect_data_files("winrt")

a = Analysis([str(root / "researchtube_agent.py")], pathex=[str(root)],
             binaries=[], datas=data, hiddenimports=hidden, hookspath=[],
             runtime_hooks=[], excludes=[], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name="ResearchTubeAgent",
          debug=False, bootloader_ignore_signals=False, strip=False,
          upx=False, console=True)
