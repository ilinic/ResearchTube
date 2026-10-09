"""Download checksum-pinned runtime tools into one platform release tree."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tarfile
import tempfile
from urllib.request import Request, urlopen
import zipfile


ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'scripts/tool-bundles.json'
PLATFORMS = ('windows-x64', 'linux-x64', 'macos-arm64', 'macos-x64')


def download(entry, destination):
    digest = hashlib.sha256()
    request = Request(entry['url'], headers={'User-Agent': 'ResearchTube release builder'})
    with urlopen(request, timeout=180) as response, destination.open('wb') as output:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
            output.write(chunk)
    if digest.hexdigest() != entry['sha256']:
        destination.unlink(missing_ok=True)
        raise ValueError('SHA-256 mismatch for ' + entry['url'])


def safe_member(name):
    path = PurePosixPath(name.replace('\\', '/'))
    return not path.is_absolute() and '..' not in path.parts


def extract_archive(archive, destination, kind):
    destination.mkdir(parents=True, exist_ok=True)
    if kind == 'zip':
        with zipfile.ZipFile(archive) as source:
            for member in source.infolist():
                if not safe_member(member.filename):
                    raise ValueError('Unsafe ZIP entry: ' + member.filename)
                if member.is_dir():
                    continue
                target = destination.joinpath(*PurePosixPath(member.filename).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(member) as stream, target.open('wb') as output:
                    shutil.copyfileobj(stream, output)
                mode = (member.external_attr >> 16) & 0o777
                target.chmod(mode or 0o644)
    else:
        mode = 'r:xz' if kind == 'tar.xz' else 'r:gz'
        with tarfile.open(archive, mode) as source:
            for member in source.getmembers():
                if not safe_member(member.name):
                    raise ValueError('Unsafe TAR entry: ' + member.name)
                if member.isdir():
                    continue
                if member.issym() or member.islnk():
                    link = PurePosixPath(member.linkname)
                    resolved = PurePosixPath(member.name).parent.joinpath(link)
                    stack = []
                    for part in resolved.parts:
                        if part == '..':
                            if not stack:
                                raise ValueError('Unsafe TAR link: ' + member.name)
                            stack.pop()
                        elif part not in ('', '.'):
                            stack.append(part)
                    continue
                if not member.isfile():
                    continue
                target = destination.joinpath(*PurePosixPath(member.name).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                stream = source.extractfile(member)
                if stream is None:
                    continue
                with stream, target.open('wb') as output:
                    shutil.copyfileobj(stream, output)
                target.chmod(member.mode & 0o777)
            # Materialize only safe relative symlinks, after regular files exist.
            for member in source.getmembers():
                if not (member.issym() or member.islnk()):
                    continue
                link = PurePosixPath(member.linkname)
                target_name = PurePosixPath(member.name).parent.joinpath(link)
                stack = []
                for part in target_name.parts:
                    if part == '..':
                        if not stack:
                            raise ValueError('Unsafe TAR link: ' + member.name)
                        stack.pop()
                    elif part not in ('', '.'):
                        stack.append(part)
                source_path = destination.joinpath(*stack)
                output_path = destination.joinpath(*PurePosixPath(member.name).parts)
                if source_path.is_file():
                    output_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source_path, output_path)


def verify_executables(source, expected):
    matches = [path for path in source.rglob('*') if path.is_file() and path.name.lower() in expected]
    for name in expected:
        candidates = [path for path in matches if path.name.lower() == name]
        if len(candidates) != 1:
            raise RuntimeError(f'Expected exactly one {name}, found {len(candidates)} in {source}.')
    for path in matches:
        if path.name.lower() in expected and os.name != 'nt':
            path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def materialize_links(destination):
    """Turn safe in-tree symlinks into regular files for portable ZIP packaging."""
    links = [path for path in destination.rglob('*') if path.is_symlink()]
    for _ in range(len(links) + 1):
        pending = []
        for link in links:
            if not link.is_symlink():
                continue
            resolved = link.resolve(strict=False)
            if destination.resolve() not in resolved.parents:
                raise ValueError('Archive symlink escapes tool directory: ' + str(link))
            if resolved.is_file():
                mode = link.stat().st_mode
                data = resolved.read_bytes()
                link.unlink()
                link.write_bytes(data)
                link.chmod(mode & 0o777)
            else:
                pending.append(link)
        links = pending
        if not links:
            return
    if links:
        raise ValueError('Could not resolve packaged tool symlink: ' + str(links[0]))


def bundle(platform, tools_root):
    locks = json.loads(LOCK.read_text(encoding='utf-8'))
    if platform not in locks:
        raise ValueError('Unsupported release platform: ' + platform)
    is_windows = platform.startswith('windows-')
    is_macos = platform.startswith('macos-')
    suffix = '.exe' if is_windows else ''
    manifest = {'platform': platform, 'tools': {}}
    tools_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='researchtube-tools-') as folder:
        work = Path(folder)
        for name, entry in locks[platform].items():
            archive_kind = entry.get('archive')
            download_path = work / (name + ('.archive' if archive_kind else suffix))
            download(entry, download_path)
            if name == 'ffmpeg':
                target = tools_root / 'ffmpeg'
                if archive_kind:
                    extract_archive(download_path, target, archive_kind)
                verify_executables(target, {'ffmpeg' + suffix, 'ffprobe' + suffix})
                materialize_links(target)
            elif name in ('deno', 'cloudflared'):
                target = tools_root / name
                if archive_kind:
                    extract_archive(download_path, work / (name + '-unpacked'), archive_kind)
                    source = work / (name + '-unpacked')
                    executable = name + suffix
                    verify_executables(source, {executable.lower()})
                    target.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(next(path for path in source.rglob('*') if path.is_file() and path.name.lower() == executable.lower()), target / executable)
                    if os.name != 'nt':
                        (target / executable).chmod((target / executable).stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
                else:
                    target.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(download_path, target / (name + suffix))
                    if os.name != 'nt':
                        (target / (name + suffix)).chmod((target / (name + suffix)).stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            else:
                target = tools_root / 'yt-dlp'
                target.mkdir(parents=True, exist_ok=True)
                shutil.copy2(download_path, target / ('yt-dlp' + suffix))
                if os.name != 'nt':
                    (target / ('yt-dlp' + suffix)).chmod((target / ('yt-dlp' + suffix)).stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            manifest['tools'][name] = {
                'version': entry['version'],
                'sha256': entry['sha256'],
                'url': entry['url'],
                **({'license': entry['license'], 'source': entry['source']} if name == 'ffmpeg' else {}),
            }
    manifest_path = tools_root / 'tools-manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    write_notices(tools_root, manifest)
    return manifest


def write_notices(tools_root, manifest):
    lines = [
        'ResearchTube bundled third-party tools',
        '',
        'The following standalone tools are included in this platform archive. Their upstream',
        'licenses remain in effect; see the upstream pages below for license texts and source.',
        '',
    ]
    for name, item in manifest['tools'].items():
        lines.extend((f"{name} {item['version']}", f"  {item['url']}"))
        if item.get('license'):
            lines.extend((f"  Binary license: {item['license']}", f"  Source/build project: {item['source']}"))
        lines.append(f"  SHA-256: {item['sha256']}")
    lines.extend((
        '',
        'The FFmpeg binary uses GPL-licensed components, including the software H.264 encoder.',
        'FFmpeg is a separate executable invoked by ResearchTube. Its source and build materials',
        'are available at the FFmpeg and platform build project links above.',
        '',
        'Cloudflare Tunnel is the cloudflared program; its source and license are at:',
        'https://github.com/cloudflare/cloudflared',
        'yt-dlp source and license: https://github.com/yt-dlp/yt-dlp',
        'Deno source and license: https://github.com/denoland/deno',
    ))
    (tools_root / 'THIRD-PARTY-NOTICES.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=PLATFORMS, required=True)
    parser.add_argument('--tools-root', type=Path, default=ROOT / 'agent/tools')
    args = parser.parse_args()
    manifest = bundle(args.platform, args.tools_root)
    print(json.dumps({'platform': args.platform, 'tools': list(manifest['tools'])}))


if __name__ == '__main__':
    main()
