#!/usr/bin/env python3
"""Runner-local cache retention, eviction and Windows long-path checks."""
import contextlib
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('snapshots', Path(__file__).with_name('cargo-target-release.py'))
snapshots = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshots)
# Cache namespaces reject every linked ancestor. Keep test roots under the
# canonical temp dir: macOS's default TMPDIR sits under the /var link.
tempfile.tempdir = os.path.realpath(tempfile.gettempdir())

MAX_PATH = 260
# POSIX keeps exactly two leading slashes through joins and directory listings,
# as Windows keeps `\\?\` on every path built from an extended one.
PREFIX = '/'


@contextlib.contextmanager
def windows_max_path():
    """Off Windows, reject plain paths past MAX_PATH the way Win32 does.

    `extended()` gains a marker prefix (`//`) that the guarded calls accept, so
    only calls routed through it reach long paths. As on Win32, a relative name
    counts with the current directory. On Windows the OS enforces this.
    """
    if os.name == 'nt':
        yield
        return

    def checked(path):
        if not isinstance(path, (str, os.PathLike)):
            return path
        value = os.fspath(path)
        if value.startswith('//') or len(os.path.join(os.getcwd(), value)) < MAX_PATH:
            return path
        raise FileNotFoundError(errno.ENOENT, '[WinError 3] emulated MAX_PATH', value)

    def guard(real):
        def call(*args, **kwargs):
            return real(*map(checked, args), **kwargs)
        return call

    # Python 3.14 renamed tarfile's link step; the owner runners' 3.12.10 has `makelink`.
    link_step = 'makelink_with_filter' if hasattr(tarfile.TarFile, 'makelink_with_filter') else 'makelink'
    makelink = getattr(tarfile.TarFile, link_step)

    def windows_makelink(self, tarinfo, *args, **kwargs):
        # POSIX cannot show separators: `/` is native here. Python 3.12.10 joins
        # a hard link's `/`-separated linkname onto the destination unconverted
        # (tarfile.py:2357), and `\\?\` keeps that `/` literally, so Windows
        # misses the source and tarfile seeks backwards in the stream.
        if tarinfo.islnk() and tarinfo._link_target.startswith('//') and '/' in tarinfo.linkname:
            raise tarfile.StreamError('seeking backwards is not allowed')
        return makelink(self, tarinfo, *args, **kwargs)

    names = ['stat', 'lstat', 'listdir', 'scandir', 'mkdir', 'rmdir', 'unlink', 'chmod', 'utime', 'open', 'rename',
             'link']
    with contextlib.ExitStack() as stack:
        for name in names:
            stack.enter_context(patch.object(os, name, guard(getattr(os, name))))
        # Windows has no dir_fd, so shutil.rmtree walks joined full paths there.
        stack.enter_context(patch.object(shutil, '_use_fd_functions', False))
        if hasattr(shutil, '_rmtree_impl'):
            stack.enter_context(patch.object(shutil, '_rmtree_impl', shutil._rmtree_unsafe))
        stack.enter_context(patch('builtins.open', guard(open)))
        stack.enter_context(patch('io.open', guard(io.open)))
        stack.enter_context(patch.object(tarfile, 'bltn_open', guard(tarfile.bltn_open)))
        stack.enter_context(patch.object(tarfile.TarFile, link_step, windows_makelink))
        stack.enter_context(patch.object(snapshots.runner_cache, 'extended', lambda path: PREFIX + str(path)))
        yield


class RunnerEviction(unittest.TestCase):
    def seed(self, root, ref, used, size=10, identity='compatible-old', legacy=False):
        directory = root / snapshots.runner_cache.ref_key(ref)
        target = directory / identity
        target.mkdir(parents=True, exist_ok=True)
        (target / 'output').write_bytes(b'x' * size)
        if not legacy:
            snapshots.runner_cache.write_marker(directory, dict(ref=ref, bytes=size))
            os.utime(directory / snapshots.runner_cache.MARKER, (used, used))
        os.utime(directory, (used, used))
        return directory

    # test-category: pure-logic
    def test_retention_preserves_main_release_latest_tag_current_and_three_lru(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            refs = ['refs/heads/main', 'refs/heads/release/1', 'refs/tags/v1', 'refs/tags/v2',
                    'refs/pull/1/merge', *[f'refs/heads/feature-{i}' for i in range(6)]]
            directories = [self.seed(root, ref, i + 1, legacy=i < 2) for i, ref in enumerate(refs)]
            target = snapshots.runner_cache.prepare(root, refs[4], 'compatible-old', refs[:2])
            kept = [True, True, False, True, True, False, False, False, True, True, True]
            self.assertEqual([directory.exists() for directory in directories], kept)
            self.assertTrue(target.is_dir())
            self.assertGreater((target.parent / snapshots.runner_cache.MARKER).stat().st_mtime, 11)

    # test-category: security
    def test_legacy_ref_names_recovered_from_remote_only_during_migration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            release = 'refs/heads/release/2'
            tag = 'refs/tags/v2'
            self.seed(root, release, 1, legacy=True)
            self.seed(root, tag, 2, legacy=True)
            with patch.object(snapshots.subprocess, 'check_output', return_value=f'a {release}\nb {tag}\n') as lookup:
                refs = snapshots.legacy_refs(root)
                self.assertEqual(refs, [release, tag])
                self.assertIn('ls-remote', lookup.call_args.args[0])
            snapshots.runner_cache.prepare(root, 'refs/heads/current', 'compatible-new', refs)
            self.assertTrue((root / snapshots.runner_cache.ref_key(release)).exists())
            self.assertTrue((root / snapshots.runner_cache.ref_key(tag)).exists())
            with patch.object(snapshots.subprocess, 'check_output', side_effect=AssertionError('warm network')):
                self.assertEqual(snapshots.legacy_refs(root), [])

    # test-category: pure-logic
    def test_size_cap_evicts_lru_even_release_but_never_main_or_current(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            refs = ['refs/heads/main', 'refs/heads/current', 'refs/heads/release/old',
                    'refs/tags/v1', 'refs/heads/newer']
            directories = [self.seed(root, ref, i + 1, 100) for i, ref in enumerate(refs)]
            with patch.dict(os.environ, BUTLER_PERSISTENT_TARGET_MAX_GB=str(310 / 1024**3)):
                snapshots.runner_cache.prepare(root, refs[1], 'compatible-old')
            self.assertEqual([directory.exists() for directory in directories], [True, True, False, False, True])

    # test-category: pure-logic
    def test_protected_refs_over_cap_warn_without_deleting_active_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            main = self.seed(root, 'refs/heads/main', 1, 100)
            current = self.seed(root, 'refs/heads/current', 2, 100)
            with patch.dict(os.environ, BUTLER_PERSISTENT_TARGET_MAX_GB=str(10 / 1024**3)), \
                    contextlib.redirect_stderr(io.StringIO()) as messages:
                snapshots.runner_cache.prepare(root, 'refs/heads/current', 'compatible-old')
            self.assertTrue(main.exists())
            self.assertTrue((current / 'compatible-old/output').exists())
            self.assertIn('Protected main/current', messages.getvalue())

    # test-category: pure-logic
    def test_prunes_identities_and_uses_estimate_without_walking_warm_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            current = self.seed(root, 'refs/heads/current', 1)
            other = self.seed(root, 'refs/heads/other', 2)
            newer = other / 'compatible-new'
            newer.mkdir()
            os.utime(other / 'compatible-old', (1, 1))
            os.utime(newer, (2, 2))
            target = snapshots.runner_cache.prepare(root, 'refs/heads/current', 'compatible-current')
            self.assertFalse((current / 'compatible-old').exists())
            self.assertFalse((other / 'compatible-old').exists())
            self.assertTrue(newer.exists())
            snapshots.runner_cache.record_size(root, target)
            with patch.object(snapshots.runner_cache, 'tree_bytes', side_effect=AssertionError('warm walk')):
                self.assertEqual(snapshots.runner_cache.prepare(root, 'refs/heads/current', target.name), target)

    # test-category: security
    def test_outside_namespace_and_namespace_itself_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = root / 'cache'
            base.mkdir()
            sentinel = root / 'outside'
            sentinel.write_text('keep')
            for path in [root, sentinel, base, base / '..' / 'outside']:
                with self.assertRaisesRegex(ValueError, 'outside namespace'):
                    snapshots.runner_cache.remove_tree(base, path)
            with self.assertRaisesRegex(ValueError, 'identity'):
                snapshots.runner_cache.prepare(base, 'refs/heads/current', '../../outside')
            self.assertEqual(sentinel.read_text(), 'keep')

    # test-category: security
    def test_link_or_junction_is_never_followed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = root / 'cache'
            base.mkdir()
            outside = root / 'outside'
            outside.mkdir()
            sentinel = outside / 'keep'
            sentinel.write_text('preserved')
            link = base / 'linked'
            if os.name == 'nt':
                subprocess.run(['cmd', '/d', '/c', 'mklink', '/J', str(link), str(outside)], check=True)
            else:
                link.symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'Linked Cargo ref'):
                snapshots.runner_cache.prepare(base, 'refs/heads/current', 'compatible-new')
            with self.assertRaisesRegex(ValueError, 'ancestor contains a link'):
                snapshots.runner_cache.remove_tree(base, link / 'keep')
            with self.assertRaisesRegex(ValueError, 'namespace contains a link'):
                snapshots.runner_cache.prepare(link, 'refs/heads/current', 'compatible-new')
            with self.assertRaisesRegex(ValueError, 'namespace contains a link'):
                snapshots.runner_cache.remove_tree(link, link / 'keep')
            self.assertEqual(snapshots.runner_cache.tree_bytes(link), 0)
            self.assertEqual(snapshots.runner_cache.remove_tree(base, link), 0)
            self.assertFalse(link.exists())
            self.assertEqual(sentinel.read_text(), 'preserved')

    # test-category: security
    def test_nested_read_only_long_paths_deleted_and_freed_bytes_logged(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            directory = base / 'old'
            deep = directory.joinpath(*(['long-directory-name'] * 18))
            deep.mkdir(parents=True)
            output = deep / 'output'
            output.write_bytes(b'complete outputs')
            output.chmod(0o444)
            with contextlib.redirect_stderr(io.StringIO()) as messages:
                snapshots.runner_cache.evict(base, directory, 'size cap')
            self.assertFalse(directory.exists())
            self.assertIn('bytes freed=16', messages.getvalue())

    # test-category: pure-logic
    def test_dependency_cache_reports_sizes_and_clears_only_oversize(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            for name, size in [('npm', 50), ('bun', 150), ('nuget', 250)]:
                (base / name).mkdir()
                (base / name / 'package').write_bytes(b'x' * size)
            with patch.dict(os.environ, OWNER_CACHE_ROOT=str(base),
                            BUTLER_DEPENDENCY_CACHE_MAX_GB=str(100 / 1024**3)), \
                    contextlib.redirect_stderr(io.StringIO()) as messages:
                snapshots.runner_cache.auxiliary_caches()
            self.assertTrue((base / 'npm/package').exists())
            self.assertFalse((base / 'bun').exists())
            self.assertFalse((base / 'nuget').exists())
            for name, size in [('npm', 50), ('bun', 150), ('nuget', 250)]:
                self.assertIn(f'{name} cache measured bytes={size}', messages.getvalue())

    # test-category: security
    def test_size_and_eviction_reach_paths_past_windows_max_path(self):
        with tempfile.TemporaryDirectory() as temporary, windows_max_path():
            base = Path(temporary) / 'cache'
            target = snapshots.runner_cache.prepare(base, 'refs/heads/current', 'compatible-current')
            directory = target.parent
            deep = target.joinpath('debug', '.fingerprint', *(['long-directory-name'] * 14))
            output = deep / 'dep-lib-long-crate-name'
            self.assertGreater(len(str(output)), MAX_PATH)
            os.makedirs(snapshots.runner_cache.extended(deep))
            with open(snapshots.runner_cache.extended(output), 'wb') as file:
                file.write(b'complete outputs')
            if os.name != 'nt':
                with self.assertRaises(FileNotFoundError):
                    os.stat(output)
            marker = os.stat(snapshots.runner_cache.extended(directory / snapshots.runner_cache.MARKER)).st_size
            with contextlib.redirect_stderr(io.StringIO()) as messages:
                snapshots.runner_cache.record_size(base, target)
            self.assertIn(f'measured bytes={marker + 16}', messages.getvalue())
            self.assertEqual(snapshots.runner_cache.read_marker(directory)['bytes'], marker + 16)
            with contextlib.redirect_stderr(io.StringIO()) as messages:
                snapshots.runner_cache.evict(base, directory, 'size cap')
            self.assertFalse(snapshots.runner_cache.lexists(directory))
            self.assertIn('bytes freed=', messages.getvalue())

    # test-category: security
    def test_snapshot_restore_replaces_target_past_windows_max_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            produced = root / 'produced'
            (produced / 'release').mkdir(parents=True)
            (produced / 'release' / 'app').write_bytes(b'restored outputs')
            expected = dict(schema=2, kind='native', platform='windows-x64')
            target = root / 'runner-cache' / 'compatible-windows-x64'
            env = dict(CARGO_TARGET_DIR=str(target), GITHUB_WORKSPACE=str(root), GITHUB_OUTPUT=str(root / 'output'))
            with patch.dict(os.environ, env), patch.object(snapshots.cache, 'output', return_value='a' * 40):
                snapshots.cache.record(root / 'snapshot', expected, target=produced)
            stale = target.joinpath('debug', '.fingerprint', *(['long-directory-name'] * 14), 'dep-lib-long-crate-name')
            self.assertGreater(len(str(stale)), MAX_PATH)
            with windows_max_path(), patch.dict(os.environ, env), contextlib.redirect_stdout(io.StringIO()):
                os.makedirs(snapshots.runner_cache.extended(stale.parent))
                with open(snapshots.runner_cache.extended(stale), 'wb') as file:
                    file.write(b'stale outputs')
                snapshots.restore_tree(root / 'snapshot', expected)
                self.assertFalse(snapshots.runner_cache.lexists(target / 'debug'))
                self.assertEqual((target / 'release' / 'app').read_bytes(), b'restored outputs')

    # test-category: security
    def test_snapshot_restore_extracts_units_past_windows_max_path_below_stage(self):
        """Units within MAX_PATH as names still pass it once joined to the restore stage."""
        def tree(path):
            return {os.path.relpath(os.path.join(directory, name), path):
                    Path(directory, name).read_bytes() if name in files else None
                    for directory, folders, files in os.walk(path) for name in folders + files}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            # Owner runner stage directories are about 100 characters long.
            target = root / ('p' * (90 - len(str(root)))) / 'runner-cache' / 'compatible-windows-x64'
            produced = root / 'produced'
            unit = 'x86_64-pc-windows-msvc/release/build/datafusion-functions-aggregate-common-' + 'a' * 16
            deep = produced.joinpath(*unit.split('/'), 'out', *(['nested-build-output'] * 4))
            deep.mkdir(parents=True)
            (deep / 'generated.rs').write_bytes(b'generated by build script')
            # Cargo hard-links outputs across nested directories; the link member names its source.
            deps = produced / 'x86_64-pc-windows-msvc' / 'release' / 'deps' / 'nested'
            deps.mkdir(parents=True)
            os.link(deep / 'generated.rs', deps / 'generated.rs')
            (produced / 'release').mkdir()
            (produced / 'release' / 'app').write_bytes(b'restored outputs')
            member = 'target/' + os.path.relpath(deep / 'generated.rs', produced)
            stage = len(str(target.parent / 'tmp12345678'))
            self.assertLess(len(member), MAX_PATH)
            self.assertGreater(stage + 1 + len(member), MAX_PATH)
            expected = dict(schema=2, kind='native', platform='windows-x64')
            env = dict(CARGO_TARGET_DIR=str(target), GITHUB_WORKSPACE=str(root), GITHUB_OUTPUT=str(root / 'output'))
            with patch.dict(os.environ, env), patch.object(snapshots.cache, 'output', return_value='a' * 40):
                snapshots.cache.record(root / 'snapshot', expected, target=produced)
            with windows_max_path(), patch.dict(os.environ, env), contextlib.redirect_stdout(io.StringIO()):
                snapshots.restore_tree(root / 'snapshot', expected)
            self.assertEqual(tree(target), tree(produced))
            restored = [target / os.path.relpath(path / 'generated.rs', produced) for path in (deep, deps)]
            self.assertTrue(os.path.samefile(*restored))
            self.assertEqual(os.listdir(target.parent), ['compatible-windows-x64'])

    # test-category: security
    def test_snapshot_record_reads_target_past_windows_max_path(self):
        """Persistent owner targets put the longest Cargo unit paths past MAX_PATH."""
        def unit(profile, name, value, mtime):
            directory = profile / '.fingerprint' / name
            directory.mkdir(parents=True)
            (directory / 'lib-x.json').write_text(json.dumps(dict(rustc=1, profile=2, local=[], deps=[])))
            (directory / 'lib-x').write_text(value)
            os.utime(directory / 'lib-x', (mtime, mtime))
            (directory / 'dep-lib-datafusion_functions_aggregate').write_bytes(b'dep info')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            target = root.joinpath('runner-cache', *(['long-directory-name'] * 6), 'compatible-windows-x64')
            profile = target / 'x86_64-pc-windows-msvc' / 'release'
            unit(profile, 'datafusion-functions-aggregate-' + 'a' * 16, '1' * 16, 200)
            unit(profile, 'datafusion-functions-aggregate-' + 'b' * 16, '2' * 16, 100)  # Superseded.
            live = 'x86_64-pc-windows-msvc/release/.fingerprint/datafusion-functions-aggregate-' + 'a' * 16
            self.assertGreater(len(str(target / live / 'dep-lib-datafusion_functions_aggregate')), MAX_PATH)
            env = dict(GITHUB_WORKSPACE=str(root), GITHUB_OUTPUT=str(root / 'output'))
            with windows_max_path(), patch.dict(os.environ, env), \
                    patch.object(snapshots.cache, 'output', return_value='a' * 40), \
                    contextlib.redirect_stdout(io.StringIO()) as messages:
                snapshots.cache.record(root / 'snapshot', dict(platform='windows-x64'), target=target)
            self.assertNotIn('Keeping every Cargo unit', messages.getvalue())
            with subprocess.Popen(['zstd', '-d', '-c', str(root / 'snapshot' / 'cache.tar.zst')],
                                  stdout=subprocess.PIPE) as stream, \
                    tarfile.open(fileobj=stream.stdout, mode='r|') as archive:
                archived = {member.name: archive.extractfile(member).read() if member.isfile() else None
                            for member in archive}
            self.assertEqual(archived[f'target/{live}/dep-lib-datafusion_functions_aggregate'], b'dep info')
            self.assertEqual(archived[f'target/{live}/lib-x'], b'1' * 16)
            superseded = live.replace('a' * 16, 'b' * 16)
            self.assertFalse([name for name in archived if name.startswith(f'target/{superseded}')])


if __name__ == '__main__':
    unittest.main()
