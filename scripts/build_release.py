"""Package one tested, platform-specific ResearchTube release archive."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

try:
    from .release_metadata import release_metadata
except ImportError:
    from release_metadata import release_metadata


ROOT = Path(__file__).resolve().parents[1]
SKIP = {'.git', '__pycache__', 'node_modules', '.venv', 'venv'}
PLATFORM_ARCHIVES = {
    'windows-x64': 'ResearchTube-Windows-x64.zip',
    'linux-x64': 'ResearchTube-Linux-x64.zip',
    'macos-arm64': 'ResearchTube-macOS-ARM64.zip',
    'macos-x64': 'ResearchTube-macOS-x64.zip',
}


def release_files(root):
    # Explicit roots exclude legacy nested checkouts and user-created Workspace.
    roots = [root / 'docs', root / 'icons', root / 'extension', root / 'agent/tools', root / 'agent/custom-tools',
             root / 'agent/workspace/demo']
    files = [root / 'README.md', root / 'AGENTS.md', root / 'release.json']
    files += [p for p in (root / 'agent').iterdir() if p.is_file() and (p.suffix in {'.py', '.json', '.txt'} or p.name == 'README.md')]
    for directory in roots:
        if directory.exists():
            files.extend(p for p in directory.rglob('*') if p.is_file())
    for path in sorted(set(files)):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if any(part in SKIP for part in rel.parts) or path.is_symlink() or path.suffix in {'.pyc', '.pyo', '.log', '.zip'}:
            # The bundled IANA database is a runtime ZIP, not a prior release.
            if rel.as_posix() not in {'agent/tools/timezones/zoneinfo.zip', 'agent/tools/yt-dlp/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip'}:
                continue
        if rel.parts[:2] in {('extension', 'tests'), ('extension', 'scripts')}:
            continue
        yield path, rel


def package_release(root, executable, output, platform='windows-x64'):
    if platform not in PLATFORM_ARCHIVES:
        raise ValueError('Unsupported release platform: ' + platform)
    if platform == 'windows-x64':
        if executable is None or executable.read_bytes()[:2] != b'MZ':
            raise ValueError('The Windows release must contain a Windows executable built on Windows.')
    elif executable is not None:
        raise ValueError('Only the Windows release contains a frozen EXE.')
    metadata = release_metadata(root, os.environ.get('GITHUB_SHA'))
    metadata['platform'] = platform
    output.parent.mkdir(parents=True, exist_ok=True)
    # Refuse to overwrite an existing release or any user Workspace files.
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for path, rel in release_files(root):
            name = 'ResearchTube/' + rel.as_posix()
            if rel.as_posix() == 'agent/agent-config.json':
                config = json.loads(path.read_text(encoding='utf-8'))
                config['workspacePath']['value'] = ''
                archive.writestr(name, json.dumps(config, ensure_ascii=False, indent=2) + '\n')
            else:
                archive.write(path, name)
        if executable:
            archive.write(executable, 'ResearchTube/agent/ResearchTubeAgent.exe')
        archive.writestr('ResearchTube/release-info.json', json.dumps(metadata, indent=2) + '\n')
    with zipfile.ZipFile(output) as archive:
        bad = archive.testzip()
        if bad:
            raise ValueError('Archive verification failed: ' + bad)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=PLATFORM_ARCHIVES, required=True)
    parser.add_argument('--exe', type=Path, help='Package an already-built Windows EXE instead of building it.')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    output = args.output or ROOT / 'dist' / PLATFORM_ARCHIVES[args.platform]
    if output.exists():
        parser.error('Output already exists; choose another path.')
    if args.platform != 'windows-x64' and args.exe:
        parser.error('--exe can only be used with --platform windows-x64.')
    if args.exe:
        package_release(ROOT, args.exe.resolve(), output, args.platform)
    elif args.platform == 'windows-x64':
        if sys.platform != 'win32':
            parser.error('Build the Windows EXE on Windows, or provide --exe from a Windows build.')
        with tempfile.TemporaryDirectory(prefix='researchtube-build-') as folder:
            build = Path(folder)
            subprocess.run([sys.executable, '-m', 'PyInstaller', '--clean', '--noconfirm',
                            '--distpath', str(build / 'dist'), '--workpath', str(build / 'work'),
                            str(ROOT / 'agent/ResearchTubeAgent.spec')], check=True)
            package_release(ROOT, build / 'dist/ResearchTubeAgent.exe', output, args.platform)
    else:
        package_release(ROOT, None, output, args.platform)
    print(output)


if __name__ == '__main__':
    main()
