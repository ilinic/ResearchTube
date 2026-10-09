"""Run real source/frozen Agent startup, Workspace, Custom Tools and speech."""
import argparse
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import zipfile


def check_agent(agent_dir, executable=None, windows_speech=False):
    config_path = agent_dir / 'agent-config.json'
    config = json.loads(config_path.read_text(encoding='utf-8'))
    # Test Enter/default in source mode and a different relative root in EXE.
    config['workspacePath']['value'] = ''
    config_path.write_text(json.dumps(config), encoding='utf-8')
    name = 'exe' if executable else 'source'
    workspace = agent_dir / ('selected Workspace' if executable else 'workspace')
    workspace.mkdir(exist_ok=True)
    sentinel = workspace / 'preserve.txt'
    sentinel.write_text('keep', encoding='utf-8')
    command = [str(executable)] if executable else [sys.executable, str(agent_dir / 'researchtube_agent.py')]
    if windows_speech:
        helper = [str(executable), '--windows-speech-helper'] if executable else [sys.executable, str(agent_dir / 'tools/windows-speech/researchtube_speech.py')]
        result = subprocess.run(helper + ['--action', 'list-voices'], capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError('Speech helper failed: ' + result.stderr.decode(errors='replace'))
        assert json.loads(result.stdout)['voices'], 'Windows did not expose any speech voices'
    with tempfile.TemporaryDirectory(prefix='researchtube-cwd-') as cwd:
        for attempt in range(2):
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            with tempfile.TemporaryFile(mode='w+b') as log:
                process = subprocess.Popen(command + ['--port', str(port)], cwd=cwd, stdin=subprocess.PIPE,
                                           stdout=log, stderr=log)
                try:
                    if attempt == 0:
                        process.stdin.write(b'selected Workspace\n' if executable else b'\n')
                        process.stdin.flush()
                    process.stdin.close()

                    def request(path, body=None, timeout=2):
                        payload = json.dumps(body).encode() if body is not None else None
                        try:
                            with urlopen(Request(f'http://127.0.0.1:{port}' + path, data=payload,
                                                 headers={'Content-Type': 'application/json'}), timeout=timeout) as response:
                                return json.load(response)
                        except HTTPError as error:
                            raise RuntimeError(path + ': ' + error.read().decode(errors='replace')) from error

                    deadline = time.monotonic() + 60
                    while True:
                        if process.poll() is not None:
                            log.seek(0)
                            raise RuntimeError('Agent exited: ' + log.read().decode(errors='replace'))
                        try:
                            health = request('/health')
                            break
                        except (URLError, TimeoutError):
                            if time.monotonic() > deadline:
                                raise RuntimeError('Agent startup timed out')
                            time.sleep(0.1)
                    assert health['workspace']['status'] == 'available', health
                    assert str(agent_dir) not in json.dumps(health)
                    assert json.loads(config_path.read_text(encoding='utf-8'))['workspacePath']['value'] == ('selected Workspace' if executable else 'workspace')
                    request('/workspace/mkdir', {'path': 'captures/test'})
                    assert (workspace / 'captures/test').is_dir()
                    assert sentinel.read_text(encoding='utf-8') == 'keep'
                    tools = request('/custom-tools')
                    assert any(t['name'] == 'count_words' for t in tools['tools']), tools
                    result = request('/custom-tools/call', {'name': 'count_words', 'arguments': {'text': 'one two three'}})
                    assert result['result']['wordCount'] == 3, result
                    if windows_speech and attempt == 0:
                        voices = request('/system/speech/voices', {}, timeout=30)['voices']
                        assert voices, 'Windows did not expose any speech voices'
                        task = request('/tasks/system-speech', {'engine': 'windows', 'text': 'ResearchTube test.',
                                       'outputMode': 'file', 'outputPath': f'audio/{name}.wav'}, timeout=30)
                        deadline = time.monotonic() + 60
                        while task['status'] == 'working' and time.monotonic() < deadline:
                            time.sleep(0.2)
                            task = request('/tasks/system-speech/' + task['taskId'])
                        assert task['status'] == 'completed', task
                        assert (workspace / f'audio/{name}.wav').read_bytes()[:4] == b'RIFF'
                    log.seek(0)
                    prompts = log.read().decode(errors='replace').count('Workspace folder [')
                    assert prompts == (1 if attempt == 0 else 0), prompts
                finally:
                    if sys.platform == 'win32':
                        # Kill only this test's process tree, including diagnostics
                        # and a one-file bootloader child that can hold cwd open.
                        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                    else:
                        process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=10)
            print(name + ': prompt/save/restart, unrelated cwd, Workspace preservation, public privacy and external Custom Tools passed', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--zip', type=Path)
    parser.add_argument('--agent-dir', type=Path)
    parser.add_argument('--frozen', type=Path)
    parser.add_argument('--windows-speech', action='store_true')
    args = parser.parse_args()
    if args.zip:
        with tempfile.TemporaryDirectory(prefix='researchtube-smoke-') as folder:
            with zipfile.ZipFile(args.zip) as archive:
                archive.extractall(folder)
            agent = Path(folder) / 'ResearchTube/agent'
            check_agent(agent, windows_speech=args.windows_speech)
            check_agent(agent, agent / 'ResearchTubeAgent.exe', args.windows_speech)
    elif args.agent_dir:
        check_agent(args.agent_dir.resolve(), args.frozen.resolve() if args.frozen else None, args.windows_speech)
    else:
        parser.error('Choose --zip or --agent-dir (a disposable test installation).')


if __name__ == '__main__':
    main()
