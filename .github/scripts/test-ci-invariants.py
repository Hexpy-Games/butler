#!/usr/bin/env python3
"""Exercise artifact trust and complete compiled shard coverage.

Optional argument: directory containing e2e-list.json, perf-list.json, shards/.
"""
import contextlib
import importlib.util
import io
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('provenance', ROOT / 'agent-provenance.py')
provenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provenance)
cache_spec = importlib.util.spec_from_file_location('cargo_cache', ROOT / 'cargo-artifact-cache.py')
cargo_cache = importlib.util.module_from_spec(cache_spec)
cache_spec.loader.exec_module(cargo_cache)
WINDOWS_ONLY = '--windows-safety' in sys.argv
if WINDOWS_ONLY:
    sys.argv.remove('--windows-safety')
INVENTORY = Path(sys.argv.pop()) if len(sys.argv) > 1 else None
spec = importlib.util.spec_from_file_location('windows_tests', ROOT / 'test-windows-ci-safety.py')
windows_tests = importlib.util.module_from_spec(spec)
spec.loader.exec_module(windows_tests)
WindowsSafety = windows_tests.WindowsSafety


class ArchivedLibtest(unittest.TestCase):
    # test-category: pure-logic
    def test_prepare_creates_destination_and_preserves_original_libtest_invocation(self):
        spec = importlib.util.spec_from_file_location('archived_libtest', ROOT / 'run-archive-libtest.py')
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'missing' / 'extract'
            suite = {'binary-name': 'e2e', 'binary-path': str(directory / 'e2e'), 'cwd': temporary,
                     'testcases': {'browser_outputs::idle': {'ignored': False},
                                   'other::test': {'ignored': False}}}
            def listing(command, **kwargs):
                self.assertTrue(directory.is_dir())
                self.assertEqual(command[command.index('--extract-to') + 1], str(directory))
                return json.dumps({'rust-suites': {'e2e': suite}})
            with patch.object(runner.subprocess, 'check_output', side_effect=listing):
                runner.prepare('complete.tar.zst', directory)
            with patch.object(runner.subprocess, 'call', return_value=0) as execute, \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(runner.run(directory, 'browser_outputs::'), 0)
                self.assertEqual(execute.call_args.args[0], [suite['binary-path'], 'browser_outputs::', '--nocapture'])
                self.assertEqual(execute.call_args.kwargs['cwd'], temporary)
                self.assertNotIn('timeout', execute.call_args.kwargs)
                with self.assertRaisesRegex(ValueError, 'empty'):
                    runner.run(directory, 'not_present')
                self.assertEqual(execute.call_count, 1)


class ArtifactTrust(unittest.TestCase):
    # test-category: security
    def test_reuse_checks_actual_checkout_manifest_before_downloading_payload(self):
        expected = dict(sha='a' * 40, platform='linux-x64', version='0.1.0-preview.99')
        run = dict(id=1, status='completed', conclusion='success', event='pull_request',
                   head_sha='b' * 40, head_repository={'full_name': 'owner/repo'})
        artifacts = [dict(name=f'agent-{kind}-linux-x64', expired=False) for kind in ['payload', 'provenance']]
        for mismatch in [None, 'sha', 'version', 'digest']:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                binary = root / 'fixture'
                binary.write_bytes(b'complete binary')
                metadata = dict(expected, binary='butler-agent', sha256=provenance.digest(binary))
                if mismatch in ['sha', 'version']:
                    metadata[mismatch] = 'different'
                def download(args, **kwargs):
                    directory = Path(args[args.index('--dir') + 1])
                    directory.mkdir(parents=True, exist_ok=True)
                    (directory / 'provenance.json').write_text(json.dumps(metadata))
                    if args[args.index('--name') + 1].startswith('agent-payload-'):
                        (directory / 'butler-agent').write_bytes(b'corrupt' if mismatch == 'digest' else binary.read_bytes())
                with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo', GITHUB_ENV=str(root / 'env')), \
                     patch.object(provenance, 'output', side_effect=[json.dumps({'workflow_runs': [run]}), json.dumps({'artifacts': artifacts})]), \
                     patch.object(provenance.subprocess, 'run', side_effect=download) as transfer, \
                     patch.object(provenance, 'verify_version') as version, contextlib.redirect_stdout(io.StringIO()):
                    if mismatch == 'digest':
                        with self.assertRaisesRegex(ValueError, 'digest'):
                            provenance.reuse(root / 'result', expected)
                    else:
                        self.assertEqual(provenance.reuse(root / 'result', expected), mismatch is None)
                    self.assertEqual(transfer.call_count, 1 if mismatch in ['sha', 'version'] else 2)
                    self.assertEqual(version.call_count, int(mismatch is None))

    # test-category: security
    def test_exact_identity_and_digest_required(self):
        expected = dict(schema=1, sha='a' * 40, platform='linux-x64', version='0.1.0-preview.99',
                        native_mode='static-ort', profile='release', toolchain='1.99.0',
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
                'macos-package', 'macos-updates', 'linux-arm64-archive', 'linux-arm64-tests', 'linux-package-x64',
                'linux-package-arm64', 'linux-arm64-native', 'linux-arm64-perf-archive', 'linux-arm64-perf', 'install-x64', 'install-arm64', 'install-macos', 'install-merge', 'ui', 'site', 'ds']
        outputs = dict.fromkeys(['rust', 'package', 'install', 'linux-package', 'ui', 'site', 'ds'], 'true')
        results = {job: {'result': 'success'} for job in jobs}
        outputs['tier'] = 'smoke'
        integration_only = ['linux-perf-archive', 'linux-perf', 'macos-native', 'macos-perf-archive', 'macos-perf', 'macos-package', 'macos-updates', 'install-macos', 'install-merge', 'linux-arm64-tests', 'linux-arm64-perf', 'linux-arm64-perf-archive']
        for name in integration_only:
            results[name]['result'] = 'skipped'
        results['changes'] = dict(result='success', outputs=outputs)
        env = dict(os.environ, EVENT='pull_request', RESULTS=json.dumps(results))
        self.assertEqual(subprocess.run([sys.executable, ROOT / 'check-gate.py'], env=env, capture_output=True).returncode, 0)
        for job in jobs:
            if job in integration_only:
                continue
            for outcome in ['failure', 'cancelled', 'skipped']:
                changed = json.loads(json.dumps(results))
                changed[job]['result'] = outcome
                env['RESULTS'] = json.dumps(changed)
                self.assertNotEqual(subprocess.run([sys.executable, ROOT / 'check-gate.py'], env=env, capture_output=True).returncode, 0, (job, outcome))

    # test-category: pure-logic
    def test_smoke_cannot_reach_e2e_or_perf_on_pr_or_main(self):
        source = (ROOT.parent / 'workflows/rust-quality.yml').read_text()
        blocks = {block.split(':', 1)[0].strip(): block
                  for block in re.split(r'(?=^  [a-z][a-z0-9-]*:\n)', source, flags=re.M)}
        forbidden = ['linux-perf', 'linux-perf-archive', 'macos-perf', 'macos-perf-archive',
                     'linux-arm64-perf', 'linux-arm64-perf-archive', 'linux-arm64-tests',
                     'macos-native', 'macos-package', 'macos-updates', 'install-macos']
        for event in ['pull_request', 'push']:
            for name in forbidden:
                condition = re.search(r'^    if: (.*)$', blocks[name], re.M)[1]
                condition = re.sub(r"fromJSON\(needs.changes.outputs.jobs\)\['[^']+'\]", 'True', condition)
                condition = condition.replace("needs.changes.outputs.tier", "'smoke'")
                condition = re.sub(r'needs.changes.outputs.[a-z-]+', "'true'", condition)
                condition = condition.replace('needs.changes.result', "'success'")
                condition = condition.replace('github.event_name', repr(event))
                condition = condition.replace('always()', 'True').replace('!cancelled()', 'True')
                condition = condition.replace('&&', 'and').replace('||', 'or')
                self.assertFalse(eval(condition), (event, name, condition))
        for name in ['linux-tests', 'macos-tests']:
            self.assertIn("e2e: ${{ needs.changes.outputs.tier == 'integration' }}", blocks[name])
        tests = (ROOT.parent / 'workflows/rust-tests.yml').read_text()
        self.assertIn('!inputs.performance-only && inputs.e2e', tests)


class CargoCache(unittest.TestCase):
    # test-category: security
    def test_restored_source_times_keep_real_cargo_changes_and_env_inputs_fresh(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'src').mkdir()
            (root / 'watched').mkdir()
            (root / 'watched/a.txt').write_text('one')
            (root / 'Cargo.toml').write_text('[package]\nname="freshness-proof"\nversion="0.1.0"\nedition="2024"\n')
            (root / 'src/main.rs').write_text('mod value; fn main() { println!("{}:{}:{}:{}", value::text(), include_str!("../extra.txt"), env!("STAMP"), env!("CONTENTS")); }')
            (root / 'src/value.rs').write_text('pub fn text() -> &\'static str { "original" }')
            (root / 'extra.txt').write_text('one')
            (root / 'build.rs').write_text('fn main() { println!("cargo:rerun-if-env-changed=CI_SOURCE_STAMP"); println!("cargo:rerun-if-changed=watched"); println!("cargo:rustc-env=STAMP={}", std::env::var("CI_SOURCE_STAMP").unwrap()); let mut entries: Vec<_> = std::fs::read_dir("watched").unwrap().map(|entry| { let entry = entry.unwrap(); format!("{}={}", entry.file_name().to_str().unwrap(), std::fs::read_to_string(entry.path()).unwrap()) }).collect(); entries.sort(); println!("cargo:rustc-env=CONTENTS={}", entries.join("|")); }')
            env = dict(os.environ, CARGO_TARGET_DIR=str(root / 'target'), CARGO_BUILD_JOBS='8',
                       CI_SOURCE_STAMP='first', RUSTC_WRAPPER='', CARGO_TERM_COLOR='never')
            def run(*args):
                return subprocess.run(args, cwd=root, env=env, text=True, capture_output=True, check=True)
            run('git', 'init', '-q')
            run('cargo', 'generate-lockfile', '--offline')
            run('git', 'add', 'Cargo.toml', 'Cargo.lock', 'src', 'extra.txt', 'build.rs', 'watched')
            # Source and tar timestamps are whole seconds; no sleeps/retries.
            for name in cargo_cache.source_times.tracked(root):
                os.utime(root / name, (1_700_000_000, 1_700_000_000))
            os.utime(root / 'watched', (1_700_000_000, 1_700_000_000))
            run('cargo', 'build', '--offline', '--locked', '-j', '8')
            entries = cargo_cache.source_times.capture(root)
            for entry in entries:
                os.utime(root / entry['path'], None)  # A fresh checkout.
            os.utime(root / 'watched', None)
            cargo_cache.source_times.restore(root, entries)
            fresh = run('cargo', 'build', '--offline', '--locked', '-j', '8', '-v')
            self.assertNotIn('Compiling freshness-proof', fresh.stderr)
            self.assertIn('Fresh freshness-proof', fresh.stderr)
            self.assertEqual(run(str(root / 'target/debug/freshness-proof')).stdout.strip(), 'original:one:first:a.txt=one')
            # Untracked additions and tracked deletions invalidate the whole
            # directory proof. Every entry and complete value must be present.
            (root / 'watched/b.txt').write_text('two')
            cargo_cache.source_times.restore(root, entries)
            run('cargo', 'build', '--offline', '--locked', '-j', '8')
            self.assertEqual(run(str(root / 'target/debug/freshness-proof')).stdout.strip(), 'original:one:first:a.txt=one|b.txt=two')
            (root / 'watched/a.txt').unlink()
            cargo_cache.source_times.restore(root, entries)
            run('cargo', 'build', '--offline', '--locked', '-j', '8')
            self.assertEqual(run(str(root / 'target/debug/freshness-proof')).stdout.strip(), 'original:one:first:b.txt=two')
            (root / 'src/value.rs').write_text('pub fn text() -> &\'static str { "changed" }')
            (root / 'extra.txt').write_text('two')
            cargo_cache.source_times.restore(root, entries)
            run('cargo', 'build', '--offline', '--locked', '-j', '8')
            self.assertEqual(run(str(root / 'target/debug/freshness-proof')).stdout.strip(), 'changed:two:first:b.txt=two')
            env['CI_SOURCE_STAMP'] = 'second'
            cargo_cache.source_times.restore(root, entries)
            run('cargo', 'build', '--offline', '--locked', '-j', '8')
            self.assertEqual(run(str(root / 'target/debug/freshness-proof')).stdout.strip(), 'changed:two:second:b.txt=two')
            for path in ['../escape', '/absolute', '.git/index']:
                with self.assertRaisesRegex(ValueError, 'source path'):
                    cargo_cache.source_times.restore(root, [dict(path=path, sha256='', mtime_ns=0)])

    # test-category: security
    def test_snapshot_requires_native_success_identity_and_complete_digest(self):
        run = dict(head_repository=dict(full_name='owner/repo'))
        jobs = [dict(name='macos-archive / Build archives (darwin-arm64)', status='completed', conclusion='success')]
        self.assertTrue(cargo_cache.valid_producer(run, jobs, 'owner/repo', 'darwin-arm64', 'dev'))
        self.assertFalse(cargo_cache.valid_producer(run, jobs, 'owner/repo', 'darwin-arm64', 'native'))
        self.assertFalse(cargo_cache.valid_producer(run, jobs, 'owner/repo', 'darwin-arm64', 'ort'))
        self.assertFalse(cargo_cache.valid_producer(run, jobs, 'owner/repo', 'linux-x64', 'dev'))
        self.assertFalse(cargo_cache.valid_producer(run, jobs, 'fork/repo', 'darwin-arm64', 'dev'))
        for status, conclusion in [('completed', 'failure'), ('completed', 'cancelled'), ('in_progress', '')]:
            self.assertFalse(cargo_cache.valid_producer(run, [dict(jobs[0], status=status, conclusion=conclusion)], 'owner/repo', 'darwin-arm64', 'dev'))
        perf = dict(name='macos-perf / Build perf harness (darwin-arm64)', status='completed', conclusion='success')
        failed_native = dict(name='macos-native / Build native Agent (darwin-arm64)', status='completed', conclusion='failure')
        self.assertTrue(cargo_cache.valid_producer(run, [perf, failed_native], 'owner/repo', 'darwin-arm64', 'perf'))
        self.assertFalse(cargo_cache.valid_producer(run, [perf, failed_native], 'owner/repo', 'darwin-arm64', 'ort'))
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
                # Existing cache symlinks must not redirect even a regular file
                # to a sibling checkout path (which tar's cwd filter allows).
                (root / 'sibling').mkdir()
                redirect = root / 'target/release/redirect'
                redirect.symlink_to('../../sibling')
                with tarfile.open(raw, 'w') as archive:
                    entry = tarfile.TarInfo('target/release/redirect/forbidden')
                    entry.size = 19
                    archive.addfile(entry, io.BytesIO(b'all compiled inputs'))
                with (root / 'cache.tar.zst').open('wb') as packed:
                    subprocess.run(['zstd', '-q', '-c', str(raw)], stdout=packed, check=True)
                with self.assertRaisesRegex(tarfile.FilterError, 'cache path'):
                    cargo_cache.extract(root)
                self.assertFalse((root / 'sibling/forbidden').exists())
                redirect.unlink()
                # Round-trip the producer snapshot, not just the extractor.
                os.link(root / 'target/release/complete', root / 'target/release/shared-input')
                expected = dict(platform='linux-x64', mode='prebuilt-ort', flags={})
                subprocess.run(['git', 'init', '-q'], check=True)
                (root / 'source.rs').write_text('complete source input')
                subprocess.run(['git', 'add', 'source.rs'], check=True)
                with patch.dict(os.environ, GITHUB_OUTPUT=str(root / 'outputs'), GITHUB_WORKSPACE=str(root)), \
                     patch.object(cargo_cache, 'output', return_value='a' * 40):
                    cargo_cache.record(root / 'snapshot', expected)
                cargo_cache.verify(root / 'snapshot', expected)
                sources = root / 'snapshot/sources.json'
                complete_sources = sources.read_bytes()
                sources.write_bytes(b'corrupt')
                with self.assertRaisesRegex(ValueError, 'source identity digest'):
                    cargo_cache.verify(root / 'snapshot', expected)
                sources.write_bytes(complete_sources)
                # A partial Actions cache is already present on a warm runner.
                cargo_cache.extract(root / 'snapshot')
                self.assertTrue(os.path.samefile(root / 'target/release/complete', root / 'target/release/shared-input'))
                (root / 'target/release/complete').unlink()
                cargo_cache.extract(root / 'snapshot')
                self.assertEqual((root / 'target/release/complete').read_bytes(), b'all compiled inputs')
                (root / 'native-deps').mkdir()
                (root / 'native-deps/runtime').write_bytes(b'complete pinned native runtime')
                (root / 'native-deps/_deps').symlink_to('runtime')
                runtime = dict(schema=1, platform='darwin-arm64', kind='ort', fingerprint='locked')
                with patch.dict(os.environ, GITHUB_OUTPUT=str(root / 'outputs')), \
                     patch.object(cargo_cache, 'output', return_value='a' * 40):
                    cargo_cache.record(root / 'runtime-snapshot', runtime, root='native-deps')
                cargo_cache.verify(root / 'runtime-snapshot', runtime)
                (root / 'native-deps/runtime').unlink()
                (root / 'native-deps/_deps').unlink()
                cargo_cache.extract(root / 'runtime-snapshot', root='native-deps')
                self.assertEqual((root / 'native-deps/runtime').read_bytes(), b'complete pinned native runtime')
                self.assertEqual(os.readlink(root / 'native-deps/_deps'), 'runtime')
                self.assertNotEqual(cargo_cache.artifact_name(runtime), cargo_cache.artifact_name(dict(runtime, fingerprint='different-sdk')))
                for kind, link in [(tarfile.SYMTYPE, '../../escaped'),
                                   (tarfile.SYMTYPE, '../Cargo.toml'),
                                   (tarfile.LNKTYPE, 'Cargo.toml')]:
                    with tarfile.open(raw, 'w') as archive:
                        entry = tarfile.TarInfo('target/escape')
                        entry.type = kind
                        entry.linkname = link
                        archive.addfile(entry)
                    with (root / 'cache.tar.zst').open('wb') as packed:
                        subprocess.run(['zstd', '-q', '-c', str(raw)], stdout=packed, check=True)
                    with self.assertRaises(tarfile.FilterError):
                        cargo_cache.extract(root)
                # Old macOS producers add a root AppleDouble sidecar. Keep
                # every metadata byte inside target; reject arbitrary siblings.
                for data in [b'\x00\x05\x16\x07\x00\x02\x00\x00full root attributes', b'not AppleDouble']:
                    with tarfile.open(raw, 'w') as archive:
                        entry = tarfile.TarInfo('._target')
                        entry.size = len(data)
                        archive.addfile(entry, io.BytesIO(data))
                    with (root / 'cache.tar.zst').open('wb') as packed:
                        subprocess.run(['zstd', '-q', '-c', str(raw)], stdout=packed, check=True)
                    if data.startswith(b'\x00\x05\x16\x07'):
                        cargo_cache.extract(root)
                        self.assertEqual((root / 'target/._archive_root').read_bytes(), data)
                        self.assertFalse((root / '._target').exists())
                    else:
                        with self.assertRaisesRegex(ValueError, 'AppleDouble'):
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
        owner = {name for name in perf if name.startswith('data_perf::')}
        self.assertEqual(len(selected), len(set(selected)))
        self.assertEqual(set(selected) | idle | owner, perf)
        self.assertTrue(idle, 'The complete idle observation must remain selected')
        self.assertTrue(owner, 'The complete owner-scale observation must remain selected')
        runnable = {name for name, test in tests.items() if not test['ignored']}
        disk = {name for name in tests if name.endswith('idle_disk_writes_and_cpu_stay_bounded')}
        self.assertEqual((set(ordinary) | installs | perf | disk) & runnable, runnable)
        print(f'Compiled inventory: {len(tests)} tests, {len(tests) - len(runnable)} existing ignored; '
              f'ordinary {list(map(len, selections))}, install {list(map(len, groups))}, '
              f'perf {list(map(len, perf_selections))} + {len(idle)} full idle + {len(owner)} full owner observation(s).')


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], 'WindowsSafety'] if WINDOWS_ONLY else None)
