#!/usr/bin/env python3
"""Dry-run native SDK download, integrity validation and original build fallback."""
import copy
import hashlib
import http.server
import io
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import zipfile

SCRIPTS = Path(__file__).resolve().parents[2] / 'packages/butler-agent/rust/scripts'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('recipe', SCRIPTS / 'prepare-static-ort.py')
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)
sdk = recipe.prebuilt


class NativeDeps(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.lock = recipe.target_lock(json.loads(recipe.LOCK.read_text()), 'linux-x64')
        for name, entry in self.lock['sources'].items():
            entry['sha256'] = hashlib.sha256(name.encode()).hexdigest()
        self.fingerprint = sdk.key(recipe.SCRIPT, self.lock, 'linux-x64')

    def build(self, stage, lock, target):
        release = stage / 'build/Release'
        release.mkdir(parents=True)
        libraries = [recipe.TARGETS[target]['static_lib'].format(f'onnxruntime_{name}')
                     for name in recipe.EXPECTED_ORT_LIBS]
        libraries.extend(recipe.TARGETS[target]['deps'])
        for name in libraries:
            path = release / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(name.encode())
        (release / 'CMakeCache.txt').write_text('\n'.join((
            'onnxruntime_BUILD_UNIT_TESTS:BOOL=OFF', 'onnxruntime_BUILD_SHARED_LIB:BOOL=OFF',
            'onnxruntime_MINIMAL_BUILD:BOOL=OFF')))
        for name, filename in recipe.archive_names(target).items():
            path = stage / 'downloads' / filename
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(name.encode())
        sdk.create_deps_alias(stage / 'build')
        protoc = stage / f"tools/protoc/bin/protoc{recipe.TARGETS[target]['exe']}"
        protoc.parent.mkdir(parents=True)
        protoc.write_bytes(b'pinned protoc')
        protoc.chmod(0o755)
        return release, protoc

    def source_cache(self):
        cache = self.root / 'producer'
        cache.mkdir()
        with patch.object(sdk, 'release', return_value=None), \
                patch.object(recipe.host, 'host_identity', return_value={'producer': 'fixture'}), \
                patch.object(recipe, 'prepare', side_effect=self.build) as build:
            complete = recipe.prepare_cache(cache, self.fingerprint, self.lock, 'linux-x64', False, False)
            build.assert_called_once()
        recipe.adopt(complete, self.fingerprint, self.lock, 'linux-x64')
        return complete

    def serve(self, archive):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(archive.read_bytes())

            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        def close():
            server.shutdown()
            thread.join()
            server.server_close()
        self.addCleanup(close)
        return {'url': f'http://127.0.0.1:{server.server_port}/sdk.zip',
                'size': archive.stat().st_size, 'digest': f'sha256:{recipe.sha256(archive)}'}

    # test-category: security
    def test_download_extract_and_hash_check_without_rebuild(self):
        complete = self.source_cache()
        archive = self.root / 'sdk.zip'
        sdk.pack(complete, archive)
        entry = self.serve(archive)
        consumer = self.root / 'consumer'
        consumer.mkdir()
        started = time.monotonic()
        with patch.object(sdk, 'release', return_value=entry), \
                patch.object(recipe, 'prepare', side_effect=AssertionError('must not rebuild')):
            restored = recipe.prepare_cache(consumer, self.fingerprint, self.lock, 'linux-x64', False, True)
            recipe.adopt(restored, self.fingerprint, self.lock, 'linux-x64')
            self.assertEqual(recipe.verified_outputs(complete / 'build/Release', 'linux-x64'),
                             recipe.verified_outputs(restored / 'build/Release', 'linux-x64'))
            self.assertEqual((restored / 'tools/protoc/bin/protoc').read_bytes(), b'pinned protoc')
            self.assertTrue((restored / 'tools/protoc/bin/protoc').stat().st_mode & 0o111)
            (restored / 'build/Release/libonnxruntime_common.a').write_bytes(b'tampered')
            with self.assertRaisesRegex(RuntimeError, 'output digest mismatch'):
                recipe.prepare_cache(consumer, self.fingerprint, self.lock, 'linux-x64', False, True)
        print(f'Fake asset: {entry["size"]} bytes; complete download/extract/verify {time.monotonic()-started:.3f}s')

    # test-category: security
    def test_windows_restore_copies_every_byte_without_symlink_privileges(self):
        target = 'windows-x64'
        lock = recipe.target_lock(json.loads(recipe.LOCK.read_text()), target)
        for name, entry in lock['sources'].items():
            entry['sha256'] = hashlib.sha256(name.encode()).hexdigest()
        fingerprint = sdk.key(recipe.SCRIPT, lock, target)
        producer = self.root / 'producer'
        producer.mkdir()
        with patch.object(sdk.sys, 'platform', 'win32'), \
                patch.object(Path, 'symlink_to', side_effect=PermissionError('WinError 1314')) as link, \
                patch.object(sdk, 'release', return_value=None), \
                patch.object(recipe.host, 'host_identity', return_value={'producer': 'fixture'}), \
                patch.object(recipe, 'prepare', side_effect=self.build):
            complete = recipe.prepare_cache(producer, fingerprint, lock, target, False, False)
            archive = self.root / 'windows.zip'
            sdk.pack(complete, archive)
            entry = {'url': 'https://fixture.invalid/sdk.zip', 'size': archive.stat().st_size,
                     'digest': f'sha256:{recipe.sha256(archive)}'}
            consumer = self.root / 'consumer'
            consumer.mkdir()
            with patch.object(sdk, 'release', return_value=entry), \
                    patch.object(sdk, 'request', side_effect=lambda *args, **kwargs: io.BytesIO(archive.read_bytes())), \
                    patch.object(recipe, 'prepare', side_effect=AssertionError('must not rebuild')):
                restored = recipe.prepare_cache(consumer, fingerprint, lock, target, False, True)
                recipe.adopt(restored, fingerprint, lock, target)
            link.assert_not_called()
            with zipfile.ZipFile(archive) as source:
                expected = {item.filename: source.read(item) for item in source.infolist()}
            actual = {path.relative_to(restored).as_posix(): path.read_bytes()
                      for path in restored.rglob('*') if path.is_file()
                      and not path.is_relative_to(restored / 'build/_deps')}
            self.assertEqual(actual, expected)
            self.assertEqual(sdk.deps_content(restored / 'build/_deps'),
                             sdk.deps_content(restored / 'build/Release/_deps'))
            self.assertFalse(any(path.is_symlink() for path in restored.rglob('*')))
            alias = restored / 'build/_deps/onnx-build/onnx.lib'
            alias.write_bytes(b'tampered alias')
            with self.assertRaisesRegex(RuntimeError, 'copy content mismatch'):
                recipe.adopt(restored, fingerprint, lock, target)
            alias.write_bytes((restored / 'build/Release/_deps/onnx-build/onnx.lib').read_bytes())
            (restored / 'build/_deps/extra').write_bytes(b'extra')
            with self.assertRaisesRegex(RuntimeError, 'copy content mismatch'):
                recipe.adopt(restored, fingerprint, lock, target)

    # test-category: security
    def test_asset_digest_mismatch_fails_without_build(self):
        archive = self.root / 'sdk.zip'
        sdk.pack(self.source_cache(), archive)
        entry = self.serve(archive)
        entry['digest'] = 'sha256:' + '0' * 64
        with patch.object(sdk, 'release', return_value=entry), \
                patch.object(recipe, 'prepare', side_effect=AssertionError('must not rebuild')):
            with self.assertRaisesRegex(RuntimeError, 'SHA-256/size mismatch'):
                recipe.prepare_cache(self.root, self.fingerprint, self.lock, 'linux-x64', False, False)
        self.assertFalse((self.root / f'ort-{self.fingerprint}').exists())

    # test-category: security
    def test_missing_asset_falls_back_but_ci_requires_publication(self):
        self.source_cache()
        with patch.object(sdk, 'release', return_value=None), \
                patch.object(recipe, 'prepare', side_effect=AssertionError('must not build in CI')):
            with self.assertRaisesRegex(RuntimeError, 'dispatch native-deps.yml'):
                recipe.prepare_cache(self.root, self.fingerprint, self.lock, 'linux-x64', False, True)

    # test-category: pure-logic
    def test_key_covers_pins_flags_target_and_recipe(self):
        changed = copy.deepcopy(self.lock)
        changed['build']['parallel_jobs'] += 1
        self.assertNotEqual(self.fingerprint, sdk.key(recipe.SCRIPT, changed, 'linux-x64'))
        changed = copy.deepcopy(self.lock)
        changed['sources']['protoc']['sha256'] = 'a' * 64
        self.assertNotEqual(self.fingerprint, sdk.key(recipe.SCRIPT, changed, 'linux-x64'))
        keys = {sdk.key(recipe.SCRIPT, self.lock, target) for target in recipe.TARGETS}
        self.assertEqual(len(keys), 4)
        script_dir = self.root / 'scripts'
        script_dir.mkdir()
        script = script_dir / recipe.SCRIPT.name
        for name in ('prepare-static-ort.py', 'static_ort_host.py', 'static_ort_targets.py'):
            (script_dir / name).write_bytes((SCRIPTS / name).read_bytes())
        (self.root / 'rust-toolchain.toml').write_bytes((SCRIPTS.parent / 'rust-toolchain.toml').read_bytes())
        self.assertEqual(self.fingerprint, sdk.key(script, self.lock, 'linux-x64'))
        script.write_text(script.read_text() + '\n# recipe change\n')
        self.assertNotEqual(self.fingerprint, sdk.key(script, self.lock, 'linux-x64'))

    # test-category: security
    def test_inner_archive_and_protoc_digests_remain_required(self):
        complete = self.source_cache()
        protoc = complete / 'tools/protoc/bin/protoc'
        protoc.write_bytes(b'changed protoc')
        with self.assertRaisesRegex(RuntimeError, 'protoc mismatch'):
            recipe.adopt(complete, self.fingerprint, self.lock, 'linux-x64')
        protoc.write_bytes(b'pinned protoc')
        (complete / 'downloads/protoc.zip').write_bytes(b'changed pinned archive')
        with self.assertRaisesRegex(RuntimeError, 'archive digest mismatch'):
            recipe.adopt(complete, self.fingerprint, self.lock, 'linux-x64')

    # test-category: security
    def test_published_key_is_never_rebuilt_or_overwritten(self):
        with patch.object(sdk, 'release', return_value={'published': True}), \
                patch.object(sdk.subprocess, 'check_output', return_value=self.fingerprint), \
                patch.object(sdk.subprocess, 'run') as mutate:
            sdk.publish(recipe.SCRIPT, 'linux-x64')
            mutate.assert_not_called()

    # test-category: security
    def test_native_sdk_local_oci_roundtrip_and_missing_tag(self):
        import os
        archive = self.root / sdk.names(self.fingerprint, 'linux-x64')[1]
        complete = self.source_cache()
        sdk.pack(complete, archive)
        layout = str(self.root / 'oci')
        with patch.dict(os.environ, BUTLER_OCI_LAYOUT='1'), patch.object(sdk.ci_oci, 'REGISTRY', layout):
            reference = f'{layout}/native-deps:linux-x64-{self.fingerprint}'
            sdk.ci_oci.push(reference, [archive])
            pulled = self.root / 'pulled'
            sdk.ci_oci.checked('pull', reference, '--output', str(pulled))
            self.assertEqual((pulled / archive.name).read_bytes(), archive.read_bytes())
            consumer = self.root / 'consumer'
            consumer.mkdir()
            restored = recipe.prepare_cache(consumer, self.fingerprint, self.lock, 'linux-x64', False, True)
            recipe.adopt(restored, self.fingerprint, self.lock, 'linux-x64')
            self.assertEqual(recipe.verified_outputs(restored / 'build/Release', 'linux-x64'),
                             recipe.verified_outputs(complete / 'build/Release', 'linux-x64'))
            self.assertIsNone(sdk.release('0' * 64, 'linux-x64'))
            with patch.object(sdk.subprocess, 'check_output', return_value=self.fingerprint), \
                    patch.object(sdk.ci_oci, 'push', side_effect=AssertionError('overwrite')):
                sdk.publish(recipe.SCRIPT, 'linux-x64')

    # test-category: security
    def test_migration_refuses_cleanup_before_verification_and_preserves_product_releases(self):
        import os
        migration_spec = importlib.util.spec_from_file_location('migration', Path(__file__).with_name('migrate-ci-releases.py'))
        migration = importlib.util.module_from_spec(migration_spec)
        migration_spec.loader.exec_module(migration)
        with patch.object(migration, 'verify_native', side_effect=ValueError('SDK verification failed')), \
                patch.object(migration.subprocess, 'run') as mutation:
            with self.assertRaisesRegex(ValueError, 'verification failed'):
                migration.cleanup()
            mutation.assert_not_called()
        releases = [[dict(tag_name=tag) for tag in [migration.NATIVE_RELEASES[0], 'cargo-target-key', 'v1.0.0', 'models-bge-m3']]]
        refs = [[dict(ref='refs/tags/' + tag) for tag in ['cargo-target-orphan', 'v1.0.0', 'models-bge-m3']]]
        with patch.dict(os.environ, GITHUB_REPOSITORY='owner/repo'), \
                patch.object(migration, 'verify_native'), patch.object(migration, 'gh', side_effect=[releases, refs]), \
                patch.object(migration.subprocess, 'run') as mutation:
            migration.cleanup()
            self.assertEqual(mutation.call_count, 3)
            arguments = str(mutation.call_args_list)
            self.assertNotIn('v1.0.0', arguments)
            self.assertNotIn('models-bge-m3', arguments)

    # test-category: security
    def test_publisher_credentials_are_explicit_and_readers_ignore_them(self):
        import os
        import subprocess
        config = str(self.root / 'disposable-auth.json')
        completed = subprocess.CompletedProcess([], 0, stdout='', stderr='')
        with patch.dict(os.environ, BUTLER_OCI_AUTH_CONFIG=config), \
                patch.object(sdk.ci_oci.subprocess, 'run', return_value=completed) as invoke:
            sdk.ci_oci.command('manifest', 'fetch', 'ghcr.io/owner/package:key', anonymous=False)
            arguments = invoke.call_args.args[0]
            self.assertEqual(arguments[arguments.index('--registry-config') + 1], config)
            sdk.ci_oci.command('manifest', 'fetch', 'ghcr.io/owner/package:key')
            self.assertNotIn(config, invoke.call_args.args[0])
        with patch.dict(os.environ):
            os.environ.pop('BUTLER_OCI_AUTH_CONFIG', None)
            os.environ.pop('BUTLER_OCI_LAYOUT', None)
            with self.assertRaisesRegex(RuntimeError, 'isolated OCI credential file'):
                sdk.ci_oci.command('push', 'ghcr.io/owner/package:key', anonymous=False)

    # test-category: security
    def test_private_cache_is_unavailable_but_publisher_auth_errors_fail(self):
        import subprocess
        denied = subprocess.CompletedProcess([], 1, stdout='', stderr='unauthorized: authentication required')
        with patch.object(sdk.ci_oci, 'command', return_value=denied):
            self.assertIsNone(sdk.ci_oci.manifest('ghcr.io/owner/package:missing'))
            with self.assertRaisesRegex(RuntimeError, 'OCI manifest lookup failed'):
                sdk.ci_oci.manifest('ghcr.io/owner/package:missing', anonymous=False)
        outage = subprocess.CompletedProcess([], 1, stdout='', stderr='HTTP 500 registry error')
        with patch.object(sdk.ci_oci, 'command', return_value=outage):
            with self.assertRaisesRegex(RuntimeError, 'OCI manifest lookup failed'):
                sdk.ci_oci.manifest('ghcr.io/owner/package:missing')

    # test-category: security
    def test_login_uses_native_disposable_path_and_stdin_without_a_nested_shell(self):
        import os
        import subprocess
        completed = subprocess.CompletedProcess([], 0, stdout='Login Succeeded', stderr='')
        with patch.dict(os.environ, HOME=str(self.root), GITHUB_ACTOR='fixture-actor', GH_TOKEN='stub-token'), \
                patch.object(sdk.ci_oci.subprocess, 'run', return_value=completed) as invoke:
            sdk.ci_oci.authenticate()
            arguments = invoke.call_args.args[0]
            config = str(self.root / 'oras-auth.json')
            self.assertEqual(arguments[arguments.index('--registry-config') + 1], config)
            self.assertEqual(os.environ['BUTLER_OCI_AUTH_CONFIG'], config)
            self.assertEqual(invoke.call_args.kwargs['input'], 'stub-token')
            self.assertNotIn('stub-token', arguments)
            self.assertEqual(arguments[0], 'oras')

    # test-category: security
    def test_unsafe_archive_is_rejected(self):
        archive = self.root / 'unsafe.zip'
        with zipfile.ZipFile(archive, 'w') as output:
            output.writestr('../escape', b'bad')
        with self.assertRaisesRegex(RuntimeError, 'Unsafe native archive'):
            sdk.unpack(archive, self.root)


if __name__ == '__main__':
    unittest.main()
