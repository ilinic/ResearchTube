# Config, Workspace, optional executables and Custom Tools remain external.
from pathlib import Path
import importlib.util
import sys
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

root = Path(SPECPATH)
hidden = []
data = []
if sys.platform == "win32":
    projections = ["winrt.system", "winrt.windows.foundation", "winrt.windows.foundation.collections",
                   "winrt.windows.media.playback", "winrt.windows.media.speechsynthesis",
                   "winrt.windows.storage", "winrt.windows.storage.streams"]
    for module in projections:
        if importlib.util.find_spec(module) is None:
            raise RuntimeError("Install agent/requirements-build.txt before building: " + module)
    # pkgutil recursion does not discover the windows/* namespace parents.
    # Include projection wrappers as well as their native modules explicitly.
    hidden = sorted(set(projections + collect_submodules("winrt", on_error="raise")))
    data = collect_data_files("winrt")

a = Analysis([str(root / "researchtube_agent.py")], pathex=[str(root)],
             binaries=[], datas=data, hiddenimports=hidden, hookspath=[],
             runtime_hooks=[], excludes=[], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name="ResearchTubeAgent",
          debug=False, bootloader_ignore_signals=False, strip=False,
          upx=False, console=True)
