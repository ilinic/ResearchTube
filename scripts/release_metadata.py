"""A release is identified by the existing Extension and Agent versions."""
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]


def release_metadata(root=ROOT, commit=None):
    extension = json.loads((root / 'extension/manifest.json').read_text(encoding='utf-8'))['version']
    source = (root / 'agent/researchtube_agent.py').read_text(encoding='utf-8')
    match = re.search(r'^AGENT_VERSION = "(\d+\.\d+\.\d+)"$', source, re.MULTILINE)
    if not isinstance(extension, str) or not re.fullmatch(r'\d+\.\d+\.\d+', extension) or not match:
        raise ValueError('Cannot read the Extension and Agent implementation versions.')
    agent = match.group(1)
    prerelease = json.loads((root / 'release.json').read_text(encoding='utf-8'))['prerelease']
    if not isinstance(prerelease, bool):
        raise ValueError('release.json prerelease must be true or false.')
    result = {'extensionVersion': extension, 'agentVersion': agent,
              'tag': f'ext-{extension}_agent-{agent}', 'prerelease': prerelease}
    if commit is not None:
        result['commit'] = commit
    return result
