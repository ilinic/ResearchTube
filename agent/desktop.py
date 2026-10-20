"""Windows tray host. The server runs independently of the read-only log window."""
from __future__ import annotations

import asyncio
from collections import deque
import ctypes
import io
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import traceback


def child_process_options():
    """Never flash a console when a background Agent starts a CLI tool."""
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def launch_pythonw(script: Path, arguments: list[str]) -> bool:
    """Release a source-mode terminal without hiding or closing its parent shell."""
    if sys.platform != "win32" or getattr(sys, "frozen", False):
        return False
    executable = Path(sys.executable)
    if executable.stem.lower() == "pythonw":
        return False
    pythonw = executable.with_name("pythonw.exe")
    if not pythonw.is_file():
        raise OSError("pythonw.exe is missing. Install Python for Windows with Tcl/Tk, or use --console.")
    subprocess.Popen([str(pythonw), str(script), *arguments], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
    return True


class InstanceLock:
    """One Windows Agent per loopback port, including console and tray launches."""
    def __init__(self, port):
        self.port = port
        self.handle = None

    def acquire(self):
        if sys.platform != "win32":
            return True
        from ctypes import wintypes
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel.CreateMutexW.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.handle = self.kernel.CreateMutexW(None, False, f"Local\\ResearchTubeAgent-{self.port}")
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
            self.close()
            return False
        return True

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


class LogFileHandler(RotatingFileHandler):
    def handleError(self, record):
        # logging's default handler writes to stderr, which this host captures.
        # Avoid recursive logging if the disk fills or a rotated file is locked.
        self.failed = True


class LogStore:
    """Thread-safe bounded live history plus rotated local UTF-8 logs."""
    def __init__(self, path, max_lines=4000, max_bytes=512_000):
        self.lock = threading.RLock()
        self.lines = deque()
        self.sequence = 0
        self.size = 0
        self.max_lines, self.max_bytes = max_lines, max_bytes
        path.parent.mkdir(parents=True, exist_ok=True)
        self.handler = LogFileHandler(path, maxBytes=2_000_000, backupCount=2, encoding="utf-8")
        self.handler.setFormatter(logging.Formatter("%(message)s"))
        self.file_warning_shown = False

    def append(self, text):
        # Bound a single accidental diagnostic as well as the total history.
        text = str(text)[:16_000].rstrip("\r\n") + "\n"
        with self.lock:
            self.sequence += 1
            self.lines.append((self.sequence, text))
            self.size += len(text.encode("utf-8"))
            self.handler.emit(logging.LogRecord("ResearchTube", logging.INFO, "", 0, text.rstrip("\n"), (), None))
            if getattr(self.handler, "failed", False) and not self.file_warning_shown:
                self.file_warning_shown = True
                self.sequence += 1
                warning = "Could not write the local log file. Live logging continues.\n"
                self.lines.append((self.sequence, warning))
                self.size += len(warning)
            while len(self.lines) > self.max_lines or self.size > self.max_bytes:
                self.size -= len(self.lines.popleft()[1].encode("utf-8"))

    def read(self, cursor=0):
        with self.lock:
            reset = bool(self.lines and cursor < self.lines[0][0] - 1)
            return self.sequence, reset, "".join(text for number, text in self.lines if reset or number > cursor)

    def close(self):
        self.handler.close()


class LogStream(io.TextIOBase):
    def __init__(self, store):
        self.store = store
        self.pending = ""
        self.lock = threading.RLock()

    @property
    def encoding(self):
        return "utf-8"

    def writable(self):
        return True

    def write(self, text):
        with self.lock:
            self.pending += text
            while "\n" in self.pending or len(self.pending) >= 16_000:
                end = self.pending.find("\n")
                end = min(end if end >= 0 else 16_000, 16_000)
                self.store.append(self.pending[:end])
                consumed = end + (1 if self.pending[end:end + 1] == "\n" else 0)
                self.pending = self.pending[consumed:]
        return len(text)

    def flush(self):
        with self.lock:
            if self.pending:
                self.store.append(self.pending)
                self.pending = ""


class AgentWorker:
    """Thread-owned asyncio loop; Exit cancels serve() and awaits its cleanup."""
    def __init__(self, serve):
        self.serve = serve
        self.state = "Starting"
        self.exit_code = 0
        self.done = threading.Event()
        self.stop_requested = threading.Event()
        self.loop = self.task = None
        self.thread = threading.Thread(target=self._run, name="ResearchTube-Agent")

    def start(self):
        self.thread.start()

    def ready(self):
        if not self.stop_requested.is_set():
            self.state = "Running"

    def stop(self):
        self.stop_requested.set()
        self.state = "Stopping"
        if self.loop and self.task and not self.done.is_set():
            try:
                self.loop.call_soon_threadsafe(self.task.cancel)
            except RuntimeError:  # Already completed and closed its event loop.
                pass

    def _run(self):
        async def run():
            self.loop = asyncio.get_running_loop()
            self.task = asyncio.create_task(self.serve(self.ready))
            if self.stop_requested.is_set():
                self.task.cancel()
            await self.task

        try:
            asyncio.run(run())
        except asyncio.CancelledError:
            self.state = "Stopped"
        except Exception:
            self.exit_code = 1
            self.state = "Failed"
            traceback.print_exc()
        else:
            self.state = "Stopped"
        finally:
            self.done.set()


def show_error(message):
    if sys.platform == "win32":
        ctypes.windll.user32.MessageBoxW(None, str(message), "ResearchTube Agent", 0x10)
    elif sys.stderr:
        print(message, file=sys.stderr)


def restore_console():
    """Explicit --console restores the EXE's bootloader-hidden owned console."""
    from ctypes import wintypes
    kernel = ctypes.windll.kernel32
    kernel.GetConsoleWindow.restype = wintypes.HWND
    user = ctypes.windll.user32
    user.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user.ShowWindow(kernel.GetConsoleWindow(), 5)


def run_tray(serve, installation: Path, workspace, version: str) -> int:
    """Tk stays on the main thread; pystray's Windows loop owns a second thread."""
    if sys.platform != "win32":
        raise OSError("Tray mode is currently supported on Windows. Use --console on this platform.")
    # Import GUI dependencies only in tray mode: headless/console mode stays light.
    import tkinter as tk
    from tkinter import ttk
    from tkinter.scrolledtext import ScrolledText
    import pystray
    from PIL import Image

    # Use the exact Extension artwork from the extracted installation.
    artwork = installation.parent / "extension" / "icons" / "researchtube-128.png"
    with Image.open(artwork) as original:
        image = original.convert("RGBA")
    root = tk.Tk()
    root.withdraw()
    root.title(f"ResearchTube Agent {version}")
    root.geometry("900x520")
    root.minsize(480, 240)
    photo = tk.PhotoImage(file=str(artwork))
    root.iconphoto(True, photo)
    root.protocol("WM_DELETE_WINDOW", root.withdraw)
    store = LogStore(installation / "logs" / "agent.log")
    previous = sys.stdout, sys.stderr
    out, err = LogStream(store), LogStream(store)
    sys.stdout, sys.stderr = out, err
    commands = queue.Queue(maxsize=32)
    worker = AgentWorker(serve)
    status = tk.StringVar(value="Starting")
    toolbar = ttk.Frame(root, padding=8)
    toolbar.pack(fill="x")
    ttk.Label(toolbar, textvariable=status).pack(side="left")
    follow = tk.BooleanVar(value=True)
    ttk.Checkbutton(toolbar, text="Auto-scroll", variable=follow).pack(side="right")

    def copy_log():
        selection = text.tag_ranges("sel")
        value = text.get(*selection) if selection else store.read()[2]
        root.clipboard_clear()
        root.clipboard_append(value)

    ttk.Button(toolbar, text="Copy log", command=copy_log).pack(side="right", padx=8)
    text = ScrolledText(root, wrap="word", state="disabled", font=("Consolas", 10))
    text.pack(fill="both", expand=True, padx=8, pady=(0, 8))
    cursor = 0
    closing = False
    failed_shown = False
    last_state = None

    def enqueue(command):
        try:
            commands.put_nowait(command)
        except queue.Full:
            if command in {"exit", "tray_failed"}:
                # A burst of show requests must never discard an Exit action.
                commands.get_nowait()
                commands.put_nowait(command)

    icon = pystray.Icon("ResearchTube", image, f"ResearchTube Agent {version}", pystray.Menu(
        pystray.MenuItem(lambda _: f"Agent: {worker.state}", None, enabled=False),
        pystray.MenuItem("Open log", lambda *_: enqueue("show"), default=True),
        pystray.MenuItem("Open Workspace", lambda *_: enqueue("workspace")),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Exit", lambda *_: enqueue("exit")),
    ))

    def icon_run():
        try:
            # Start the server only after the tray icon has actually appeared.
            icon.run(setup=lambda current: (setattr(current, "visible", True), worker.start()))
        except Exception:
            traceback.print_exc()
            enqueue("tray_failed")

    icon_thread = threading.Thread(target=icon_run, name="ResearchTube-Tray", daemon=True)

    def render():
        nonlocal cursor
        cursor, reset, additions = store.read(cursor)
        if not additions:
            return
        at_bottom = text.yview()[1] >= 0.99
        text.configure(state="normal")
        if reset:
            text.delete("1.0", "end")
        text.insert("end", additions)
        # The window is bounded independently of its open/close history.
        excess = int(text.index("end-1c").split(".")[0]) - store.max_lines
        if excess > 0:
            text.delete("1.0", f"{excess + 1}.0")
        extra_chars = text.count("1.0", "end-1c", "chars")[0] - store.max_bytes
        if extra_chars > 0:
            text.delete("1.0", f"1.0+{extra_chars}c")
        text.configure(state="disabled")
        if follow.get() and (at_bottom or reset):
            text.see("end")

    def tick():
        nonlocal closing, failed_shown, last_state
        while not commands.empty():
            command = commands.get_nowait()
            if command == "show":
                root.deiconify()
                root.lift()
                render()
            elif command == "workspace":
                try:
                    os.startfile(str(workspace()))
                except OSError as error:
                    print(f"Could not open Workspace: {error}", file=sys.stderr)
                    root.deiconify()
            elif command in {"exit", "tray_failed"}:
                closing = True
                worker.stop()
                if command == "tray_failed" and not worker.thread.ident:
                    worker.done.set()
                    worker.exit_code = 1
                    show_error("ResearchTube could not create its tray icon. See agent/logs/agent.log.")
        if worker.state != last_state:
            last_state = worker.state
            status.set(f"Agent: {last_state}")
            icon.title = f"ResearchTube Agent {version} — {last_state}"
        if worker.state == "Failed" and not failed_shown:
            root.deiconify()
            failed_shown = True
        if root.state() != "withdrawn":
            render()
        if closing and worker.done.is_set():
            root.destroy()
            return
        root.after(200, tick)

    root.report_callback_exception = lambda *error: traceback.print_exception(*error)
    try:
        icon_thread.start()
        root.after(200, tick)
        root.mainloop()
    finally:
        worker.stop()
        if worker.thread.ident:
            worker.thread.join()  # serve() awaits cancellation of owned tasks.
        icon.stop()
        icon_thread.join(timeout=2)
        out.flush()
        err.flush()
        sys.stdout, sys.stderr = previous
        store.close()
    return worker.exit_code
