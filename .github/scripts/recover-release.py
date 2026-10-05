#!/usr/bin/env python3
"""Recover final release publication; never build or sign platform payloads."""
import json
import os
from pathlib import Path
import re
import shutil
import hashlib
import subprocess
import sys
from urllib.parse import quote


def run(*args):
    return subprocess.check_output(args, text=True)


def required(tag):
    names = ['agent-darwin-arm64', 'agent-linux-x64', 'agent-linux-arm64',
             'app-darwin-arm64', 'butler-app-linux-x64', 'butler-app-linux-arm64']
    if '-preview.' in tag:
        names += ['agent-windows-x64', 'app-windows-x64']
    return names


def prepare():
    repo = os.environ['GH_REPO']
    run_id = os.environ['REUSE_RUN_ID']
    if not run_id.isdecimal():
        raise ValueError('reuse_run_id must be a numeric workflow run ID')
    source = json.loads(run('gh', 'api', f'repos/{repo}/actions/runs/{run_id}'))
    tag = source['head_branch']
    if (source['path'] != '.github/workflows/release.yml'
            or source['event'] not in ('push', 'workflow_dispatch')
            or source['status'] != 'completed'
            or not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', tag or '')):
        raise ValueError('Expected a completed release.yml run for a version tag')
    if os.environ.get('RECOVERY_TAG') not in ('', None, tag):
        raise ValueError(f'Reused run tag {tag} differs from explicit tag')
    ref = os.environ.get('RECOVERY_REF', '')
    if ref.startswith('refs/tags/') and ref != f'refs/tags/{tag}':
        raise ValueError('Selected workflow tag differs from reused run tag')
    commit = json.loads(run('gh', 'api', f'repos/{repo}/commits/{quote(tag, safe="")}'))
    if source['head_sha'] != commit['sha']:
        raise ValueError(f'Reused run commit differs from current tag {tag}')
    pages = json.loads(run('gh', 'api', '--paginate', '--slurp',
                          f'repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100'))
    available = {item['name'] for page in pages for item in page['artifacts'] if not item['expired']}
    missing = set(required(tag)) - available
    if missing:
        raise ValueError('Missing required artifacts: ' + ', '.join(sorted(missing)))
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(f'tag={tag}\nsha={commit["sha"]}\npattern={{{",".join(required(tag))}}}\n')


def validate_files(root, tag):
    version = tag[1:]
    expected = {}
    for platform in ('darwin-arm64', 'linux-x64', 'linux-arm64', 'windows-x64'):
        if f'agent-{platform}' not in required(tag):
            continue
        extension = 'zip' if platform == 'windows-x64' else 'tar.gz'
        expected[f'agent-{platform}'] = [f'butler-agent-{version}-{platform}.{extension}',
                                        'agent-release-manifest.json', 'agent-update-manifest.json']
        if platform == 'windows-x64':
            expected[f'agent-{platform}'].append(f'butler-agent-{version}-{platform}.zip.sha256')
    expected['app-darwin-arm64'] = ['app-release-manifest.json', 'app-update-manifest.json']
    expected['app-darwin-arm64'] += [f'butler-app-{version}-darwin-arm64.{ext}{suffix}'
                                     for ext in ('dmg', 'zip') for suffix in ('', '.sha256')]
    for platform in ('linux-x64', 'linux-arm64'):
        extensions = ('deb', 'pkg.tar.zst') if platform == 'linux-x64' else ('deb',)
        expected[f'butler-app-{platform}'] = [f'butler-app-{version}-{"archlinux-x64" if ext == "pkg.tar.zst" else platform}.{ext}{suffix}'
                                             for ext in extensions for suffix in ('', '.sha256')]
    if 'app-windows-x64' in required(tag):
        expected['app-windows-x64'] = ['app-update-manifest.json', 'RELEASES',
                                      f'ButlerSetup-{version}-x64.exe']
        if not list((root / 'app-windows-x64').glob('*-full.nupkg')):
            expected['app-windows-x64'].append('*-full.nupkg')
    if 'app-windows-x64' in expected:
        expected['app-windows-x64'] += [file.name + '.sha256'
            for file in (root / 'app-windows-x64').iterdir()
            if file.name == 'RELEASES' or file.suffix in ('.exe', '.nupkg', '.zip')]
    missing = [f'{name}/{file}' for name, files in expected.items()
               for file in files if not (root / name / file).is_file()]
    if missing:
        raise ValueError('Missing required artifact files: ' + ', '.join(missing))
    for name in required(tag):
        if name.startswith('agent-'):
            validate_agent(root / name, name.removeprefix('agent-'), tag)
        for checksum in (root / name).glob('*.sha256'):
            payload = checksum.with_suffix('')
            with payload.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            if checksum.read_text().split()[0] != digest:
                raise ValueError(f'Artifact checksum mismatch: {name}/{payload.name}')


def validate_agent(directory, platform, tag):
    for filename in ('agent-release-manifest.json', 'agent-update-manifest.json'):
        manifest = json.loads((directory / filename).read_text())
        if manifest.get('version', manifest.get('agent_version')) != tag[1:]:
            raise ValueError(f'{directory.name}/{filename}: version differs from tag')
        artifacts = manifest.get('artifacts', [])
        if len(artifacts) != 1 or artifacts[0]['platform'] != platform:
            raise ValueError(f'{directory.name}/{filename}: expected exactly {platform}')
        item = artifacts[0]
        url = item['artifact_url']
        base = f'https://github.com/{os.environ["GH_REPO"]}/releases/download/{tag}/'
        if not url.startswith(base) or '/' in url[len(base):]:
            raise ValueError(f'{directory.name}/{filename}: artifact URL differs from tag')
        with (directory / url[len(base):]).open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if item['sha256'] != digest:
            raise ValueError(f'{directory.name}/{filename}: artifact digest mismatch')


def publish(root):
    tag = os.environ['GITHUB_REF_NAME']
    validate_files(root, tag)
    merged = root / 'merged'
    run('python3', 'packages/butler-agent/rust/scripts/release-standalone-agent.py',
        'merge', '--output', str(merged),
        *(str(root / name) for name in required(tag) if name.startswith('agent-')))
    npm = root / 'npm'
    run('python3', 'deploy/npm/pack-release.py', tag, str(npm))
    app_manifest = root / 'app-update-manifest.json'
    linux = root / 'linux'
    linux.mkdir(exist_ok=True)
    for name in required(tag):
        if name.startswith('butler-app-linux-'):
            for file in (root / name).iterdir():
                shutil.copyfile(file, linux / file.name)
    args = ['python3', 'deploy/app/merge-update-manifest.py', '--mac-manifest',
            str(root / 'app-darwin-arm64/app-update-manifest.json'), '--linux-dir', str(linux),
            '--version', tag[1:], '--base-url',
            f'https://github.com/{os.environ["GH_REPO"]}/releases/download/{tag}',
            '--output', str(app_manifest)]
    if 'app-windows-x64' in required(tag):
        args += ['--windows-dir', str(root / 'app-windows-x64')]
    run(*args)
    files = [Path('deploy/install.sh'), Path('deploy/install.ps1'), app_manifest]
    for name in required(tag):
        files += [file for file in (root / name).iterdir()
                  if file.is_file() and file.name not in ('agent-release-manifest.json',
                                                         'agent-update-manifest.json', 'app-update-manifest.json')]
    files += list(merged.iterdir()) + list(npm.iterdir())
    try:
        run('gh', 'release', 'view', tag)
    except subprocess.CalledProcessError:
        run('gh', 'release', 'create', tag, '--verify-tag', '--draft', '--title', tag,
            '--notes', f'Butler release {tag}')
    run('gh', 'release', 'upload', tag, *(str(file) for file in files), '--clobber')
    run('python3', '.github/scripts/publish-release-checksums.py', tag)
    run('gh', 'release', 'edit', tag, '--draft=false',
        f'--prerelease={str("-" in tag).lower()}')


if __name__ == '__main__':
    if sys.argv[1] == 'prepare':
        prepare()
    elif sys.argv[1] == 'publish':
        publish(Path(sys.argv[2]))
    else:
        raise SystemExit('Expected prepare or publish mode')
