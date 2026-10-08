#!/usr/bin/env python3
"""Dry-run native SDK download, integrity validation and original build fallback."""
import copy
import hashlib
import http.server
import io
import importlib.util
import json
import os
import subprocess
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
        self.msvc = {"vc_tools_version": "14.44.35207", "ucrt_version": "10.0.26100.0",
                     "compiler_sha256": "cl", "stl_crt_sha256": {"stl_static": "stl"}}
        identity = patch.object(sdk.host, "visual_studio_identity", return_value=self.msvc)
        identity.start()
        self.addCleanup(identity.stop)
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
    def test_windows_restore_uses_real_deps_without_copy_or_link(self):
        target = 'windows-x64'
        lock = recipe.target_lock(json.loads(recipe.LOCK.read_text()), target)
        for name, entry in lock['sources'].items():
            entry['sha256'] = hashlib.sha256(name.encode()).hexdigest()
        fingerprint = sdk.key(recipe.SCRIPT, lock, target)
        producer = self.root / 'producer'
        producer.mkdir()
        with patch.object(sdk.sys, 'platform', 'win32'), \
                patch.object(Path, 'symlink_to', side_effect=PermissionError('WinError 1314')) as link, \
                patch.object(sdk.shutil, 'copytree', side_effect=PermissionError('WinError 5')) as duplicate, \
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
            duplicate.assert_not_called()
            self.assertFalse((restored / 'build/_deps').exists())
            self.assertFalse(any(path.is_symlink() for path in restored.rglob('*')))
            dependency = restored / 'build/Release/_deps/onnx-build/onnx.lib'
            dependency.write_bytes(b'tampered dependency')
            with self.assertRaisesRegex(RuntimeError, 'output digest mismatch'):
                recipe.adopt(restored, fingerprint, lock, target)

    # test-category: security
    def test_windows_source_checkout_links_are_never_traversed(self):
        release = self.root / 'build/Release'
        source = release / '_deps/flatbuffers-src/java/src/test/java'
        source.mkdir(parents=True)
        (source / 'DictionaryLookup').symlink_to('missing-fixture', target_is_directory=True)
        with patch.object(sdk.sys, 'platform', 'win32'), \
                patch.object(sdk.shutil, 'copytree', side_effect=PermissionError('WinError 5')), \
                patch.object(Path, 'symlink_to', side_effect=PermissionError('WinError 1314')):
            sdk.create_deps_alias(release.parent)
            sdk.verify_deps_alias(release)
        self.assertFalse((release.parent / '_deps').exists())

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
        for name in ('prepare-static-ort.py', 'static_ort_host.py', 'static_ort_targets.py',
                     'static_ort_build.py', 'static_ort_prebuilt.py', 'static-ort-key-compat.json'):
            (script_dir / name).write_bytes((SCRIPTS / name).read_bytes())
        (self.root / 'rust-toolchain.toml').write_bytes((SCRIPTS.parent / 'rust-toolchain.toml').read_bytes())
        self.assertEqual(self.fingerprint, sdk.key(script, self.lock, 'linux-x64'))
        script.write_text(script.read_text() + '\n# recipe change\n')
        self.assertEqual(self.fingerprint, sdk.key(script, self.lock, 'linux-x64'))
        for name in ('static_ort_prebuilt.py', 'static_ort_host.py'):
            path = script_dir / name
            path.write_text(path.read_text() + '\n# placement/provenance change\n')
            self.assertEqual(self.fingerprint, sdk.key(script, self.lock, 'linux-x64'))
        build = script_dir / 'static_ort_build.py'
        build.write_text(build.read_text().replace('onnxruntime_MINIMAL_BUILD=OFF',
                                                    'onnxruntime_MINIMAL_BUILD=ON'))
        self.assertNotEqual(self.fingerprint, sdk.key(script, self.lock, 'linux-x64'))

    # test-category: format-pin
    def test_unchanged_build_inputs_keep_published_fingerprints(self):
        compatibility = json.loads((SCRIPTS / 'static-ort-key-compat.json').read_text())
        lock = json.loads(recipe.LOCK.read_text())
        script_dir = self.root / 'scripts'
        script_dir.mkdir()
        for name in ('prepare-static-ort.py', 'static_ort_build.py', 'static_ort_targets.py',
                     'static-ort-key-compat.json'):
            (script_dir / name).write_bytes((SCRIPTS / name).read_bytes())
        # Reproduce the published recipe, rather than equating an upgraded
        # compiler's current inputs with that immutable historical namespace.
        historical = ('[toolchain]\nchannel = "1.91.0"\nprofile = "minimal"\n'
                      'components = ["rustfmt", "clippy"]\n')
        (self.root / 'rust-toolchain.toml').write_text(historical)
        self.assertEqual(hashlib.sha256(historical.encode()).hexdigest(),
                         compatibility['build_recipe']['rust-toolchain.toml'])
        for target in recipe.TARGETS:
            projected = recipe.target_lock(lock, target)
            previous = {'lock': projected, 'target': target,
                        'recipe': compatibility['published_recipe']}
            if target == 'windows-x64':
                previous['msvc'] = self.msvc
            expected = hashlib.sha256(json.dumps(previous, sort_keys=True).encode()).hexdigest()
            self.assertEqual(sdk.key(script_dir / recipe.SCRIPT.name, projected, target), expected)
            self.assertNotEqual(sdk.key(recipe.SCRIPT, projected, target), expected,
                                'the Rust upgrade must invalidate the historical SDK key')

    # test-category: security
    def test_windows_key_covers_selected_toolset_stl_and_crt(self):
        lock = recipe.target_lock(json.loads(recipe.LOCK.read_text()), 'windows-x64')
        original = sdk.key(recipe.SCRIPT, lock, 'windows-x64')
        for field, value in [('vc_tools_version', '14.51.36231'),
                             ('ucrt_version', '10.0.28000.0'),
                             ('compiler_sha256', 'different compiler'),
                             ('stl_crt_sha256', {'stl_static': 'different STL'})]:
            changed = {**self.msvc, field: value}
            with patch.object(sdk.host, 'visual_studio_identity', return_value=changed):
                self.assertNotEqual(original, sdk.key(recipe.SCRIPT, lock, 'windows-x64'))
        with patch.object(sdk.host, 'visual_studio_identity', side_effect=RuntimeError('no toolset')):
            with self.assertRaisesRegex(RuntimeError, 'no toolset'):
                sdk.key(recipe.SCRIPT, lock, 'windows-x64')
        legacy = {'lock': lock, 'target': 'windows-x64',
                  'recipe': json.loads((SCRIPTS / 'static-ort-key-compat.json').read_text())['published_recipe']}
        self.assertNotEqual(original, hashlib.sha256(json.dumps(legacy, sort_keys=True).encode()).hexdigest())

    # test-category: security
    def test_windows_key_miss_builds_locally_and_other_toolset_cache_is_rejected(self):
        target = 'windows-x64'
        lock = recipe.target_lock(json.loads(recipe.LOCK.read_text()), target)
        for name, entry in lock['sources'].items():
            entry['sha256'] = hashlib.sha256(name.encode()).hexdigest()
        original = sdk.key(recipe.SCRIPT, lock, target)
        with patch.object(sdk.sys, 'platform', 'win32'), \
                patch.object(sdk, 'release', return_value=None), \
                patch.object(recipe.host, 'host_identity', return_value={'msvc': self.msvc}), \
                patch.object(recipe, 'prepare', side_effect=self.build) as build:
            complete = recipe.prepare_cache(self.root, original, lock, target, False, False)
            build.assert_called_once()
            with patch.object(sdk.host, 'visual_studio_identity',
                              return_value={**self.msvc, 'vc_tools_version': '14.51.36231'}):
                other = sdk.key(recipe.SCRIPT, lock, target)
            with self.assertRaisesRegex(RuntimeError, 'fingerprint mismatch'):
                recipe.adopt(complete, other, lock, target)

    # test-category: pure-logic
    def test_windows_ci_key_miss_allows_local_build_and_protoc_needs_no_msvc(self):
        for target, flags, required in [('windows-x64', [], False),
                                        ('windows-x64', ['--require-prebuilt'], True),
                                        ('linux-x64', [], True)]:
            with patch.object(recipe.sys, 'argv', ['prepare-static-ort.py', *flags]), \
                    patch.object(recipe, 'host_target', return_value=target), \
                    patch.object(recipe.host, 'rust_identity'), \
                    patch.object(recipe, 'root_for_target', return_value=self.root), \
                    patch.dict(os.environ, GITHUB_ACTIONS='true'), \
                    patch.object(recipe, 'prepare_cache', return_value=self.root) as prepare:
                recipe.main()
                self.assertEqual(prepare.call_args.args[-1], required)
        with patch.object(recipe.sys, 'argv', ['prepare-static-ort.py', '--protoc-only']), \
                patch.object(recipe, 'host_target', return_value='windows-x64'), \
                patch.object(recipe.host, 'rust_identity'), \
                patch.object(recipe, 'root_for_target', return_value=self.root), \
                patch.object(recipe, 'prepare_protoc', return_value=self.root / 'protoc'), \
                patch.object(sdk.host, 'visual_studio_identity', side_effect=AssertionError('no MSVC')):
            recipe.main()

    # test-category: security
    def test_msvc_identity_uses_selected_environment_and_all_stl_crt_digests(self):
        tools = self.root / '14.44.35207'
        ucrt = self.root / 'sdk'
        paths = ['include/yvals_core.h', 'include/vcruntime.h', 'lib/x64/libcpmt.lib',
                 'lib/x64/msvcprt.lib', 'lib/x64/libcmt.lib', 'lib/x64/vcruntime.lib',
                 'lib/x64/libvcruntime.lib',
                 'bin/Hostx64/x64/cl.exe']
        for name in paths:
            path = tools / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(name.encode())
        for name in ['Include/10.0.26100.0/ucrt/corecrt.h', 'Lib/10.0.26100.0/ucrt/x64/libucrt.lib',
                     'Lib/10.0.26100.0/ucrt/x64/ucrt.lib']:
            path = ucrt / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(name.encode())
        compiler = tools / paths[-1]
        environment = dict(VCToolsVersion=tools.name, VCToolsInstallDir=str(tools),
                           UCRTVersion='10.0.26100.0', UniversalCRTSdkDir=str(ucrt))
        # Restore the real function temporarily: setUp mocks it for cross-platform key tests.
        spec = importlib.util.spec_from_file_location('host_fixture', SCRIPTS / 'static_ort_host.py')
        host = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host)
        with patch.dict(os.environ, environment), patch.object(host.shutil, 'which', return_value=str(compiler)), \
                patch.object(host.subprocess, 'run') as banner:
            banner.return_value.stdout, banner.return_value.stderr = '', 'MSVC fixture version'
            selected = host.visual_studio_identity()
            self.assertEqual(selected['vc_tools_version'], tools.name)
            self.assertEqual(len(selected['stl_crt_sha256']), 10)
            (tools / paths[0]).write_bytes(b'changed STL')
            self.assertNotEqual(selected, host.visual_studio_identity())
            with patch.dict(os.environ, VCToolsVersion='14.51.36231'):
                with self.assertRaisesRegex(RuntimeError, 'does not match'):
                    host.visual_studio_identity()
            with patch.dict(os.environ, VCToolsVersion=''):
                self.assertEqual(host.visual_studio_identity()['vc_tools_version'], tools.name)
            banner.assert_not_called()

    # test-category: pure-logic
    def test_toolset_version_fallback_reads_korean_header_as_bytes(self):
        tools = self.root / 'selected-toolset'
        (tools / 'include').mkdir(parents=True)
        header = tools / 'include/yvals_core.h'
        with patch.dict(os.environ, VCToolsVersion=''):
            for macro in ('_MSVC_STL_UPDATE', '_MSVC_STL_VERSION'):
                header.write_bytes('한국어 주석'.encode('cp949') +
                                   f'\n#define {macro} 202506L\n'.encode('ascii'))
                self.assertEqual(sdk.host.toolset_version(tools), f'{macro}=202506')
            header.write_bytes(b'no version macros')
            with self.assertRaisesRegex(RuntimeError, 'Missing MSVC toolset identity'):
                sdk.host.toolset_version(tools)
            header.unlink()
            with self.assertRaisesRegex(RuntimeError, 'cannot read yvals_core.h'):
                sdk.host.toolset_version(tools)
        with patch.dict(os.environ, VCToolsVersion='14.44.35207'):
            self.assertEqual(sdk.host.toolset_version(tools), '14.44.35207')

    # test-category: pure-logic
    def test_subprocess_korean_banner_ignores_locale_codepage(self):
        # Monkeypatch the process boundary with both UTF-8 and cp949 banner bytes.
        for stream in ('한국어 Microsoft C/C++ 컴파일러'.encode('utf-8'),
                       '한국어 Microsoft C/C++ 컴파일러'.encode('cp949')):
            def run(args, **kwargs):
                self.assertEqual(kwargs['encoding'], 'utf-8')
                self.assertEqual(kwargs['errors'], 'replace')
                output = stream.decode(kwargs['encoding'], kwargs['errors'])
                return subprocess.CompletedProcess(args, 0, output, '')
            with patch.object(sdk.host.subprocess, 'run', side_effect=run):
                self.assertIn('Microsoft C/C++', sdk.host.command(['cl.exe']))

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
        with patch.dict(os.environ, HOME=str(self.root), GITHUB_ACTOR='fixture-actor', GH_TOKEN='stub-token',
                        BUTLER_ORAS_EXECUTABLE=str(self.root / 'oras.exe')), \
                patch.object(sdk.ci_oci.subprocess, 'run', return_value=completed) as invoke:
            sdk.ci_oci.authenticate()
            arguments = invoke.call_args.args[0]
            config = str(self.root / 'oras-auth.json')
            self.assertEqual(arguments[arguments.index('--registry-config') + 1], config)
            self.assertEqual(os.environ['BUTLER_OCI_AUTH_CONFIG'], config)
            self.assertEqual(invoke.call_args.kwargs['input'], 'stub-token')
            self.assertNotIn('stub-token', arguments)
            self.assertEqual(arguments[0], str(self.root / 'oras.exe'))

    # test-category: security
    def test_unsafe_archive_is_rejected(self):
        archive = self.root / 'unsafe.zip'
        with zipfile.ZipFile(archive, 'w') as output:
            output.writestr('../escape', b'bad')
        with self.assertRaisesRegex(RuntimeError, 'Unsafe native archive'):
            sdk.unpack(archive, self.root)


if __name__ == '__main__':
    unittest.main()
