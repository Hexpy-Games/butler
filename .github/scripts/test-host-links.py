#!/usr/bin/env python3
"""Security checks for native search isolation and shipped loader metadata."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'packages/butler-agent/rust/scripts'
sys.path.insert(0, str(SCRIPTS))
import static_ort_build as build
spec = importlib.util.spec_from_file_location('recipe', SCRIPTS / 'prepare-static-ort.py')
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)


class HostLinks(unittest.TestCase):
    # test-category: security
    def test_macho_loader_metadata(self):
        import check_host_links as guard
        for dependency in ('@rpath/Electron Framework.framework/Electron Framework',
                           '/usr/lib/libSystem.B.dylib',
                           '/System/Library/Frameworks/Foundation.framework/Foundation'):
            loads = f'helper:\n\t{dependency} (compatibility version 1.0.0, current version 1.0.0)\n'
            commands = f'Load command 1\n cmd LC_LOAD_DYLIB\n name {dependency} (offset 24)\n'
            guard.check_macho('Butler Helper (GPU)', loads, commands)
        guard.check_macho('Electron Framework', 'framework:\n',
                          ' cmd LC_RPATH\n path @loader_path/Libraries (offset 12)\n')
        for dependency in ('/opt/homebrew/opt/protobuf/lib/libprotobuf.29.dylib',
                           '/usr/local/lib/libzstd.1.dylib', '/tmp/Helper (GPU)/libbad.dylib'):
            for command in ('LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB',
                            'LC_REEXPORT_DYLIB', 'LC_LOAD_UPWARD_DYLIB'):
                with self.subTest(dependency=dependency, command=command):
                    with self.assertRaisesRegex(RuntimeError, 'outside allowed'):
                        guard.check_macho('Butler Helper (GPU)', 'helper:\n',
                                          f' cmd {command}\n name {dependency} (offset 24)\n')
        with self.assertRaisesRegex(RuntimeError, 'LC_RPATH'):
            guard.check_macho('agent', 'agent:\n', ' cmd LC_RPATH\n path /usr/local/lib (offset 12)\n')
        with self.assertRaisesRegex(RuntimeError, 'outside allowed'):
            guard.check_macho('agent', 'agent:\n\t/usr/local/lib/libzstd.1.dylib (compatibility version 1.0.0)\n', '')

    # test-category: security
    def test_elf_loader_metadata(self):
        import check_host_links as guard
        guard.check_elf('agent', '(NEEDED) Shared library: [libc.so.6]\n(RUNPATH) Library runpath: [$ORIGIN:$ORIGIN/lib:$ORIGIN/../lib]')
        for text in ('(RUNPATH) Library runpath: [/usr/local/lib]',
                     '(RPATH) Library rpath: [$ORIGIN/lib:]',
                     '(NEEDED) Shared library: [/tmp/libbad.so]'):
            with self.subTest(text=text), self.assertRaises(RuntimeError):
                guard.check_elf('agent', text)

    # test-category: security
    def test_inspection_handles_parentheses_and_detects_magic(self):
        import check_host_links as guard
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'Butler Helper (GPU)'
            binary.write_bytes(b'\xcf\xfa\xed\xfe')
            def inspect(args, **kwargs):
                self.assertNotIn('(', args[-1])
                self.assertEqual(Path(args[-1]).resolve(), binary)
                return type('Result', (), {'stdout': 'binary:\n'})()
            with patch.object(guard.subprocess, 'run', side_effect=inspect) as run:
                self.assertEqual(guard.check_path(Path(directory), 'darwin'), 1)
                self.assertEqual(run.call_count, 2)

    # test-category: security
    def test_cmake_cache_roots(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            clean = f'protobuf_DIR:PATH={stage}/build/protobuf\nCMAKE_C_COMPILER_EXECUTABLE:FILEPATH=/usr/bin/cc\nX_INCLUDE_DIRS:PATH=/usr/include;/usr/include/c++\n'
            recipe.check_cmake_cache(clean, stage, 'linux-x64')
            for entry in ('Protobuf_DIR:PATH=/opt/homebrew/lib/cmake/protobuf',
                          'absl_DIR:PATH=/usr/local/lib/cmake/absl',
                          'X_LIBRARIES:STRING=/usr/lib/libc.so;/tmp/libbad.a',
                          're2_DIR:PATH=relative/package'):
                with self.subTest(entry=entry), self.assertRaisesRegex(RuntimeError, 'outside allowed'):
                    recipe.check_cmake_cache(entry, stage, 'linux-x64')

    # test-category: security
    def test_build_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            host = dict(PATH='/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin',
                        CMAKE_PREFIX_PATH='/tmp/pkg', PKG_CONFIG_PATH='/tmp/pkg',
                        protobuf_ROOT='/tmp/pkg', absl_DIR='/tmp/pkg', DYLD_FALLBACK_LIBRARY_PATH='/tmp/pkg',
                        CFLAGS='-I/tmp/pkg', CC='cc', CXX='c++')
            env = build.build_environment(stage, Path('/pinned/cmake'), Path('/pinned/ninja'), 'linux-x64', host)
            for name in ('CMAKE_PREFIX_PATH', 'PKG_CONFIG_PATH', 'protobuf_ROOT', 'absl_DIR', 'DYLD_FALLBACK_LIBRARY_PATH', 'CFLAGS'):
                self.assertNotIn(name, env)
            self.assertNotIn('brew', env['PATH'])
            self.assertTrue(Path(env['CC']).is_absolute())
            self.assertTrue(Path(env['PKG_CONFIG_LIBDIR']).is_dir())
            self.assertIn('FETCHCONTENT_TRY_FIND_PACKAGE_MODE=NEVER', build.ISOLATION_DEFINES)
            windows = build.build_environment(stage, Path('/pinned/cmake'), Path('/pinned/ninja'), 'windows-x64', host)
            self.assertTrue(windows['PATH'].endswith(host['PATH']))

    # test-category: security
    def test_release_preflight(self):
        for name in ('LIBSQLITE3_SYS_USE_PKG_CONFIG', 'ZSTD_SYS_USE_PKG_CONFIG',
                     'RUSTONIG_SYSTEM_LIBONIG', 'RUSTONIG_DYNAMIC_LIBONIG', 'LIBRARY_PATH', 'PKG_CONFIG_PATH'):
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, name):
                recipe.release_env_preflight({name: '1'})
        with self.assertRaisesRegex(RuntimeError, 'ZSTD_SYS_USE_PKG_CONFIG'):
            recipe.release_env_preflight({'ZSTD_SYS_USE_PKG_CONFIG': ''})
        for name in ('RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS'):
            for value in ('-L native=/tmp/pkg', '-L/tmp/pkg', '-Clink-search=/tmp/pkg', '-L\x1fnative=/tmp/pkg'):
                with self.subTest(name=name, value=value), self.assertRaisesRegex(RuntimeError, name):
                    recipe.release_env_preflight({name: value})
        recipe.release_env_preflight({'RUSTFLAGS': '-C link-arg=-fuse-ld=mold -C target-feature=+crt-static'})

    # test-category: security
    def test_preflight_runs_before_full_and_prebuilt_preparation(self):
        for flags in ([], ['--require-prebuilt']):
            with self.subTest(flags=flags), patch.dict(os.environ, PKG_CONFIG_PATH='/tmp/pkg'), \
                    patch.object(sys, 'argv', ['prepare-static-ort.py', *flags]), \
                    patch.object(recipe.host, 'rust_identity', side_effect=AssertionError('too late')):
                with self.assertRaisesRegex(RuntimeError, 'PKG_CONFIG_PATH'):
                    recipe.main()

    # test-category: security
    def test_restored_cache_retains_producer_roots_and_detects_tampering(self):
        import json
        import static_ort_prebuilt as prebuilt
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory) / 'producer'
            release = stage / 'build/Release'
            release.mkdir(parents=True)
            spec = recipe.TARGETS['linux-x64']
            for name in [*(spec['static_lib'].format(f'onnxruntime_{n}') for n in recipe.EXPECTED_ORT_LIBS), *spec['deps']]:
                library = release / name
                library.parent.mkdir(parents=True, exist_ok=True)
                library.write_bytes(b'archive')
            cache = release / 'CMakeCache.txt'
            python = str(Path(directory) / 'python/bin/python3')
            cache.write_text(f'X_DIR:PATH={stage}/sources\nPython_EXECUTABLE:FILEPATH={python}\n' + '\n'.join((
                'onnxruntime_BUILD_UNIT_TESTS:BOOL=OFF', 'onnxruntime_BUILD_SHARED_LIB:BOOL=OFF',
                'onnxruntime_MINIMAL_BUILD:BOOL=OFF')))
            prebuilt.create_deps_alias(release.parent)
            with patch.object(recipe.sys, 'executable', python):
                recipe.verified_outputs(release, 'linux-x64')
            (stage / 'complete.json').write_text(json.dumps({
                'build_stage': str(stage), 'cmake_cache_sha256': recipe.sha256(cache),
                'build_roots': [str(root) for root in recipe.cache_allowed_roots(stage, 'linux-x64')],
                'python_prefix': str(Path(python).parent.parent)}))
            restored = Path(directory) / 'consumer'
            stage.rename(restored)
            with patch.object(recipe.sys, 'executable', '/different/python/bin/python3'):
                recipe.verified_outputs(restored / 'build/Release', 'linux-x64')
            cache = restored / 'build/Release/CMakeCache.txt'
            cache.write_text(cache.read_text() + '\nX_LIBRARY:FILEPATH=/tmp/host.a')
            with self.assertRaisesRegex(RuntimeError, 'CMake cache digest mismatch'):
                recipe.verified_outputs(restored / 'build/Release', 'linux-x64')


if __name__ == '__main__':
    unittest.main()
