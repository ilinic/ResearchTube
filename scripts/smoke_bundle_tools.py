"""Run every bundled third-party executable and validate its platform manifest."""
import argparse
import json
from pathlib import Path
import subprocess

PLATFORMS = ('windows-x64', 'linux-x64', 'macos-arm64', 'macos-x64')
TOOLS = {
    'yt-dlp': ('yt-dlp', ('--version',)),
    'deno': ('deno', ('--version',)),
    'ffmpeg': ('ffmpeg', ('-version',)),
    'ffprobe': ('ffmpeg', ('-version',)),
    'cloudflared': ('cloudflared', ('--version',)),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=PLATFORMS, required=True)
    parser.add_argument('--tools-root', type=Path, default=Path(__file__).resolve().parents[1] / 'agent/tools')
    args = parser.parse_args()
    manifest = json.loads((args.tools_root / 'tools-manifest.json').read_text(encoding='utf-8'))
    expected_manifest_tools = set(TOOLS) - {'ffprobe'}
    if manifest.get('platform') != args.platform or set(manifest.get('tools', {})) != expected_manifest_tools:
        raise ValueError('Tool manifest is incomplete or targets another platform.')
    suffix = '.exe' if args.platform.startswith('windows-') else ''
    for key, (directory, arguments) in TOOLS.items():
        matches = [path for path in (args.tools_root / directory).rglob('*')
                   if path.is_file() and path.name.lower() == (key + suffix).lower()]
        if len(matches) != 1:
            raise RuntimeError(f'Expected one bundled {key}, found {len(matches)}.')
        result = subprocess.run([str(matches[0]), *arguments], capture_output=True, text=True, timeout=45)
        if result.returncode:
            raise RuntimeError(f'{key} --version failed: {result.stderr[-1000:]}')
        version_key = 'ffmpeg' if key == 'ffprobe' else key
        print(f"{key} {manifest['tools'][version_key]['version']}: OK")


if __name__ == '__main__':
    main()
