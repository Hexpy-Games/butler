#!/usr/bin/env python3
"""Pure-logic recovery checks plus local publication with mocked remote writes."""
import hashlib
import importlib.util
import json
import os
import runpy
import shutil
import sys
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).with_name('recover-release.py'))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)
TAG = 'v0.1.0-preview.9'
REPO = 'Hexpy-Games/butler'


def fixtures(root):
    for name in recovery.required(TAG):
        directory = root / name
        directory.mkdir()
        version = TAG[1:]
        if name.startswith('agent-'):
            platform = name.removeprefix('agent-')
            extension = 'zip' if platform == 'windows-x64' else 'tar.gz'
            filename = f'butler-agent-{version}-{platform}.{extension}'
            (directory / filename).write_bytes(b'dummy agent')
            if platform == 'windows-x64':
                (directory / (filename + '.sha256')).write_text(
                    hashlib.sha256(b'dummy agent').hexdigest() + '  ' + filename + '\n')
            item = {'platform': platform, 'artifact_url':
                    f'https://github.com/{REPO}/releases/download/{TAG}/{filename}',
                    'sha256': hashlib.sha256(b'dummy agent').hexdigest()}
            for filename, schema in [('agent-release-manifest.json', 'butler.agent-release-manifest.v1'),
                                     ('agent-update-manifest.json', 'butler.update-manifest.v1')]:
                (directory / filename).write_text(json.dumps({
                    'schema': schema, 'version': version, 'artifacts': [item]}))
        else:
            if name == 'app-darwin-arm64':
                filenames = [f'butler-app-{version}-darwin-arm64.{ext}' for ext in ('dmg', 'zip')]
                (directory / 'app-release-manifest.json').write_text('{}')
                platforms = ['darwin-arm64']
            elif name == 'app-windows-x64':
                filenames = ['RELEASES', f'ButlerSetup-{version}-x64.exe', f'butler-{version}-full.nupkg']
                platforms = ['windows-x64']
            else:
                platform = name.removeprefix('butler-app-')
                filenames = [f'butler-app-{version}-{platform}.deb']
                if platform == 'linux-x64':
                    filenames.append(f'butler-app-{version}-archlinux-x64.pkg.tar.zst')
                platforms = []
            for filename in filenames:
                (directory / filename).write_bytes(b'dummy app')
                (directory / (filename + '.sha256')).write_text(
                    hashlib.sha256(b'dummy app').hexdigest() + '  ' + filename + '\n')
            if platforms:
                (directory / 'app-update-manifest.json').write_text(json.dumps({
                    'app_version': version, 'artifacts': [{'platform': platform,
                    'artifact_url': f'https://github.com/{REPO}/releases/download/{TAG}/{filenames[-1]}',
                    'sha256': hashlib.sha256(b'dummy app').hexdigest()} for platform in platforms]}))


def checksum_dry_run(assets):
    def gh_api(args):
        return json.dumps([{'tag_name': TAG, 'assets': [
            {'name': name, 'size': path.stat().st_size, 'digest':
             'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()}
            for name, path in assets.items()]}]).encode()
    def gh_write(args, **kwargs):
        if args[2] == 'download':
            destination = Path(args[args.index('--dir') + 1])
            for name, path in assets.items():
                shutil.copyfile(path, destination / name)
        elif args[2] == 'upload':
            checksum = Path(args[-2])
            lines = checksum.read_text().splitlines()
            assert len(lines) == len(assets)
            assert {line.split('  ')[1] for line in lines} == set(assets)
            assert args[-1] == '--clobber'
        return subprocess.CompletedProcess(args, 0)
    with patch.object(sys, 'argv', ['checksums', TAG]), \
            patch('subprocess.check_output', gh_api), patch('subprocess.run', gh_write):
        runpy.run_path('.github/scripts/publish-release-checksums.py', run_name='__main__')


class RecoveryTests(unittest.TestCase):
    # test-category: security
    def test_prepare_rejects_mismatches_and_names_missing_artifacts(self):
        source = dict(path='.github/workflows/release.yml', event='push', status='completed',
                      head_branch=TAG, head_sha='abc')
        artifacts = [{'name': name, 'expired': False} for name in recovery.required(TAG)]
        def api(*args):
            if 'commits/' in args[-1]:
                return json.dumps({'sha': 'abc'})
            if '/artifacts?' in args[-1]:
                return json.dumps([{'artifacts': artifacts}])
            return json.dumps(source)
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                'GH_REPO': REPO, 'REUSE_RUN_ID': '123', 'RECOVERY_TAG': '',
                'GITHUB_OUTPUT': str(Path(temp) / 'outputs')}), patch.object(recovery, 'run', api):
            recovery.prepare()
            self.assertIn('sha=abc', (Path(temp) / 'outputs').read_text())
            with patch.dict(os.environ, RECOVERY_TAG='v9.9.9'):
                with self.assertRaisesRegex(ValueError, 'differs from explicit tag'):
                    recovery.prepare()
            source['head_sha'] = 'different'
            with self.assertRaisesRegex(ValueError, 'commit differs'):
                recovery.prepare()
            source['head_sha'] = 'abc'
            artifacts[-1]['expired'] = True
            with self.assertRaisesRegex(ValueError, 'Missing required artifacts: app-windows-x64'):
                recovery.prepare()
            source['path'] = '.github/workflows/ci.yml'
            with self.assertRaisesRegex(ValueError, 'Expected a completed release.yml'):
                recovery.prepare()

    # test-category: security
    def test_missing_files_and_corruption_refuse_before_remote_writes(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, GH_REPO=REPO):
            root = Path(temp)
            fixtures(root)
            recovery.validate_files(root, TAG)
            missing = root / 'app-darwin-arm64/app-release-manifest.json'
            missing.unlink()
            with self.assertRaisesRegex(ValueError, 'app-darwin-arm64/app-release-manifest.json'):
                recovery.validate_files(root, TAG)
            missing.write_text('{}')
            archive = next((root / 'agent-linux-x64').glob('*.tar.gz'))
            archive.write_bytes(b'corruption')
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                recovery.validate_files(root, TAG)

    # test-category: pure-logic
    def test_publication_twice_merges_all_platforms_and_clobbers(self):
        original = recovery.run
        calls = []
        assets = {}
        def dry_run(*args):
            if args[0] == 'gh':
                calls.append(args)
                if args[:3] == ('gh', 'release', 'upload'):
                    assets.update({Path(file).name: Path(file) for file in args[4:-1]})
                return ''
            if args[1] == '.github/scripts/publish-release-checksums.py':
                checksum_dry_run(assets)
                return ''
            return original(*args)
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
                'GH_REPO': REPO, 'GITHUB_REF_NAME': TAG}), patch.object(recovery, 'run', dry_run):
            root = Path(temp)
            fixtures(root)
            for _ in range(2):
                recovery.publish(root)
            manifest = json.loads((root / 'app-update-manifest.json').read_text())
            self.assertEqual({a['platform'] for a in manifest['artifacts']},
                             {'darwin-arm64', 'linux-x64', 'linux-arm64', 'windows-x64'})
            agent = json.loads((root / 'merged/agent-update-manifest.json').read_text())
            self.assertEqual(len(agent['artifacts']), 4)
            uploads = [args for args in calls if args[:3] == ('gh', 'release', 'upload')]
            self.assertEqual(len(uploads), 2)
            self.assertTrue(all(args[-1] == '--clobber' for args in uploads))
            self.assertFalse(any(args[:3] == ('gh', 'release', 'create') for args in calls))
            self.assertEqual(len(list((root / 'npm').glob('*.tgz'))), 1)


if __name__ == '__main__':
    unittest.main()
