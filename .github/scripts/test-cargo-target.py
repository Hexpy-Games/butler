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
        metadata = dict(run_id=42, run_attempt=2, sha='a' * 40, identity=dict(platform='linux-x64', kind='native'))
        run = dict(id=42, head_repository={'full_name': 'owner/repo'}, event='push', head_branch='main',
                   head_sha=metadata['sha'], status='completed', conclusion='success')
        jobs = {'jobs': [dict(name='Build native Agent (linux-x64)', status='completed', conclusion='success')]}
        with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo'):
            with patch.object(snapshots, 'api', side_effect=[run, jobs]) as lookup:
                snapshots.trusted(metadata)
                self.assertIn('/attempts/2/jobs?', lookup.call_args.args[0])
            for key, value in [('event', 'pull_request'), ('head_branch', 'release/1.0.0'),
                               ('head_sha', 'b' * 40), ('status', 'in_progress'),
                               ('head_repository', {'full_name': 'fork/repo'})]:
                with patch.object(snapshots, 'api', return_value=dict(run, **{key: value})):
                    with self.assertRaisesRegex(ValueError, 'main push'):
                        snapshots.trusted(metadata)
            with patch.object(snapshots, 'api', side_effect=[dict(run, conclusion='failure'), jobs]):
                snapshots.trusted(metadata)  # Another failed job cannot discard a successful build.
            main_run = dict(run, path='.github/workflows/cargo-target-main.yml')
            lane_metadata = dict(metadata, identity=dict(metadata['identity'], profile='ci-fast', mode='static-ort'), runner_kind='owner')
            owner_job = dict(name='Build target snapshot ci-fast static-ort owner (linux-x64)', status='completed', conclusion='success')
            with patch.object(snapshots, 'api', side_effect=[main_run, {'jobs': [owner_job]}]):
                snapshots.trusted(lane_metadata)
            hosted_job = dict(owner_job, name=owner_job['name'].replace(' owner ', ' hosted '))
            with patch.object(snapshots, 'api', side_effect=[main_run, {'jobs': [hosted_job]}]):
                with self.assertRaisesRegex(ValueError, 'lane'):
                    snapshots.trusted(lane_metadata)
            with patch.object(snapshots, 'api', side_effect=[run, {'jobs': []}]):
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
    def test_github_digest_required_and_redirect_strips_auth(self):
        with self.assertRaisesRegex(ValueError, 'GitHub SHA-256'):
            snapshots.download(dict(digest=None), Path('unused'))
        from static_ort_prebuilt import SafeRedirect
        from urllib.request import Request
        redirected = SafeRedirect().redirect_request(Request('https://api.github.com/a', headers={'Authorization': 'fixture'}),
                                                       None, 302, 'Found', {}, 'https://example.org/asset')
        self.assertFalse(redirected.has_header('Authorization'))

    # test-category: security
    def test_chunk_order_roundtrip_and_retention(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / 'cache.tar.zst'
            archive.write_bytes(b'full snapshot contents')
            with patch.object(snapshots, 'CHUNK_BYTES', 8):
                chunks = snapshots.split(archive, root, '42-1')
            self.assertEqual(b''.join((root / name).read_bytes() for name in chunks), archive.read_bytes())
            assets = [{'name': f'{run}-1{suffix}'} for run in [41, 42, 43]
                      for suffix in ['.json', '-0000.zst', '-sources.json']]
            assets.append({'name': '40-1-0000.zst'})  # Interrupted publication.
            with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo'), patch.object(snapshots.subprocess, 'run') as delete:
                snapshots.prune('cargo-target-fixture', {'assets': assets})
                removed = {call.args[0][4] for call in delete.call_args_list}
            self.assertEqual(removed, {'41-1.json', '41-1-0000.zst', '41-1-sources.json', '40-1-0000.zst'})

    # test-category: security
    def test_publication_commits_manifest_last_and_fetch_rejects_tampering(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'cache.tar.zst').write_bytes(b'complete compressed archive')
            (root / 'sources.json').write_text('[]')
            expected = dict(schema=2, platform='linux-x64', kind='native')
            metadata = dict(identity=expected, run_id=42, run_attempt=1, sha='a' * 40,
                            sha256=cache.digest(root / 'cache.tar.zst'), sources_sha256=cache.digest(root / 'sources.json'))
            (root / 'cache.json').write_text(json.dumps(metadata))
            state = dict(draft=True, assets=[])
            contents = {}
            uploads = []
            def mutate(args, **kwargs):
                if args[2] == 'upload':
                    path = Path(args[4])
                    data = path.read_bytes()
                    contents[path.name] = data
                    uploads.append(path.name)
                    state['assets'].append(dict(name=path.name, size=len(data), digest='sha256:' + hashlib.sha256(data).hexdigest()))
                elif args[2] == 'edit':
                    state['draft'] = False
            def transfer(entry, destination):
                data = contents[entry['name']]
                if 'sha256:' + hashlib.sha256(data).hexdigest() != entry['digest']:
                    raise ValueError('GitHub digest mismatch')
                destination.write_bytes(data)
            with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo'), patch.object(snapshots, 'trusted'), \
                    patch.object(snapshots, 'release', side_effect=lambda *args, **kwargs: state), \
                    patch.object(snapshots.subprocess, 'run', side_effect=mutate):
                snapshots.publish(root, 42)
            self.assertEqual(uploads[-1], '42-1.json')
            self.assertFalse(state['draft'])
            consumer = root / 'consumer'
            consumer.mkdir()
            manifest = next(entry for entry in state['assets'] if entry['name'] == '42-1.json')
            with patch.object(snapshots, 'download', side_effect=transfer), patch.object(snapshots, 'trusted'):
                snapshots.fetch_snapshot(state, manifest, consumer, expected)
                self.assertEqual((consumer / 'cache.tar.zst').read_bytes(), (root / 'cache.tar.zst').read_bytes())
                contents['42-1-0000.zst'] = b'tampered'
                with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                    snapshots.fetch_snapshot(state, manifest, consumer, expected)

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

    # test-category: security
    def test_draft_lookup_is_publisher_only_and_resumes_first_upload(self):
        from urllib.error import HTTPError
        draft = dict(id=7, tag_name='cargo-target-key', draft=True, assets=[])
        with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo'), \
                patch.object(snapshots, 'request', side_effect=HTTPError('fixture', 404, 'missing', {}, None)), \
                patch.object(cache, 'output', side_effect=[json.dumps([[draft]]), json.dumps([[]])]) as enumerate_drafts:
            self.assertIsNone(snapshots.release('cargo-target-key'))
            enumerate_drafts.assert_not_called()
            self.assertEqual(snapshots.release('cargo-target-key', allow_draft=True), draft)
            self.assertIn('--paginate', enumerate_drafts.call_args.args)

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
