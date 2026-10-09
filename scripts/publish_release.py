"""Publish a tested ZIP under its Extension/Agent version pair, once."""
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


def publish(archive, repo, commit, root=ROOT):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Use a repository owner/name and an exact commit SHA.')
    metadata = release_metadata(root, commit)
    # Only consume the archive produced and smoke-tested by this workflow run.
    with zipfile.ZipFile(archive) as content:
        if json.loads(content.read('ResearchTube/release-info.json')) != metadata:
            raise ValueError('ZIP release metadata does not match this source commit.')
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
        checksum = directory / 'ResearchTube.zip.sha256'
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        checksum.write_text(digest + '  ResearchTube.zip\n', encoding='utf-8')
        notes = directory / 'notes.md'
        phase = 'Pre-release for testing.' if metadata['prerelease'] else 'Stable release.'
        download = f'https://github.com/{repo}/releases/download/{tag}/ResearchTube.zip'
        notes.write_text(f"**[Download ResearchTube.zip]({download})**\n\n"
                         f"{phase}\n\nExtension: {metadata['extensionVersion']}\nAgent: {metadata['agentVersion']}\n\n"
                         'Extract the complete archive. '
                         'It includes the Agent (Windows EXE and Python launch mode for Linux/macOS), '
                         'the Chrome Extension, documentation and demo.\n\n'
                         'Windows: open `agent/ResearchTubeAgent.exe`. '
                         'Linux/macOS: run `python3 agent/researchtube_agent.py`. '
                         'If the Workspace setting is empty, press Enter at the folder prompt to accept the default.\n\n'
                         f'Source commit: `{commit}`. SHA-256 is included in `ResearchTube.zip.sha256`.\n', encoding='utf-8')
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
        for asset in (archive, checksum):
            previous = next((item for item in release['assets'] if item['name'] == asset.name), None)
            if previous:
                expected = 'sha256:' + hashlib.sha256(asset.read_bytes()).hexdigest()
                if previous.get('digest') != expected:
                    raise ValueError('An existing draft asset differs: ' + asset.name)
            else:
                gh('release', 'upload', tag, str(asset), '--repo', repo)
        # Publish only after both files have been uploaded. A failed upload
        # leaves a resumable draft; rerun this job with the same build artifact.
        gh('release', 'edit', tag, '--repo', repo, '--draft=false',
           '--prerelease=' + str(metadata['prerelease']).lower(), latest)
    url = f'https://github.com/{repo}/releases/tag/{tag}'
    print('Published: ' + url)
    return url


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--zip', type=Path, required=True)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    if args.zip.name != 'ResearchTube.zip':
        parser.error('The release asset must be named ResearchTube.zip.')
    publish(args.zip, args.repo, args.commit)


if __name__ == '__main__':
    main()
