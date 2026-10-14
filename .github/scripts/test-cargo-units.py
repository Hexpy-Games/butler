#!/usr/bin/env python3
"""Cargo snapshots keep every unit the build uses and drop superseded copies."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('snapshots', ROOT / 'cargo-target-release.py')
snapshots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshots)
cache = snapshots.cache
units = cache.cargo_units


def members(directory):
    with subprocess.Popen(['zstd', '-d', '-c', str(directory / 'cache.tar.zst')], stdout=subprocess.PIPE) as stream:
        with tarfile.open(fileobj=stream.stdout, mode='r|') as archive:
            return {member.name: member for member in archive}


def fingerprints(names, package):
    return {Path(name).name for name in names
            if re.fullmatch(rf'target/debug/\.fingerprint/{package}-[0-9a-f]{{16}}', name)}


class CargoUnits(unittest.TestCase):
    def fixture(self, root):
        (root / 'Cargo.toml').write_text('[workspace]\nmembers=["core", "gateway", "app"]\nresolver="2"\n')
        for name, dependencies, source in [
                ('core', '', 'pub fn value() -> u32 { 1 }'),
                ('gateway', 'core={path="../core"}', 'pub fn value() -> u32 { core::value() + 1 }'),
                ('app', 'gateway={path="../gateway"}', 'fn main() { println!("{}", gateway::value()); }')]:
            directory = root / name
            (directory / 'src').mkdir(parents=True)
            (directory / 'Cargo.toml').write_text(f'[package]\nname="{name}"\nversion="0.1.0"\nedition="2021"\n[dependencies]\n{dependencies}\n')
            (directory / 'src' / ('main.rs' if name == 'app' else 'lib.rs')).write_text(source)
        # A build script makes a non-workspace-root run unit that only its library reaches.
        (root / 'gateway/build.rs').write_text('fn main() { println!("cargo:rerun-if-changed=build.rs"); }')
        subprocess.run(['git', 'init', '-q', str(root)], check=True)
        subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)

    def build(self, root):
        isolated = str(ROOT / 'isolated.py')
        logs = [subprocess.check_output(['python3', isolated, 'cargo', *command, '--offline'], cwd=root,
                                        stderr=subprocess.STDOUT, text=True)
                for command in [['build', '--all-targets', '-j', '8'], ['check', '-j', '8']]]
        return '\n'.join(logs)

    # test-category: security
    def test_superseded_units_stay_out_and_the_restored_build_stays_fresh(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.fixture(root)
            target = root / 'target'
            expected = dict(schema=2, kind='dev', platform='linux-x64')
            env = dict(CARGO_TARGET_DIR=str(target), GITHUB_WORKSPACE=str(root), GITHUB_OUTPUT=str(root / 'output'),
                       RUSTC_WRAPPER='', CARGO_TERM_COLOR='never')
            with patch.dict(os.environ, env), contextlib.chdir(root), \
                    patch.object(cache, 'output', return_value='a' * 40):
                self.build(root)
                cache.record(root / 'first', expected)
                first = members(root / 'first')
                snapshots.restore_tree(root / 'first', expected)
                manifest = root / 'gateway/Cargo.toml'
                manifest.write_text(manifest.read_text().replace('0.1.0', '0.1.1'))
                subprocess.run(['cargo', 'generate-lockfile', '--offline'], cwd=root, check=True,
                               capture_output=True)
                rebuilt = self.build(root)
                self.assertIn('Compiling gateway ', rebuilt)
                self.assertNotIn('Compiling core ', rebuilt)
                kept = target / 'debug/.fingerprint'
                self.assertGreater(len(fingerprints([f'target/debug/.fingerprint/{path.name}' for path in kept.iterdir()],
                                                    'gateway')), len(fingerprints(first, 'gateway')))
                cache.record(root / 'second', expected)
                second = members(root / 'second')
                # Every superseded gateway/app unit (and its outputs) stays out; untouched core units stay.
                for package in ['gateway', 'app']:
                    old = fingerprints(first, package)
                    self.assertTrue(old)
                    self.assertFalse(old & fingerprints(second, package), package)
                    stale = {name[-16:] for name in old}
                    self.assertFalse([name for name in second if any(value in name for value in stale)], package)
                self.assertEqual(fingerprints(first, 'core'), fingerprints(second, 'core'))
                snapshots.restore_tree(root / 'second', expected)
                fresh = self.build(root)
                self.assertNotIn('Compiling', fresh)
                self.assertEqual(subprocess.check_output([str(target / 'debug/app')], text=True).strip(), '2')

    def unit(self, profile, name, value, mtime, deps=()):
        directory = profile / '.fingerprint' / name
        directory.mkdir(parents=True)
        (directory / 'lib-x.json').write_text(json.dumps(dict(
            rustc=1, features='[]', declared_features=f'["{mtime}"]', profile=2, path=3,
            local=[{'CheckDepInfo': {'dep_info': 'dep'}}],
            deps=[[0, 'dep', False, int.from_bytes(bytes.fromhex(dep), 'little')] for dep in deps])))
        (directory / 'lib-x').write_text(value)
        os.utime(directory / 'lib-x', (mtime, mtime))
        return directory

    # test-category: security
    def test_live_link_to_a_superseded_first_name_is_archived_with_its_contents(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            profile = root / 'target/debug'
            self.unit(profile, 'x-' + 'a' * 16, '1' * 16, 200, deps=['3' * 16])  # Newest build.
            self.unit(profile, 'x-' + 'b' * 16, '2' * 16, 100, deps=['4' * 16])  # Superseded by it.
            self.unit(profile, 'dep-' + 'c' * 16, '3' * 16, 50)  # Reached from the newest build.
            self.unit(profile, 'old-' + 'd' * 16, '4' * 16, 50)  # Reached only from the superseded one.
            self.unit(profile, 'y-' + 'e' * 16, '5' * 16, 150, deps=['6' * 16])  # Its dependency was rebuilt.
            self.unit(profile, 'z-' + 'f' * 16, '7' * 16, 10)  # A fresh, untouched top-level unit.
            (profile / 'deps').mkdir()
            (profile / 'deps' / ('libx-' + 'b' * 16 + '.rlib')).write_bytes(b'superseded output')
            (profile / 'deps' / ('libdep-' + 'c' * 16 + '.rlib')).write_bytes(b'live dependency')
            os.link(profile / 'deps' / ('libx-' + 'b' * 16 + '.rlib'), profile / 'zz-uplifted')
            self.assertEqual(units.stale(root / 'target'), {f'debug/{name * 16}' for name in 'bde'})
            with patch.dict(os.environ, GITHUB_OUTPUT=str(root / 'output')), \
                    patch.object(cache, 'output', return_value='a' * 40):
                cache.record(root / 'snapshot', dict(platform='linux-x64'), root='native', target=root / 'target')
            archived = members(root / 'snapshot')
            self.assertNotIn('native/debug/deps/libx-' + 'b' * 16 + '.rlib', archived)
            self.assertNotIn('native/debug/.fingerprint/old-' + 'd' * 16, archived)
            self.assertIn('native/debug/deps/libdep-' + 'c' * 16 + '.rlib', archived)
            self.assertTrue(archived['native/debug/zz-uplifted'].isreg())
            restored = root / 'restored'
            restored.mkdir()
            with contextlib.chdir(restored):
                cache.extract(root / 'snapshot', root='native')
            self.assertEqual((restored / 'native/debug/zz-uplifted').read_bytes(), b'superseded output')

    # test-category: security
    def test_unreadable_or_unresolved_fingerprints_keep_every_unit(self):
        with tempfile.TemporaryDirectory() as temporary:
            profile = Path(temporary) / 'debug'
            self.unit(profile, 'x-' + 'a' * 16, '1' * 16, 200, deps=['9' * 16])
            self.unit(profile, 'x-' + 'b' * 16, '2' * 16, 100)
            self.assertEqual(units.stale(Path(temporary)), set())
            (profile / '.fingerprint' / ('x-' + 'a' * 16) / 'lib-x.json').write_text('{')
            self.assertEqual(units.stale(Path(temporary)), set())

    # test-category: pure-logic
    def test_test_bundles_upload_before_the_cache_snapshot_publish(self):
        workflows = ROOT.parent / 'workflows'
        checked = 0
        for workflow in sorted(workflows.glob('*.yml')):
            for job in re.split(r'(?m)^  (?=[a-z][a-z0-9-]*:\n)', workflow.read_text()):
                publish = re.search(r'uses: \./\.github/actions/publish-(?:cargo|windows)-target', job)
                if publish:
                    checked += 1
                    self.assertNotIn('actions/upload-artifact', job[publish.end():], workflow.name)
        self.assertGreaterEqual(checked, 4)


if __name__ == '__main__':
    unittest.main()
