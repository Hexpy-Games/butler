#!/usr/bin/env python3
"""Security checks for native search isolation and shipped loader metadata."""
import importlib.util
import os
import subprocess
import textwrap
from pathlib import Path, PurePosixPath, PureWindowsPath
import sys
import tempfile
import types
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
    def test_release_python_path_step_exports_only_tool_directories(self):
        action = SCRIPTS.parents[3] / '.github/actions/release-python/action.yml'
        source = action.read_text()
        program = textwrap.dedent(source.split('      run: |\n', 1)[1])
        template = next(line.strip()[7:] for line in source.splitlines() if line.strip().startswith('shell: ')).strip("'")
        template = template.replace('${{ steps.python.outputs.python-path }}', sys.executable)
        with tempfile.TemporaryDirectory() as directory:
            path_file = Path(directory) / 'paths'
            env_file = Path(directory) / 'environment'
            env = dict(os.environ, GITHUB_PATH=str(path_file), GITHUB_ENV=str(env_file),
                       PKG_CONFIG_PATH='/inherited/search')
            script = Path(directory) / 'path-step.py'
            script.write_text(program)
            executable, arguments = template.split(' ', 1)
            subprocess.run([executable, arguments.format(str(script))], env=env, check=True)
            paths = path_file.read_text().splitlines()
            self.assertIn(str(Path(sys.executable).parent), paths)
            self.assertTrue(all(Path(path).is_dir() for path in paths))
            self.assertFalse(env_file.exists())

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
                self.assertEqual(Path(args[-1]).resolve(), binary.resolve())
                return type('Result', (), {'stdout': 'binary:\n'})()
            with patch.object(guard.subprocess, 'run', side_effect=inspect) as run:
                self.assertEqual(guard.check_path(Path(directory), 'darwin'), 1)
                self.assertEqual(run.call_count, 2)

    # test-category: security
    def test_cmake_cache_roots(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            clean = (f'protobuf_DIR:PATH={stage}/build/protobuf\n'
                     'CMAKE_C_COMPILER_EXECUTABLE:FILEPATH=/usr/bin/cc\n'
                     'X_INCLUDE_DIRS:PATH=/usr/include;/usr/include/c++\n'
                     'GIT_EXECUTABLE:FILEPATH=GIT_EXECUTABLE-NOTFOUND\n'
                     f'Python_EXECUTABLE:FILEPATH={sys.executable}\n'
                     f'CMAKE_MAKE_PROGRAM_EXECUTABLE:FILEPATH={stage}/tools/ninja\n')
            # Linux roots come from the host filesystem; pin them so any build host can run this.
            with patch.object(recipe.glob, 'glob', side_effect=lambda pattern: [pattern.rstrip('*')]), \
                    patch.object(recipe.pathlib.Path, 'is_dir', return_value=True):
                roots = recipe.cache_allowed_roots(stage, 'linux-x64')
            recipe.check_cmake_cache(clean, stage, 'linux-x64', roots)
            for entry in ('Protobuf_DIR:PATH=/opt/homebrew/lib/cmake/protobuf',
                          'absl_DIR:PATH=/usr/local/lib/cmake/absl',
                          'X_LIBRARIES:STRING=/usr/lib/libc.so;/tmp/libbad.a',
                          're2_DIR:PATH=relative/package'):
                with self.subTest(entry=entry), self.assertRaisesRegex(RuntimeError, 'outside allowed'):
                    recipe.check_cmake_cache(entry, stage, 'linux-x64', roots)

        with patch.object(recipe, 'command', side_effect=['/SDK', '/Xcode']):
            roots = recipe.cache_allowed_roots(stage, 'macos-arm64')
        clean = ('Patch_EXECUTABLE:FILEPATH=/usr/bin/patch\n'
                 'CMAKE_AR_EXECUTABLE:FILEPATH=/Xcode/Toolchains/usr/bin/ar\n'
                 'Iconv_INCLUDE_DIR:PATH=/SDK/usr/include\n'
                 'Iconv_LIBRARY:FILEPATH=/SDK/usr/lib/libiconv.tbd\n')
        recipe.check_cmake_cache(clean, stage, 'macos-arm64', roots)
        recipe.check_cmake_cache('Patch_EXECUTABLE:FILEPATH=/bin/patch', stage, 'linux-x64')

        class WindowsPath(PureWindowsPath):
            def resolve(self):
                return self

        with patch.object(recipe, 'pathlib', types.SimpleNamespace(Path=WindowsPath)):
            stage = WindowsPath('C:/stage')
            with patch.dict(os.environ, VCToolsInstallDir='C:/MSVC', UniversalCRTSdkDir='C:/SDK',
                            WindowsSdkDir='C:/SDK'):
                roots = recipe.cache_allowed_roots(stage, 'windows-x64')
            clean = ('Patch_EXECUTABLE:FILEPATH=C:/stage/source/cmake/external/git.Win32.2.41.03.patch/patch.exe\n'
                     'CMAKE_MT_EXECUTABLE:FILEPATH=C:/SDK/bin/mt.exe\n'
                     'CMAKE_LINKER_EXECUTABLE:FILEPATH=C:/MSVC/bin/link.exe\n'
                     'CMAKE_RC_EXECUTABLE:FILEPATH=C:/SDK/bin/rc.exe\n'
                     'MSVC_CRT_LIBRARY:FILEPATH=C:/MSVC/lib/libcmt.lib\n'
                     'SDK_INCLUDE_DIR:PATH=C:/SDK/Include/ucrt\n'
                     'GIT_EXECUTABLE:FILEPATH=GIT_EXECUTABLE-NOTFOUND\n'
                     'Python_EXECUTABLE:FILEPATH=C:/Python/python.exe\n')
            recipe.check_cmake_cache(clean, stage, 'windows-x64', roots, WindowsPath('C:/Python'))
            with self.assertRaisesRegex(RuntimeError, 'outside allowed'):
                recipe.check_cmake_cache('Patch_EXECUTABLE:FILEPATH=C:/Program Files/Git/usr/bin/patch.exe',
                                         stage, 'windows-x64', roots, WindowsPath('C:/Python'))

    # test-category: security
    def test_running_python_install_roots(self):
        class PosixPath(PurePosixPath):
            def resolve(self):
                return self

        class WindowsPath(PureWindowsPath):
            def resolve(self):
                return self

        fixtures = (
            (PosixPath, 'linux-x64', '/opt/hostedtoolcache/Python/3.12.15/x64/bin/python'),
            (PosixPath, 'linux-arm64', '/opt/hostedtoolcache/Python/3.12.15/arm64/bin/python'),
            (PosixPath, 'macos-arm64', '/Library/Frameworks/Python.framework/Versions/3.12/bin/python'),
            (WindowsPath, 'windows-x64', 'C:/hostedtoolcache/windows/Python/3.12.10/x64/python.exe'),
            (WindowsPath, 'windows-x64', 'C:/Users/builder/AppData/Local/Programs/Python/Python312/python.exe'),
        )
        for path_type, target, executable in fixtures:
            parent = path_type(executable).parent
            install = parent.parent if parent.name == 'bin' else parent
            # Distinct prefixes ensure the real executable root is tested too.
            base, prefix = install / 'base', install / 'venv'
            with self.subTest(executable=executable), \
                    patch.object(recipe, 'pathlib', types.SimpleNamespace(Path=path_type)), \
                    patch.object(recipe.os.path, 'realpath', return_value=executable), \
                    patch.object(recipe.sys, 'executable', executable), \
                    patch.object(recipe.sys, 'base_prefix', str(base)), \
                    patch.object(recipe.sys, 'prefix', str(prefix)):
                stage = path_type('C:/stage' if target == 'windows-x64' else '/stage')
                self.assertEqual(recipe.python_install_roots(), [install, base, prefix])
                for key in ('PYTHON_EXECUTABLE', 'Python_EXECUTABLE', 'Python3_EXECUTABLE', '_Python3_EXECUTABLE'):
                    for root in (install, base, prefix):
                        recipe.check_cmake_cache(f'{key}:FILEPATH={root / path_type(executable).name}',
                                                 stage, target, [stage])
                    unrelated = install.parent / 'unrelated-python' / path_type(executable).name
                    with self.assertRaisesRegex(RuntimeError, key):
                        recipe.check_cmake_cache(f'{key}:FILEPATH={unrelated}', stage, target, [stage])
                with self.assertRaisesRegex(RuntimeError, 'outside allowed'):
                    recipe.check_cmake_cache(f'X_LIBRARY:FILEPATH={install / "host.a"}', stage, target, [stage])

    # test-category: security
    def test_python_executable_symlink_uses_resolved_install(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executable = root / 'install/bin/python'
            executable.parent.mkdir(parents=True)
            executable.touch()
            link = root / 'python'
            link.symlink_to(executable)
            with patch.object(recipe.sys, 'executable', str(link)):
                self.assertIn((root / 'install').resolve(), recipe.python_install_roots())

    # test-category: security
    def test_cache_reports_every_violation(self):
        stage = Path('/stage')
        entries = ('protobuf_DIR:PATH=', 're2_DIR:PATH=relative/package',
                   'PYTHON_EXECUTABLE:FILEPATH=/unrelated/bin/python',
                   'X_LIBRARIES:STRING=/unrelated/first.a;/unrelated/second.a')
        with self.assertRaises(RuntimeError) as error:
            recipe.check_cmake_cache('\n'.join(entries), stage, 'linux-x64', [stage], [Path('/build-python')])
        self.assertEqual(str(error.exception).splitlines(), [
            'CMake cache violations:',
            'CMakeCache protobuf_DIR=: outside allowed roots',
            'CMakeCache re2_DIR=relative/package: outside allowed roots',
            'CMakeCache PYTHON_EXECUTABLE=/unrelated/bin/python: outside allowed roots',
            'CMakeCache X_LIBRARIES=/unrelated/first.a: outside allowed roots',
            'CMakeCache X_LIBRARIES=/unrelated/second.a: outside allowed roots'])

    # test-category: security
    def test_windows_patch_is_pinned_before_build(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            source = stage / 'source'
            executable = source / 'cmake/external/git.Win32.2.41.03.patch/patch.exe'
            with patch.object(build.shutil, 'which', return_value='cl'):
                with self.assertRaisesRegex(RuntimeError, 'Pinned build tool missing'):
                    build.run_build(stage, source, stage / 'cmake', stage / 'ninja',
                                    stage / 'eigen', 'windows-x64', {'build': {'parallel_jobs': 2}})
                executable.parent.mkdir(parents=True)
                executable.write_bytes(b'pinned patch')
                with patch.object(build.subprocess, 'Popen', side_effect=RuntimeError('launch')) as launch:
                    with self.assertRaisesRegex(RuntimeError, 'launch'):
                        build.run_build(stage, source, stage / 'cmake', stage / 'ninja',
                                        stage / 'eigen', 'windows-x64', {'build': {'parallel_jobs': 2}})
                self.assertIn(f'Patch_EXECUTABLE={executable}', launch.call_args.args[0])

    # test-category: security
    def test_build_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            host = dict(PATH='/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin',
                        CMAKE_PREFIX_PATH='/tmp/pkg', PKG_CONFIG_PATH='/tmp/pkg',
                        protobuf_ROOT='/tmp/pkg', absl_DIR='/tmp/pkg', DYLD_FALLBACK_LIBRARY_PATH='/tmp/pkg',
                        CFLAGS='-I/tmp/pkg', CC='cc', CXX='c++', DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer')
            env = build.build_environment(stage, Path('/pinned/cmake'), Path('/pinned/ninja'), 'linux-x64', host)
            for name in ('CMAKE_PREFIX_PATH', 'PKG_CONFIG_PATH', 'protobuf_ROOT', 'absl_DIR', 'DYLD_FALLBACK_LIBRARY_PATH', 'CFLAGS'):
                self.assertNotIn(name, env)
            self.assertEqual(env['DEVELOPER_DIR'], host['DEVELOPER_DIR'])
            self.assertNotIn('brew', env['PATH'])
            self.assertTrue(Path(env['CC']).is_absolute())
            self.assertTrue(Path(env['PKG_CONFIG_LIBDIR']).is_dir())
            self.assertIn('FETCHCONTENT_TRY_FIND_PACKAGE_MODE=NEVER', build.ISOLATION_DEFINES)
            self.assertIn('CMAKE_DISABLE_FIND_PACKAGE_Git=ON', build.ISOLATION_DEFINES)
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
        for name in ('RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_RUSTFLAGS', 'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS'):
            for value in ('-L native=/tmp/pkg', '-L/tmp/pkg', '-Clink-search=/tmp/pkg', '-L\x1fnative=/tmp/pkg',
                          '-C link-arg=-L/opt/x', '-Clink-args=-L/x', '-Clink-args=-Wl,-L/x'):
                with self.subTest(name=name, value=value), self.assertRaisesRegex(RuntimeError, name):
                    recipe.release_env_preflight({name: value})
            recipe.release_env_preflight({name: '-C link-arg=-fuse-ld=mold -C target-feature=+crt-static'})

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
            cache.write_text(f'X_DIR:PATH={stage}/sources\nPYTHON_EXECUTABLE:FILEPATH={python}\n' + '\n'.join((
                'onnxruntime_BUILD_UNIT_TESTS:BOOL=OFF', 'onnxruntime_BUILD_SHARED_LIB:BOOL=OFF',
                'onnxruntime_MINIMAL_BUILD:BOOL=OFF')))
            prebuilt.create_deps_alias(release.parent)
            with patch.object(recipe.sys, 'executable', python):
                recipe.verified_outputs(release, 'linux-x64')
            (stage / 'complete.json').write_text(json.dumps({
                'build_stage': str(stage), 'cmake_cache_sha256': recipe.sha256(cache),
                'build_roots': [str(root) for root in recipe.cache_allowed_roots(stage, 'linux-x64')],
                'python_prefix': [str(Path(python).parent.parent)]}))
            marker = stage / 'complete.json'
            recorded = json.loads(marker.read_text())
            for missing in ('build_stage', 'build_roots', 'python_prefix'):
                marker.write_text(json.dumps({key: value for key, value in recorded.items() if key != missing}))
                with self.assertRaisesRegex(RuntimeError, 'SDK marker lacks producer roots'):
                    recipe.verified_outputs(release, 'linux-x64')
            marker.write_text(json.dumps(recorded))
            restored = Path(directory) / 'consumer'
            stage.rename(restored)
            with patch.object(recipe.sys, 'executable', '/different/python/bin/python3'):
                recipe.verified_outputs(restored / 'build/Release', 'linux-x64')
                marker = restored / 'complete.json'
                recorded['python_prefix'] = str(Path(python).parent.parent)
                marker.write_text(json.dumps(recorded))
                recipe.verified_outputs(restored / 'build/Release', 'linux-x64')
                recorded['python_prefix'] = ['/different/python']
                marker.write_text(json.dumps(recorded))
                with self.assertRaisesRegex(RuntimeError, 'PYTHON_EXECUTABLE'):
                    recipe.verified_outputs(restored / 'build/Release', 'linux-x64')
            cache = restored / 'build/Release/CMakeCache.txt'
            cache.write_text(cache.read_text() + '\nX_LIBRARY:FILEPATH=/tmp/host.a')
            with self.assertRaisesRegex(RuntimeError, 'CMake cache digest mismatch'):
                recipe.verified_outputs(restored / 'build/Release', 'linux-x64')


if __name__ == '__main__':
    unittest.main()
