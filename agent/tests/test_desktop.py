"""Desktop host: bounded logs, real loopback lifecycle, launch routing and shutdown."""
import asyncio
from contextlib import redirect_stderr
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from agent import desktop
from agent import researchtube_agent as agent


class DesktopTests(unittest.TestCase):
    def test_live_log_unicode_partial_writes_rotation_and_hidden_reader(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'logs/agent.log'
            store = desktop.LogStore(path, max_lines=3, max_bytes=200)
            stream = desktop.LogStream(store)
            try:
                stream.write('Первая ')
                stream.write('строка\n')
                cursor, reset, text = store.read()
                self.assertEqual(text, 'Первая строка\n')
                self.assertFalse(reset)
                for index in range(8):
                    print(f'Live {index}', file=stream, flush=True)
                _, reset, text = store.read(cursor)
                self.assertTrue(reset, 'reopening an old reader rebuilds bounded recent history')
                self.assertEqual(text, 'Live 5\nLive 6\nLive 7\n')
                self.assertLessEqual(store.size, 200)
                self.assertIn('Первая строка', path.read_text(encoding='utf-8'))
                store.handler.maxBytes = 40
                for _ in range(10):
                    print('rotation ' * 4, file=stream, flush=True)
                self.assertTrue(path.with_suffix('.log.1').is_file())
                self.assertLessEqual(len(list(path.parent.iterdir())), 3)
            finally:
                stream.flush()
                store.close()

    def test_disk_logging_failure_keeps_live_log_without_recursion(self):
        with tempfile.TemporaryDirectory() as folder:
            store = desktop.LogStore(Path(folder) / 'agent.log')
            try:
                with patch.object(store.handler, 'shouldRollover', side_effect=OSError('disk unavailable')):
                    store.append('Still running')
                    store.append('Next line')
                text = store.read()[2]
                self.assertIn('Still running', text)
                self.assertIn('Next line', text)
                self.assertEqual(text.count('Could not write the local log'), 1)
            finally:
                store.close()

    def test_tray_show_close_reopen_and_exit_with_threaded_server(self):
        # Exercise the host lifecycle without claiming native Windows GUI coverage.
        ready, cleaned = threading.Event(), threading.Event()
        roots, icons, texts, buttons = [], [], [], {}

        class Value:
            def __init__(self, value=None): self.value = value
            def get(self): return self.value
            def set(self, value): self.value = value

        class Widget:
            def __init__(self, *args, **kwargs):
                self.command = kwargs.get('command')
                if self.command:
                    buttons[kwargs.get('text')] = self
            def pack(self, **kwargs): pass

        class Text(Widget):
            def __init__(self, *args, **kwargs):
                self.text = ''
                self.selection = ''
                texts.append(self)
            def configure(self, **kwargs): pass
            def insert(self, where, value): self.text += value
            def delete(self, start, end): self.text = ''
            def yview(self): return (0., 1.)
            def index(self, where): return f'{self.text.count(chr(10)) + 1}.0'
            def count(self, *args): return (len(self.text),)
            def see(self, where): pass
            def tag_ranges(self, tag): return ('sel.first', 'sel.last') if self.selection else ()
            def get(self, first, last): return self.selection

        class Root:
            def __init__(self):
                self.callbacks, self.protocols = [], {}
                self.hidden, self.destroyed = False, False
                roots.append(self)
            def withdraw(self): self.hidden = True
            def deiconify(self): self.hidden = False
            def lift(self): pass
            def state(self): return 'withdrawn' if self.hidden else 'normal'
            def title(self, value): pass
            def geometry(self, value): pass
            def minsize(self, *args): pass
            def iconphoto(self, *args): pass
            def protocol(self, name, fn): self.protocols[name] = fn
            def after(self, _delay, fn): self.callbacks.append(fn)
            def destroy(self): self.destroyed = True
            def clipboard_clear(self): self.clipboard = ''
            def clipboard_append(self, value): self.clipboard += value
            def mainloop(self):
                self_test.assertTrue(ready.wait(2))
                self_test.assertTrue(self.hidden, 'no log window at startup')
                print('Live log after startup', flush=True)
                icons[0].choose('Open log')
                deadline = time.monotonic() + 3
                phase = 0
                while not self.destroyed and time.monotonic() < deadline:
                    for callback in self.callbacks[:]:
                        self.callbacks.remove(callback)
                        callback()
                    if phase == 0 and not self.hidden:
                        self_test.assertIn('Live log after startup', texts[0].text)
                        texts[0].selection = 'log after startup'
                        buttons['Copy log'].command()
                        self_test.assertEqual(self.clipboard, 'log after startup')
                        texts[0].selection = ''
                        buttons['Copy log'].command()
                        self_test.assertEqual(self.clipboard, 'Live log after startup\n')
                        self.protocols['WM_DELETE_WINDOW']()
                        self_test.assertTrue(self.hidden)
                        self_test.assertFalse(cleaned.is_set(), 'closing log must not cancel the server')
                        print('While hidden', flush=True)
                        icons[0].choose('Open log')
                        phase = 1
                    elif phase == 1 and not self.hidden:
                        self_test.assertIn('While hidden', texts[0].text)
                        icons[0].choose('Exit')
                        phase = 2
                    time.sleep(.002)
                self_test.assertTrue(self.destroyed)

        class MenuItem:
            def __init__(self, text, action, **kwargs): self.text, self.action = text, action
        class Menu(tuple):
            SEPARATOR = object()
            def __new__(cls, *items): return super().__new__(cls, items)
        class Icon:
            def __init__(self, _name, _image, _title, menu):
                self.menu, self.stopped = menu, threading.Event()
                icons.append(self)
            def run(self, setup):
                setup(self)
                self.stopped.wait(5)
            def stop(self): self.stopped.set()
            def choose(self, name):
                next(item for item in self.menu if getattr(item, 'text', None) == name).action(self, None)

        async def serve(on_ready):
            on_ready()
            ready.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()

        self_test = self
        image = Mock()
        image.__enter__ = Mock(return_value=image)
        image.__exit__ = Mock(return_value=False)
        modules = {
            'tkinter': SimpleNamespace(Tk=Root, PhotoImage=Mock(), StringVar=Value, BooleanVar=Value,
                                      ttk=SimpleNamespace(Frame=Widget, Label=Widget, Button=Widget, Checkbutton=Widget)),
            'tkinter.scrolledtext': SimpleNamespace(ScrolledText=Text),
            'pystray': SimpleNamespace(Icon=Icon, Menu=Menu, MenuItem=MenuItem),
            'PIL': SimpleNamespace(Image=SimpleNamespace(open=Mock(return_value=image))),
        }
        with tempfile.TemporaryDirectory() as folder, patch.dict(sys.modules, modules), \
             patch.object(sys, 'platform', 'win32'):
            self.assertEqual(desktop.run_tray(serve, Path(folder), lambda: Path(folder), 'test'), 0)
        self.assertTrue(cleaned.is_set())
        self.assertTrue(icons[0].stopped.is_set())

    def test_server_survives_without_log_window_and_exit_awaits_cleanup(self):
        ready, cleaned = threading.Event(), threading.Event()
        address = []

        async def serve(on_ready):
            async def handle(reader, writer):
                await reader.readuntil(b'\r\n\r\n')
                writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')
                await writer.drain()
                writer.close()
                await writer.wait_closed()
            server = await asyncio.start_server(handle, '127.0.0.1', 0)
            address.append(server.sockets[0].getsockname())
            on_ready()
            ready.set()
            try:
                async with server:
                    await server.serve_forever()
            finally:
                cleaned.set()

        worker = desktop.AgentWorker(serve)
        worker.start()
        try:
            self.assertTrue(ready.wait(2))
            self.assertEqual(worker.state, 'Running')
            # No GUI/reader exists, yet the real service remains responsive.
            for _ in range(2):
                with socket.create_connection(address[0], timeout=2) as connection:
                    connection.sendall(b'GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n')
                    self.assertIn(b'200 OK', connection.recv(1024))
            self.assertFalse(worker.done.is_set())
        finally:
            worker.stop()
            self.assertTrue(worker.done.wait(2))
            worker.thread.join(2)
        self.assertTrue(cleaned.is_set())
        self.assertEqual(worker.exit_code, 0)
        with self.assertRaises(OSError):
            socket.create_connection(address[0], timeout=0.2)

    def test_startup_failure_is_retained_and_early_exit_is_safe(self):
        async def fail(_ready):
            raise OSError('Port occupied')
        with redirect_stderr(io.StringIO()) as log:
            worker = desktop.AgentWorker(fail)
            worker.start()
            self.assertTrue(worker.done.wait(2))
            worker.thread.join(2)
        self.assertEqual(worker.state, 'Failed')
        self.assertEqual(worker.exit_code, 1)
        self.assertIn('Port occupied', log.getvalue())
        entered = threading.Event()
        async def never(_ready):
            entered.set()
            await asyncio.Event().wait()
        worker = desktop.AgentWorker(never)
        worker.stop()
        worker.start()
        self.assertTrue(worker.done.wait(2))
        worker.thread.join(2)
        self.assertFalse(entered.is_set())

    def test_pythonw_launch_detaches_without_touching_parent_console(self):
        with patch.object(sys, 'platform', 'win32'), patch.object(sys, 'executable', 'C:/Python/python.exe'), \
             patch.object(sys, 'frozen', False, create=True), patch.object(Path, 'is_file', return_value=True), \
             patch.object(desktop.subprocess, 'DETACHED_PROCESS', 8, create=True), \
             patch.object(desktop.subprocess, 'CREATE_NEW_PROCESS_GROUP', 512, create=True), \
             patch.object(desktop.subprocess, 'Popen') as spawn:
            self.assertTrue(desktop.launch_pythonw(Path('agent/researchtube_agent.py'), ['--port', '17843']))
            command = spawn.call_args.args[0]
            self.assertEqual(command, ['C:/Python/pythonw.exe', 'agent/researchtube_agent.py', '--port', '17843'])
            self.assertEqual(spawn.call_args.kwargs['creationflags'], 520)
            with patch.object(sys, 'executable', 'C:/Python/pythonw.exe'):
                self.assertFalse(desktop.launch_pythonw(Path('agent.py'), []))
            with patch.object(sys, 'frozen', True):
                self.assertFalse(desktop.launch_pythonw(Path('agent.py'), []))
            spawn.assert_called_once()

    def test_mode_and_speech_routing(self):
        with patch.object(sys, 'platform', 'win32'):
            self.assertTrue(agent.parse_args([]).tray)
            self.assertFalse(agent.parse_args(['--console']).tray)
            with patch.object(sys, 'executable', 'C:/Python/pythonw.exe'), \
                 patch.object(sys, 'frozen', False, create=True), \
                 patch.object(Path, 'is_file', return_value=True):
                self.assertEqual(agent.windows_speech_python(), 'C:/Python/python.exe')
        with patch.object(sys, 'platform', 'linux'):
            self.assertFalse(agent.parse_args([]).tray)
        with patch.object(agent, 'run_tray', return_value=0) as tray, \
             patch.object(agent, 'launch_pythonw', return_value=False), \
             patch.object(agent, 'InstanceLock') as lock:
            self.assertEqual(agent.main(['--tray', '--port', '17844']), 0)
            self.assertEqual(tray.call_args.args[1], agent.ROOT)
            lock.assert_called_once_with(17844)
            lock.return_value.close.assert_called_once()

    def test_second_instance_never_starts_tray_or_server(self):
        with patch.object(agent, 'launch_pythonw', return_value=False), \
             patch.object(agent, 'InstanceLock') as lock, patch.object(agent, 'show_error') as message, \
             patch.object(agent, 'run_tray') as tray, patch.object(agent, 'serve') as serve:
            lock.return_value.acquire.return_value = False
            self.assertEqual(agent.main(['--tray']), 0)
            tray.assert_not_called()
            serve.assert_not_called()
            self.assertIn('already running', message.call_args.args[0])
            lock.return_value.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
