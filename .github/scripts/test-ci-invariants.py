#!/usr/bin/env python3
"""Exercise artifact trust and complete compiled shard coverage.

Optional argument: directory containing e2e-list.json, perf-list.json, shards/.
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('provenance', ROOT / 'agent-provenance.py')
provenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provenance)
cache_spec = importlib.util.spec_from_file_location('cargo_cache', ROOT / 'cargo-artifact-cache.py')
cargo_cache = importlib.util.module_from_spec(cache_spec)
cache_spec.loader.exec_module(cargo_cache)
INVENTORY = Path(sys.argv.pop()) if len(sys.argv) > 1 else None


class ArtifactTrust(unittest.TestCase):
    # test-category: security
    def test_exact_identity_and_digest_required(self):
        expected = dict(schema=1, sha='a' * 40, platform='linux-x64', version='0.1.0-preview.99',
                        native_mode='static-ort', profile='release', toolchain='1.91.0',
                        debug_assertions='true', overflow_checks='true', rustflags='mold',
                        lto='', codegen_units='')
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'butler-agent').write_text('#!/bin/sh\necho "butler 0.1.0-preview.99 (fixture)"\n')
            provenance.record(directory, expected)
            self.assertTrue(provenance.verify(directory, expected))
            for key in expected:
                self.assertFalse(provenance.verify(directory, dict(expected, **{key: 'different'})), key)
            (directory / 'butler-agent').write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'digest'):
                provenance.verify(directory, expected)
            (directory / 'butler-agent').write_text('#!/bin/sh\necho "butler 0.1.0-dev (fixture)"\n')
            with self.assertRaisesRegex(ValueError, 'embedded version'):
                provenance.record(directory, expected)

    # test-category: security
    def test_failed_incomplete_or_foreign_runs_never_downloaded(self):
        runs = [dict(id=1, status='completed', conclusion='failure', head_repository={'full_name': 'owner/repo'}),
                dict(id=2, status='in_progress', conclusion=None, head_repository={'full_name': 'owner/repo'}),
                dict(id=3, status='completed', conclusion='success', head_repository={'full_name': 'fork/repo'})]
        with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo'), \
             patch.object(provenance, 'output', return_value=json.dumps({'workflow_runs': runs})) as api, \
             patch.object(provenance.subprocess, 'run') as download, contextlib.redirect_stdout(io.StringIO()):
            self.assertFalse(provenance.reuse(Path('/unused'), {'platform': 'linux-x64', 'sha': 'a' * 40}))
            self.assertEqual(api.call_count, 1)
            download.assert_not_called()


class Gate(unittest.TestCase):
    # test-category: pure-logic
    def test_every_selected_job_must_succeed(self):
        jobs = ['source', 'linux-clippy', 'linux-archive', 'linux-tests', 'linux-native', 'linux-perf-archive', 'linux-perf', 'macos-archive', 'macos-tests', 'macos-native', 'macos-perf-archive', 'macos-perf',
                'macos-package', 'linux-arm64-archive', 'linux-arm64-tests', 'linux-package-x64',
                'linux-package-arm64', 'linux-arm64-native', 'linux-arm64-perf-archive', 'linux-arm64-perf', 'install-x64', 'install-arm64', 'install-macos', 'install-merge', 'ui', 'site', 'ds']
        outputs = dict.fromkeys(['rust', 'package', 'install', 'linux-package', 'ui', 'site', 'ds'], 'true')
        results = {job: {'result': 'success'} for job in jobs}
        results['linux-arm64-tests']['result'] = 'skipped'  # Existing non-PR arm64 restriction.
        results['linux-arm64-perf']['result'] = 'skipped'
        results['linux-arm64-perf-archive']['result'] = 'skipped'
        results['changes'] = dict(result='success', outputs=outputs)
        env = dict(os.environ, EVENT='pull_request', RESULTS=json.dumps(results))
        self.assertEqual(subprocess.run([sys.executable, ROOT / 'check-gate.py'], env=env, capture_output=True).returncode, 0)
        for job in jobs:
            if job in ['linux-arm64-tests', 'linux-arm64-perf-archive', 'linux-arm64-perf']:
                continue
            for outcome in ['failure', 'cancelled', 'skipped']:
                changed = json.loads(json.dumps(results))
                changed[job]['result'] = outcome
                env['RESULTS'] = json.dumps(changed)
                self.assertNotEqual(subprocess.run([sys.executable, ROOT / 'check-gate.py'], env=env, capture_output=True).returncode, 0, (job, outcome))


class CargoCache(unittest.TestCase):
    # test-category: security
    def test_snapshot_requires_native_success_identity_and_complete_digest(self):
        run = dict(head_repository=dict(full_name='owner/repo'))
        jobs = [dict(name='macos-archive / Build archives (darwin-arm64)', status='completed', conclusion='success')]
        self.assertTrue(cargo_cache.valid_producer(run, jobs, 'owner/repo', 'darwin-arm64'))
        self.assertFalse(cargo_cache.valid_producer(run, jobs, 'owner/repo', 'linux-x64'))
        self.assertFalse(cargo_cache.valid_producer(run, jobs, 'fork/repo', 'darwin-arm64'))
        for status, conclusion in [('completed', 'failure'), ('completed', 'cancelled'), ('in_progress', '')]:
            self.assertFalse(cargo_cache.valid_producer(run, [dict(jobs[0], status=status, conclusion=conclusion)], 'owner/repo', 'darwin-arm64'))
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            expected = dict(platform='linux-x64', mode='prebuilt-ort', flags={'assertions': 'true'})
            (directory / 'cache.tar.zst').write_bytes(b'complete build inputs')
            metadata = dict(identity=expected, sha256=cargo_cache.digest(directory / 'cache.tar.zst'))
            (directory / 'cache.json').write_text(json.dumps(metadata))
            cargo_cache.verify(directory, expected)
            with self.assertRaisesRegex(ValueError, 'identity'):
                cargo_cache.verify(directory, dict(expected, mode='static-ort'))
            self.assertNotEqual(cargo_cache.artifact_name(expected), cargo_cache.artifact_name(dict(expected, mode='static-ort')))
            (directory / 'cache.tar.zst').write_bytes(b'incomplete')
            with self.assertRaisesRegex(ValueError, 'digest'):
                cargo_cache.verify(directory, expected)

    # test-category: security
    def test_snapshot_restores_full_target_and_rejects_escape_paths(self):
        original = Path.cwd()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            try:
                os.chdir(root)
                for name in ['target/release/complete', '../escaped', 'target/../../escaped']:
                    raw = root / 'cache.tar'
                    with tarfile.open(raw, 'w') as archive:
                        entry = tarfile.TarInfo(name)
                        entry.size = 19
                        archive.addfile(entry, io.BytesIO(b'all compiled inputs'))
                    with (root / 'cache.tar.zst').open('wb') as packed:
                        subprocess.run(['zstd', '-q', '-c', str(raw)], stdout=packed, check=True)
                    if name == 'target/release/complete':
                        cargo_cache.extract(root)
                        self.assertEqual((root / name).read_bytes(), b'all compiled inputs')
                    else:
                        with self.assertRaisesRegex(ValueError, 'path'):
                            cargo_cache.extract(root)
                # Round-trip the producer snapshot, not just the extractor.
                expected = dict(platform='linux-x64', mode='prebuilt-ort', flags={})
                with patch.dict(os.environ, GITHUB_OUTPUT=str(root / 'outputs')), \
                     patch.object(cargo_cache, 'output', return_value='a' * 40):
                    cargo_cache.record(root / 'snapshot', expected)
                cargo_cache.verify(root / 'snapshot', expected)
                (root / 'target/release/complete').unlink()
                cargo_cache.extract(root / 'snapshot')
                self.assertEqual((root / 'target/release/complete').read_bytes(), b'all compiled inputs')
                with tarfile.open(raw, 'w') as archive:
                    entry = tarfile.TarInfo('target/escape')
                    entry.type = tarfile.SYMTYPE
                    entry.linkname = '../../escaped'
                    archive.addfile(entry)
                with (root / 'cache.tar.zst').open('wb') as packed:
                    subprocess.run(['zstd', '-q', '-c', str(raw)], stdout=packed, check=True)
                with self.assertRaises(tarfile.FilterError):
                    cargo_cache.extract(root)
            finally:
                os.chdir(original)


class Coverage(unittest.TestCase):
    # test-category: pure-logic
    def test_compiled_ordinary_install_and_perf_are_complete(self):
        if INVENTORY is None:
            self.fail('Supply the compiled inventory directory; coverage must be proven')
        listing = 'e2e-list.json' if (INVENTORY / 'e2e-list.json').exists() else 'list.json'
        directory = INVENTORY / 'shards' if (INVENTORY / 'shards').exists() else INVENTORY
        inventory = json.loads((INVENTORY / listing).read_text())
        tests = {name: test for suite in inventory['rust-suites'].values()
                 if suite['binary-name'] == 'e2e' for name, test in suite['testcases'].items()}
        selections = json.loads((directory / 'selection.json').read_text())
        ordinary = [name for shard in selections for binary, name in shard]
        expected = {name for name in tests if not any(part.startswith(('ins_', 'perf_')) for part in name.split('::'))
                    and not name.endswith('idle_disk_writes_and_cpu_stay_bounded')}
        self.assertEqual(len(ordinary), len(set(ordinary)))
        self.assertEqual(set(ordinary), expected)
        installs = {name for name in tests if any(part.startswith('ins_') for part in name.split('::'))}
        groups = [{name for name in installs if '::ins_02_' in name},
                  {name for name in installs if '::ins_14_' in name},
                  {name for name in installs if '::ins_02_' not in name and '::ins_14_' not in name}]
        self.assertEqual(sum(map(len, groups)), len(installs))
        perf_inventory = json.loads((INVENTORY / 'perf-list.json').read_text())
        perf = {name for suite in perf_inventory['rust-suites'].values() for name, test in suite['testcases'].items()
                if test['filter-match']['status'] == 'matches'}
        perf_selections = json.loads((directory / 'perf-selection.json').read_text())
        selected = [name for shard in perf_selections for binary, name in shard]
        idle = {name for name in perf if name.startswith('idle_resources::')}
        self.assertEqual(len(selected), len(set(selected)))
        self.assertEqual(set(selected) | idle, perf)
        self.assertTrue(idle, 'The complete idle observation must remain selected')
        runnable = {name for name, test in tests.items() if not test['ignored']}
        disk = {name for name in tests if name.endswith('idle_disk_writes_and_cpu_stay_bounded')}
        self.assertEqual((set(ordinary) | installs | perf | disk) & runnable, runnable)
        print(f'Compiled inventory: {len(tests)} tests, {len(tests) - len(runnable)} existing ignored; '
              f'ordinary {list(map(len, selections))}, install {list(map(len, groups))}, '
              f'perf {list(map(len, perf_selections))} + {len(idle)} full idle observation(s).')


if __name__ == '__main__':
    unittest.main()
