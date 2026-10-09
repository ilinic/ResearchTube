"""Publish tested platform archives under their Extension/Agent version pair, once."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile

try:
    from .release_metadata import ROOT, release_metadata
except ImportError:
    from release_metadata import ROOT, release_metadata

PLATFORMS = {
    'windows-x64': 'ResearchTube-Windows-x64.zip',
    'linux-x64': 'ResearchTube-Linux-x64.zip',
    'macos-arm64': 'ResearchTube-macOS-ARM64.zip',
    'macos-x64': 'ResearchTube-macOS-x64.zip',
}


def gh(*args):
    result = subprocess.run(['gh', *args], capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or 'GitHub CLI failed.')
    return result.stdout


def find_release(repo, tag):
    result = subprocess.run(['gh', 'api', f'repos/{repo}/releases/tags/{tag}'],
                            capture_output=True, text=True, timeout=60)
    if result.returncode:
        if 'HTTP 404' in result.stderr:
            # Draft releases do not resolve through the by-tag endpoint.
            pages = json.loads(gh('api', f'repos/{repo}/releases?per_page=100', '--paginate', '--slurp'))
            return next((release for page in pages for release in page if release['tag_name'] == tag), None)
        raise RuntimeError(result.stderr.strip() or 'Could not read GitHub Releases.')
    return json.loads(result.stdout)


def publish(archives, repo, commit, root=ROOT):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Use a repository owner/name and an exact commit SHA.')
    metadata = release_metadata(root, commit)
    if isinstance(archives, (str, Path)):
        archives = [Path(archives)]
    archives = [Path(path) for path in archives]
    if {path.name for path in archives} != set(PLATFORMS.values()) or len(archives) != len(PLATFORMS):
        raise ValueError('Provide exactly one archive for Windows x64, Linux x64 and both macOS architectures.')
    archive_by_platform = {platform: next(path for path in archives if path.name == filename)
                           for platform, filename in PLATFORMS.items()}
    # Only consume archives produced and smoke-tested by this exact workflow run.
    for platform, archive in archive_by_platform.items():
        expected = {**metadata, 'platform': platform}
        with zipfile.ZipFile(archive) as content:
            if json.loads(content.read('ResearchTube/release-info.json')) != expected:
                raise ValueError(f'{archive.name} metadata does not match this source commit and platform.')
    tag = metadata['tag']
    release = find_release(repo, tag)
    if release is not None and not release['draft']:
        # Published version pairs remain historical records; never replace them.
        print('Already published: ' + release['html_url'])
        return release['html_url']
    retarget = release is not None and release['target_commitish'] != commit
    if retarget and release['assets']:
        raise ValueError('An existing draft for this version pair targets another commit.')

    with tempfile.TemporaryDirectory(prefix='researchtube-release-') as folder:
        directory = Path(folder)
        checksums = []
        for archive in archives:
            checksum = directory / (archive.name + '.sha256')
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            checksum.write_text(digest + '  ' + archive.name + '\n', encoding='utf-8')
            checksums.append(checksum)
        notes = directory / 'notes.md'
        phase = 'Pre-release for testing.' if metadata['prerelease'] else 'Stable release.'
        asset_lines = []
        for platform, filename in PLATFORMS.items():
            url = f'https://github.com/{repo}/releases/download/{tag}/{filename}'
            asset_lines.append(f'- **{platform}**: [Download {filename}]({url}) · `{filename}.sha256`')
        notes.write_text(f"{phase}\n\nExtension: {metadata['extensionVersion']}\nAgent: {metadata['agentVersion']}\n\n"
                         'Choose the archive for your operating system and processor. Every archive includes '
                         'the Agent, Chrome Extension, documentation, demo, FFmpeg/ffprobe, yt-dlp, Deno and cloudflared.\n\n'
                         + '\n'.join(asset_lines) + '\n\n'
                         'Windows: open `agent/ResearchTubeAgent.exe`. Linux/macOS: run '
                         '`python3 agent/researchtube_agent.py`. If Workspace is not configured, press Enter '
                         'to accept the suggested folder.\n\n'
                         f'Source commit: `{commit}`. Each archive has a matching SHA-256 file.\n', encoding='utf-8')
        latest = '--latest=false' if metadata['prerelease'] else '--latest=true'
        title = f"ResearchTube — Extension {metadata['extensionVersion']} / Agent {metadata['agentVersion']}"
        if release is None:
            args = ['release', 'create', tag, '--repo', repo, '--target', commit,
                    '--title', title, '--notes-file', str(notes), '--draft', latest]
            if metadata['prerelease']:
                args.append('--prerelease')
            gh(*args)
            # Creation succeeded with no assets. The release collection can
            # briefly lag behind creation; do not depend on an immediate read.
            release = {'assets': []}
        elif retarget:
            # An empty unpublished draft can follow a corrected build. Never
            # retarget a draft that already contains another build's assets.
            gh('release', 'edit', tag, '--repo', repo, '--target', commit,
               '--title', title, '--notes-file', str(notes))
        for asset in (*archives, *checksums):
            previous = next((item for item in release['assets'] if item['name'] == asset.name), None)
            if previous:
                expected = 'sha256:' + hashlib.sha256(asset.read_bytes()).hexdigest()
                if previous.get('digest') != expected:
                    raise ValueError('An existing draft asset differs: ' + asset.name)
            else:
                gh('release', 'upload', tag, str(asset), '--repo', repo)
        # Publish only after all eight files have been uploaded.
        gh('release', 'edit', tag, '--repo', repo, '--draft=false',
           '--prerelease=' + str(metadata['prerelease']).lower(), latest)
    url = f'https://github.com/{repo}/releases/tag/{tag}'
    print('Published: ' + url)
    return url


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--zip', type=Path, action='append', required=True)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    publish(args.zip, args.repo, args.commit)


if __name__ == '__main__':
    main()
