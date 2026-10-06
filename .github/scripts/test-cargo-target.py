#!/usr/bin/env python3
"""Cargo snapshot trust, retention and actual release freshness checks."""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('snapshots', Path(__file__).with_name('cargo-target-release.py'))
snapshots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshots)
cache = snapshots.cache


class TargetSnapshot(unittest.TestCase):
    # test-category: security
    def test_trust_rejects_pr_fork_failed_commit_and_lane(self):
        metadata = dict(run_id=42, run_attempt=2, sha='a' * 40,
                        producer_name='Build native Agent (linux-x64)',
                        identity=dict(platform='linux-x64', kind='native'))
        run = dict(id=42, head_repository={'full_name': 'owner/repo'}, event='push', head_branch='main',
                   head_sha=metadata['sha'], status='completed', conclusion='success')
        jobs = {'jobs': [dict(name=metadata['producer_name'], status='completed', conclusion='success')]}
        with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo'):
            with patch.object(snapshots, 'api', side_effect=[run, jobs]) as lookup:
                snapshots.trusted(metadata)
                self.assertIn('/attempts/2/jobs?', lookup.call_args.args[0])
            for key, value in [('event', 'pull_request'), ('head_branch', 'feature/untrusted'),
                               ('head_sha', 'b' * 40), ('status', 'in_progress'),
                               ('head_repository', {'full_name': 'fork/repo'})]:
                with patch.object(snapshots, 'api', return_value=dict(run, **{key: value})):
                    with self.assertRaisesRegex(ValueError, 'main/release push'):
                        snapshots.trusted(metadata)
            with patch.object(snapshots, 'api', side_effect=[dict(run, conclusion='failure'), jobs]):
                snapshots.trusted(metadata)  # Other failures cannot discard a successful lane.
            with patch.object(snapshots, 'api', side_effect=[dict(run, head_branch='release/1.0.0'), jobs]):
                snapshots.trusted(metadata)
            with patch.object(snapshots, 'api', side_effect=[run, {'jobs': []}]):
                with self.assertRaisesRegex(ValueError, 'lane'):
                    snapshots.trusted(metadata)
            active = {'jobs': [dict(jobs['jobs'][0], status='in_progress', conclusion=None)]}
            with patch.object(snapshots, 'api', side_effect=[dict(run, status='in_progress'), active]):
                snapshots.trusted(metadata, publishing=True)
            failed = {'jobs': [dict(jobs['jobs'][0], conclusion='failure')]}
            with patch.object(snapshots, 'api', side_effect=[run, failed]):
                with self.assertRaisesRegex(ValueError, 'lane'):
                    snapshots.trusted(metadata)

    # test-category: pure-logic
    def test_key_changes_for_each_compatibility_input(self):
        with patch.object(cache, 'output', return_value='rustc 1.91\nhost: x86_64-unknown-linux-gnu'), \
                patch.object(cache, 'digest', return_value='locked'):
            expected = cache.identity('linux-x64', 'prebuilt-ort', 'native')
            for variable in ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_PROFILE_RELEASE_LTO',
                             'CARGO_BUILD_TARGET', 'TARGET_SNAPSHOT_PROFILE', 'TARGET_SNAPSHOT_FEATURES',
                             'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS', 'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER']:
                with patch.dict(os.environ, {variable: 'changed'}):
                    changed = cache.identity('linux-x64', 'prebuilt-ort', 'native')
                    self.assertNotEqual(snapshots.tag_name(expected), snapshots.tag_name(changed), variable)
            for field in ['compiler', 'native_compiler', 'lock', 'configs', 'runtime', 'native_recipe', 'platform', 'mode']:
                self.assertNotEqual(snapshots.tag_name(expected), snapshots.tag_name(dict(expected, **{field: 'changed'})))

    # test-category: security
    def test_chunk_order_roundtrip_and_retention(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'cache.tar.zst'
            archive.write_bytes(b'full snapshot contents')
            with patch.object(snapshots, 'CHUNK_BYTES', 8):
                chunks = snapshots.split(archive, root, '42-1')
            self.assertEqual(b''.join((root / name).read_bytes() for name in chunks), archive.read_bytes())
            versions = [dict(id=run, metadata={'container': {'tags': [f'fixture--{run}-1']}}) for run in [41,42,43]]
            versions += [dict(id=1, metadata={'container': {'tags': ['other-key--1-1']}})]
            with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo'), \
                    patch.object(cache, 'output', return_value=json.dumps([versions])), \
                    patch.object(snapshots.subprocess, 'run') as delete:
                snapshots.prune('fixture')
                self.assertEqual(delete.call_count, 1)
                self.assertTrue(delete.call_args.args[0][-1].endswith('/41'))

    # test-category: security
    def test_local_oras_push_pull_verify_tamper_missing_and_write_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            layout = root / 'oci'
            producer = root / 'producer'
            producer.mkdir()
            (producer / 'cache.tar.zst').write_bytes(b'complete compressed archive')
            (producer / 'sources.json').write_text('[]')
            expected = dict(schema=2, platform='linux-x64', kind='native')
            metadata = dict(identity=expected, run_id=42, run_attempt=1, sha='a' * 40,
                            sha256=cache.digest(producer / 'cache.tar.zst'), sources_sha256=cache.digest(producer / 'sources.json'))
            (producer / 'cache.json').write_text(json.dumps(metadata))
            with patch.dict(os.environ, BUTLER_OCI_LAYOUT='1', RUNNER_TEMP=str(root)), \
                    patch.object(snapshots.ci_oci, 'REGISTRY', str(layout)), \
                    patch.object(snapshots, 'trusted'), patch.object(snapshots, 'CHUNK_BYTES', 8):
                snapshots.publish(producer, 42)
                published = snapshots.release(snapshots.tag_name(expected))
                consumer = root / 'consumer'
                consumer.mkdir()
                manifest = snapshots.generations(published['assets'])[0]
                snapshots.fetch_snapshot(published, manifest, consumer, expected)
                self.assertEqual((consumer / 'cache.tar.zst').read_bytes(), (producer / 'cache.tar.zst').read_bytes())
                self.assertEqual(len(published['assets']), 6)  # Four chunks, sources, manifest.
                snapshots.publish(producer, 42)  # An existing generation is never pushed again.
                with patch.object(snapshots.ci_oci, 'push', side_effect=AssertionError('overwrite')):
                    snapshots.publish(producer, 42)
                self.assertFalse(snapshots.restore(dict(expected, platform='missing')))
                layer = next(entry for entry in published['assets'] if entry['name'].endswith('-0000.zst'))
                blob = layout / 'cargo-target/blobs/sha256' / layer['digest'].split(':')[1]
                blob.chmod(0o644)
                blob.write_bytes(b'tampered')
                with self.assertRaisesRegex((ValueError, RuntimeError), 'mismatch|digest|size'):
                    snapshots.fetch_snapshot(published, manifest, consumer, expected)
                metadata['sha'] = 'b' * 40
                (producer / 'cache.json').write_text(json.dumps(metadata))
                with self.assertRaisesRegex(ValueError, 'cannot be overwritten'):
                    snapshots.publish(producer, 42)

    # test-category: pure-logic
    def test_imports_leave_watched_recipe_directory_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recipe = root / 'recipe.py'
            recipe.write_text('VALUE = "pinned recipe"\n')
            before = recipe.parent.stat().st_mtime_ns
            imported = importlib.util.spec_from_file_location('recipe_fixture', recipe)
            module = importlib.util.module_from_spec(imported)
            imported.loader.exec_module(module)
            self.assertEqual(module.VALUE, 'pinned recipe')
            self.assertFalse((root / '__pycache__').exists())
            self.assertEqual(recipe.parent.stat().st_mtime_ns, before)

    def fixture(self, root):
        (root / 'Cargo.toml').write_text('[workspace]\nmembers=["core", "gateway", "app"]\nresolver="2"\n'
                                       '[profile.release]\nlto="thin"\ncodegen-units=1\n')
        for name, dependencies, source in [
                ('core', '', 'pub fn value() -> u32 { 1 }'),
                ('gateway', 'core={path="../core"}', 'pub fn value() -> u32 { core::value() }'),
                ('app', 'gateway={path="../gateway"}', 'fn main() { println!("{}", gateway::value()); }')]:
            directory = root / name
            (directory / 'src').mkdir(parents=True)
            (directory / 'Cargo.toml').write_text(f'[package]\nname="{name}"\nversion="0.1.0"\nedition="2021"\n[dependencies]\n{dependencies}\n')
            (directory / 'src' / ('main.rs' if name == 'app' else 'lib.rs')).write_text(source)
        subprocess.run(['git', 'init', '-q', str(root)], check=True)
        subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)

    # test-category: security
    def test_actual_release_changed_rebuild_unchanged_reuse_and_tamper_reject(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            target = root / 'target'
            expected = dict(schema=2, kind='native', platform='linux-x64')
            env = dict(CARGO_TARGET_DIR=str(target), GITHUB_WORKSPACE=str(root), GITHUB_OUTPUT=str(root / 'output'), RUSTC_WRAPPER='')
            with patch.dict(os.environ, env), contextlib.chdir(root):
                self.build(root)
                with patch.object(cache, 'output', return_value='a' * 40):
                    cache.record(root / 'snapshot', expected)
                snapshots.restore_tree(root / 'snapshot', expected)
                self.assertNotIn('Compiling', self.build(root))
                source = root / 'gateway/src/lib.rs'
                source.write_text('pub fn value() -> u32 { core::value() + 1 }')
                os.utime(source, (1, 1))  # Changed contents beat even an old mtime.
                snapshots.restore_tree(root / 'snapshot', expected)
                changed = self.build(root)
                self.assertIn('Compiling gateway ', changed)
                self.assertIn('Compiling app ', changed)
                self.assertNotIn('Compiling core ', changed)
                self.assertEqual(subprocess.check_output([str(target / 'release/app')], text=True).strip(), '2')
                before = (target / 'release/app').read_bytes()
                (root / 'snapshot/cache.tar.zst').write_bytes(b'tampered')
                with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                    snapshots.restore_tree(root / 'snapshot', expected)
                self.assertEqual((target / 'release/app').read_bytes(), before)

    def build(self, root):
        return subprocess.check_output(['python3', str(Path(__file__).with_name('isolated.py').resolve()),
                                        'cargo', 'build', '--release', '--timings', '-j', '8', '--offline'],
                                       cwd=root, stderr=subprocess.STDOUT, text=True)


if __name__ == '__main__':
    unittest.main()
