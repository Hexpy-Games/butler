#!/usr/bin/env python3
"""Cargo snapshot trust, retention and actual release freshness checks."""
import contextlib
import hashlib
import importlib.util
import json
import io
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
    def test_upgrade_accepts_only_exact_legacy_manifest_identity(self):
        expected = dict(platform='linux-x64', profile_config={}, runtime='', lock='pinned',
                        configs={'Cargo.toml': 'pinned'})
        legacy = dict(expected)
        legacy.pop('profile_config')
        published = {'assets': [{'name': '42-1.json'}]}
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, RUNNER_TEMP=temporary, ORT_LIB_PATH=''), \
                patch.object(snapshots, 'release', side_effect=[None, published]) as lookup, \
                patch.object(snapshots, 'fetch_snapshot') as fetch, patch.object(snapshots, 'restore_tree') as adopt:
            self.assertTrue(snapshots.restore(expected))
            self.assertEqual(lookup.call_args.args[0], snapshots.tag_name(legacy))
            self.assertEqual(fetch.call_args.args[3:], (legacy, False))
            self.assertEqual(adopt.call_args.args[1:], (legacy, False))

    # test-category: security
    def test_compatible_snapshot_relaxes_only_lock_and_manifest_digest(self):
        expected = dict(schema=2, platform='linux-x64', kind='native', compiler='pinned',
                        target='linux', profile='release', features='static-ort', lock='old',
                        configs={'Cargo.toml': 'old', '.cargo/config.toml': 'fixed'},
                        profile_config={'release': {'lto': 'thin'}}, flags={}, runtime='static')
        changed = dict(expected, lock='new', configs=dict(expected['configs'], **{'Cargo.toml': 'new'}))
        self.assertNotEqual(snapshots.tag_name(expected), snapshots.tag_name(changed))
        self.assertEqual(snapshots.compatible_tag(expected), snapshots.compatible_tag(changed))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'cache.tar.zst').write_bytes(b'complete snapshot')
            (root / 'sources.json').write_text('[]')
            metadata = dict(identity=expected, sha256=cache.digest(root / 'cache.tar.zst'),
                            sources_sha256=cache.digest(root / 'sources.json'))
            (root / 'cache.json').write_text(json.dumps(metadata))
            cache.verify(root, changed, compatible=True)
            with self.assertRaisesRegex(ValueError, 'identity'):
                cache.verify(root, changed)
            for field in ['compiler', 'target', 'profile', 'features', 'flags', 'runtime', 'profile_config']:
                with self.assertRaisesRegex(ValueError, 'identity'):
                    cache.verify(root, dict(changed, **{field: 'different'}), compatible=True)
            with self.assertRaisesRegex(ValueError, 'identity'):
                cache.verify(root, dict(changed, configs={'.cargo/config.toml': 'different'}), compatible=True)
            (root / 'cache.tar.zst').write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'digest'):
                cache.verify(root, changed, compatible=True)

    # test-category: security
    def test_persistent_target_reuses_complete_local_outputs_and_isolates_refs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            expected = dict(platform='windows-x64', kind='native', profile='ci-fast', lock='old')
            env = dict(BUTLER_PERSISTENT_TARGET=str(root / 'runner-cache'), GITHUB_REF='refs/pull/1/merge',
                       GITHUB_ENV=str(root / 'env'), GITHUB_WORKSPACE=str(root))
            with patch.dict(os.environ, env), patch.object(cache.source_times, 'capture', return_value=[]), \
                    patch.object(cache.source_times, 'restore') as freshness, patch.object(snapshots, 'release') as remote:
                target = snapshots.persistent_target(expected)
                snapshots.save_local(target, expected)
                (target / 'complete').write_bytes(b'all outputs')
                self.assertTrue(snapshots.restore(dict(expected, lock='new')))
                self.assertEqual((target / 'complete').read_bytes(), b'all outputs')
                remote.assert_not_called()
                freshness.assert_called_once()
                with patch.dict(os.environ, GITHUB_REF='refs/heads/main'):
                    self.assertNotEqual(target, snapshots.persistent_target(expected))
                self.assertNotEqual(target, snapshots.persistent_target(dict(expected, profile='release')))
                (target / 'ci-local-sources.json').write_text('tampered')
                with self.assertRaisesRegex(ValueError, 'digest'):
                    snapshots.restore_local(target, expected)
    # test-category: security
    def test_https_api_without_gh_preserves_pages_and_delete(self):
        def response(value, link=''):
            stream = io.BytesIO(json.dumps(value).encode())
            stream.headers = {'Link': link}
            return stream
        next_url = 'https://api.github.com/repos/owner/repo/actions/runs/42/jobs?page=2'
        cases = [('repos/owner/repo/actions/runs/42/jobs?per_page=100',
                  [{'jobs': [{'id': 1}]}, {'jobs': [{'id': 2}]}], {'jobs': [{'id': 1}, {'id': 2}]}),
                 ('orgs/owner/packages/container/cache/versions?per_page=100',
                  [[{'id': 1}], [{'id': 2}]], [{'id': 1}, {'id': 2}])]
        with patch.dict(os.environ, GITHUB_TOKEN='fixture-token'), \
                patch.object(cache, 'output', side_effect=AssertionError('gh is unavailable')):
            for endpoint, pages, expected in cases:
                with patch.object(snapshots.urllib.request, 'urlopen', side_effect=[
                        response(pages[0], f'<{next_url}>; rel="next"'), response(pages[1])]) as lookup:
                    self.assertEqual(snapshots.api(endpoint), expected)
                    self.assertEqual(lookup.call_count, 2)
                    self.assertEqual(lookup.call_args.args[0].full_url, next_url)
                    self.assertEqual(lookup.call_args.args[0].get_header('Authorization'), 'Bearer fixture-token')
                    self.assertEqual(lookup.call_args.kwargs, {'timeout': 60})
            with patch.object(snapshots.urllib.request, 'urlopen', return_value=response(None)) as lookup:
                self.assertIsNone(snapshots.api('orgs/owner/packages/container/cache/versions/1', method='DELETE'))
                self.assertEqual(lookup.call_args.args[0].method, 'DELETE')
            with patch.object(snapshots.urllib.request, 'urlopen', return_value=response(
                    [], '<https://untrusted.invalid/page>; rel="next"')) as lookup:
                with self.assertRaisesRegex(ValueError, 'Untrusted'):
                    snapshots.api(cases[1][0])
                self.assertEqual(lookup.call_count, 1)

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
                               ('head_sha', 'b' * 40),
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

    # test-category: security
    def test_restore_during_post_build_publish_falls_back_without_touching_target(self):
        metadata = dict(run_id=42, run_attempt=1, sha='a' * 40)
        run = dict(head_repository={'full_name': 'owner/repo'}, event='push', head_branch='main',
                   head_sha=metadata['sha'], status='in_progress')
        with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo'), patch.object(snapshots, 'api', return_value=run):
            with self.assertRaisesRegex(snapshots.UnsuccessfulProducer, 'not complete yet'):
                snapshots.trusted(metadata)
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, RUNNER_TEMP=temporary), \
                patch.object(snapshots, 'release', return_value={'assets': [{'name': '42-1.json'}]}), \
                patch.object(snapshots, 'fetch_snapshot', side_effect=snapshots.UnsuccessfulProducer('pending')), \
                patch.object(snapshots, 'restore_tree') as adopt:
            self.assertFalse(snapshots.restore({'platform': 'linux-x64'}))
            adopt.assert_not_called()

    # test-category: pure-logic
    def test_key_changes_for_each_compatibility_input(self):
        with patch.object(cache, 'output', return_value='rustc 1.99\nhost: x86_64-unknown-linux-gnu'), \
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
            versions[0]['metadata']['container']['tags'].append('fixture')  # An older producer finished last.
            versions += [dict(id=1, metadata={'container': {'tags': ['other-key--1-1']}})]
            with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo'), \
                    patch.object(snapshots, 'api', side_effect=[versions, None]) as lookup, \
                    patch.object(snapshots.ci_oci, 'checked') as promote, \
                    patch.object(cache, 'output', side_effect=AssertionError('gh is unavailable')):
                snapshots.prune('fixture', '41-1')
                self.assertEqual(promote.call_args.args, ('tag', snapshots.ci_oci.REGISTRY + '/cargo-target:fixture--43-1', 'fixture'))
                self.assertEqual(lookup.call_count, 2)
                self.assertTrue(lookup.call_args.args[0].endswith('/41'))
                self.assertEqual(lookup.call_args.kwargs, {'method': 'DELETE'})

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
                with patch.object(snapshots, 'restore_tree') as adopt:
                    nearest = dict(expected, lock='changed dependency resolution')
                    self.assertTrue(snapshots.restore(nearest))
                    self.assertEqual(adopt.call_args.args[1:], (nearest, True))
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
            env = dict(CARGO_TARGET_DIR=str(target), GITHUB_WORKSPACE=str(root), GITHUB_OUTPUT=str(root / 'output'),
                       RUSTC_WRAPPER='', CARGO_TERM_COLOR='never')
            with patch.dict(os.environ, env), contextlib.chdir(root):
                self.build(root)
                with patch.object(cache, 'output', return_value='a' * 40):
                    cache.record(root / 'snapshot', expected)
                snapshots.restore_tree(root / 'snapshot', expected)
                self.assertNotIn('Compiling', self.build(root))
                # A package version/lock change must restore the verified
                # nearest snapshot and rebuild the dependency's consumers,
                # while retaining unrelated complete core outputs.
                expected['lock'] = cache.digest(root / 'Cargo.lock')
                with patch.object(cache, 'output', return_value='a' * 40):
                    cache.record(root / 'snapshot', expected)
                manifest = root / 'gateway/Cargo.toml'
                manifest.write_text(manifest.read_text().replace('0.1.0', '0.1.1'))
                subprocess.run(['cargo', 'generate-lockfile', '--offline'], cwd=root, check=True)
                changed_identity = dict(expected, lock=cache.digest(root / 'Cargo.lock'))
                snapshots.restore_tree(root / 'snapshot', changed_identity, compatible=True)
                dependency = self.build(root)
                self.assertIn('Compiling gateway ', dependency)
                self.assertIn('Compiling app ', dependency)
                self.assertNotIn('Compiling core ', dependency)
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
