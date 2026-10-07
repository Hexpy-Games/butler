#!/usr/bin/env python3
"""Owner Windows job safety, including imported SDK link creation."""
import contextlib
import hashlib
import importlib.util
import io
import os
import json
import sys
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
for name, filename in [('windows_safety', 'windows-ci-safety.py'), ('oras_setup', 'setup-oras.py'),
                       ('zstd_setup', 'prepare-windows-zstd.py')]:
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    globals()[name] = module


class WindowsSafety(unittest.TestCase):
    # test-category: security
    def test_native_stderr_guard_requires_continue_per_step(self):
        native = windows_safety.native_safety
        for command in ['cargo test 2>&1 | Out-Host', 'python check.py',
                        '$result = & "job/tool.exe" --list', '& reg query key', 'reg.exe query key 2>$null',
                        '$protocolBefore = (& reg.exe query key /s 2>$null) -join \"`n\"',
                        '$result = (& python check.py)', '& $python check.py']:
            self.assertTrue(native.script_hazards(command), command)
            safe = "$ErrorActionPreference = 'Continue'\n" + command + "\n$ErrorActionPreference = 'Stop'\nif ($LASTEXITCODE) { exit $LASTEXITCODE }"
            self.assertEqual(native.script_hazards(safe), [])
        self.assertTrue(native.script_hazards("$ErrorActionPreference = 'Continue'\npython check.py"))
        self.assertTrue(native.script_hazards(
            "if ($condition) { $ErrorActionPreference = 'Continue' }\ncargo test"))
        self.assertTrue(native.script_hazards(
            "if ($condition) {\n  $ErrorActionPreference = 'Continue'\n}\ncargo test"))
        source = ("steps:\n  - run: |\n      $ErrorActionPreference = 'Continue'\n"
                  "      cargo test\n      if ($LASTEXITCODE) { exit $LASTEXITCODE }\n  - run: cargo test\n")
        self.assertEqual(len(native.hazards(source, True)), 1)
        self.assertEqual(native.hazards('steps:\n  - shell: bash\n    run: python script.py\n', True), [])
        self.assertEqual(native.script_hazards('& "job/script.ps1"\n"BIN=job/test.exe" | Out-File $env:GITHUB_ENV'), [])

    # test-category: security
    def test_hosted_installed_preview_follows_registry_probes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workflow = root / '.github/workflows/windows-preview-smoke.yml'
            workflow.parent.mkdir(parents=True)
            workflow.write_text('jobs:\n  release:\n    runs-on: windows-latest\n'
                                '    steps:\n      - run: ./deploy/probe.ps1\n')
            probe = root / 'deploy/probe.ps1'
            probe.parent.mkdir()
            probe.write_text("$ErrorActionPreference = 'Stop'\n"
                             "$before = (& reg.exe query HKCU\\Software /s 2>$null)\n"
                             "if ($LASTEXITCODE -notin @(0,1)) { throw 'probe failed' }\n")
            findings = windows_safety.audit(root)[1]
            self.assertTrue(any('probe.ps1:2: PS 5.1' in item for item in findings), findings)
            probe.write_text(probe.read_text().replace("'Stop'", "'Continue'"))
            self.assertEqual(windows_safety.audit(root)[1], [])

    # test-category: security
    def test_owner_jobs_and_reachable_actions_have_no_shared_machine_hazards(self):
        jobs, findings = windows_safety.audit(ROOT.parents[1])
        self.assertGreaterEqual(len(jobs), 6, jobs)
        self.assertEqual(findings, [], '\n'.join(findings))
        print(f'Windows concurrency audit: {len(jobs)} owner jobs, no hazards')

    # test-category: security
    def test_windows_consumers_cannot_select_sdk_without_toolset_key(self):
        scripts = ROOT.parents[1] / 'packages/butler-agent/rust/scripts'
        sys.path.insert(0, str(scripts))
        try:
            import static_ort_prebuilt as sdk
            from static_ort_targets import TARGETS
            script = scripts / 'prepare-static-ort.py'
            lock = json.loads((scripts / 'static-ort.lock.json').read_text())
            selected = {'vc_tools_version': '14.44.35207', 'ucrt_version': '10.0.26100.0',
                        'compiler_sha256': 'compiler', 'stl_crt_sha256': {'stl': 'old', 'crt': 'old'}}
            with patch.object(sdk.host, 'visual_studio_identity', return_value=selected):
                owner_key = sdk.key(script, lock, 'windows-x64')
            variants = [{**selected, 'vc_tools_version': '14.51.36231'},
                        {**selected, 'ucrt_version': '10.0.28000.0'},
                        {**selected, 'stl_crt_sha256': {'stl': 'new', 'crt': 'old'}},
                        {**selected, 'stl_crt_sha256': {'stl': 'old', 'crt': 'new'}}]
            for toolset in variants:
                with patch.object(sdk.host, 'visual_studio_identity', return_value=toolset):
                    self.assertNotEqual(owner_key, sdk.key(script, lock, 'windows-x64'))
            with patch.object(sdk.host, 'visual_studio_identity', side_effect=RuntimeError('missing MSVC')):
                with self.assertRaisesRegex(RuntimeError, 'missing MSVC'):
                    sdk.key(script, lock, 'windows-x64')
            self.assertIn('windows-x64', TARGETS)
        finally:
            sys.path.remove(str(scripts))

    # test-category: security
    def test_shared_rust_setup_initializes_msvc_before_sdk_and_snapshot_selection(self):
        setup = (ROOT.parents[1] / '.github/actions/rust-agent-setup/action.yml').read_text()
        initialization = setup.index('uses: ilammy/msvc-dev-cmd@v1')
        step = setup[initialization:setup.index('    - uses:', initialization)]
        self.assertIn("if: runner.os == 'Windows'", step)
        self.assertIn('arch: x64', step)
        self.assertLess(initialization, setup.index('name: Prepare pinned protoc'))
        self.assertLess(initialization, setup.index('name: Fingerprint static ONNX Runtime'))
        self.assertLess(initialization, setup.index('cargo-artifact-cache.py'))

    # test-category: security
    def test_owner_native_publisher_uses_powershell_not_runner_bash_alias(self):
        source = (ROOT.parents[1] / '.github/workflows/native-deps.yml').read_text()
        owner_job = source.split('  windows-owner:', 1)[1]
        self.assertNotIn('setup-python', owner_job)
        self.assertNotIn('rustup-init', owner_job)
        self.assertNotIn('toolchain install', owner_job)
        self.assertIn("sys.version_info[:2] != (3, 12)", owner_job)
        self.assertIn("RUSTUP_AUTO_INSTALL: '0'", owner_job)
        self.assertIn('no installation attempted', owner_job)
        self.assertIn('Verify existing owner toolchain', owner_job)
        self.assertLess(owner_job.index('uses: ./.github/actions/windows-owner-discovery'),
                        owner_job.index('name: Verify existing owner toolchain'))
        owner = source.split('name: Build and publish owner-toolset SDK', 1)[1]
        self.assertIn('native-deps $env:NATIVE_TARGET', owner)
        self.assertIn('if ($LASTEXITCODE -ne 0)', owner)
        hosted = source.split('name: Build once and publish verified SDK', 1)[1].split(
            'name: Build and publish owner-toolset SDK', 1)[0]
        self.assertIn('shell: bash', hosted)

    # test-category: security
    def test_owner_portable_oras_is_reachable_without_persistent_host_changes(self):
        repository = ROOT.parents[1]
        publisher = (repository / '.github/workflows/native-deps.yml').read_text().split(
            '  windows-owner:', 1)[1]
        consumer = (repository / '.github/actions/windows-owner-setup/action.yml').read_text()
        for source, operation in [(publisher, 'name: Build and publish owner-toolset SDK'),
                                  (consumer, 'name: Verify or prepare pinned static ORT')]:
            self.assertNotIn("'oras'", source)
            self.assertLess(source.index('uses: ./.github/actions/setup-oras'), source.index(operation))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workflow = root / '.github/workflows/portable.yml'
            workflow.parent.mkdir(parents=True)
            workflow.write_text('jobs:\n  build:\n    runs-on: [self-hosted, butler-win]\n'
                                '    steps:\n      - uses: ./.github/actions/setup-oras\n')
            action = root / '.github/actions/setup-oras/action.yml'
            action.parent.mkdir(parents=True)
            action.write_text((repository / '.github/actions/setup-oras/action.yml').read_text())
            script = root / '.github/scripts/setup-oras.py'
            script.parent.mkdir(parents=True)
            script.write_text((ROOT / 'setup-oras.py').read_text())
            self.assertEqual(windows_safety.audit(root)[1], [])
            for mutation in ['subprocess.run(["winget", "install", "oras"])',
                             'subprocess.run(["setx", "PATH", "portable"])',
                             'subprocess.run(["reg", "add", "HKCU/Environment"])']:
                script.write_text((ROOT / 'setup-oras.py').read_text() + '\n' + mutation + '\n')
                self.assertTrue(windows_safety.audit(root)[1], mutation)
        self.assertLess(consumer.index('prepare-windows-zstd.py'), consumer.index(
            'name: Verify or prepare pinned static ORT'))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / zstd_setup.ASSET
            with zipfile.ZipFile(archive, 'w') as package:
                package.writestr(f'zstd-v{zstd_setup.VERSION}-win64/zstd.exe', b'verified executable')
                package.writestr('../unwanted.txt', b'must not extract')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                zstd_setup.unpack(archive, root)
            self.assertFalse((root / 'zstd.exe').exists())
            with patch.object(zstd_setup, 'SHA256', hashlib.sha256(archive.read_bytes()).hexdigest()):
                self.assertEqual(zstd_setup.unpack(archive, root).read_bytes(), b'verified executable')
            self.assertEqual([path.name for path in root.iterdir()], ['zstd.exe'])

    # test-category: security
    def test_checker_follows_actions_and_scripts_and_rejects_mutations(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / '.github/workflows').mkdir(parents=True)
            (root / '.github/actions/setup').mkdir(parents=True)
            workflow = root / '.github/workflows/fixture.yml'
            workflow.write_text('jobs:\n  build:\n    runs-on: [self-hosted, butler-win]\n'
                                '    steps:\n      - uses: ./.github/actions/setup\n')
            action = root / '.github/actions/setup/action.yml'
            action.write_text('runs:\n  using: composite\n  steps:\n    - run: ../../../deploy/probe.ps1\n')
            (root / 'deploy').mkdir()
            probe = root / 'deploy/probe.ps1'
            for unsafe in [r"$root = 'C:\butler-ci'", "$root = '/tmp/shared-ci'", '$env:BUTLER_APP_SERVER_PORT = 18765',
                           'python -m http.server 8080', 'Stop-Process -Name butler-agent',
                           'Stop-Process butler-agent', 'taskkill /F /IM node.exe',
                           'bun run installer-smoke.ts', 'winget install Rust',
                           r'$root = "$env:USERPROFILE/work/target"']:
                probe.write_text(unsafe)
                _, findings = windows_safety.audit(root)
                self.assertTrue(findings, unsafe)
                self.assertTrue(any('probe.ps1:1:' in item for item in findings), findings)
            probe.write_text('$root = Join-Path $env:RUNNER_TEMP ([guid]::NewGuid())\n'
                             '$env:BUTLER_APP_SERVER_PORT = $port\nStop-Process -Id $child.Id')
            self.assertEqual(windows_safety.audit(root)[1], [])
            workflow.write_text(workflow.read_text().replace('[self-hosted, butler-win]', 'windows-latest'))
            probe.write_text('Stop-Process -Name node')
            self.assertEqual(windows_safety.audit(root)[0], [])

    # test-category: security
    def test_owner_action_allowlist_and_installer_commands(self):
        forbidden = ['uses: actions/setup-python@v5', 'uses: actions/setup-node@v4',
                     'uses: vendor/arbitrary@v1', 'uses: actions/checkout-extra@v4',
                     'uses: ./.github/actions/../untrusted', 'choco install python',
                     'winget upgrade python', 'msiexec.exe /i python.msi',
                     r'Set-ItemProperty -Path HKLM:\Software -Name value -Value 1',
                     r"Set-ItemProperty 'HKCU:\Software' value 1", r'reg add HKCU\Software',
                     'setx PATH value', 'rustup toolchain install 1.91.0',
                     'python -m pip install package', '$env:GITHUB_PATH']
        for source in forbidden:
            with self.subTest(source=source):
                self.assertTrue(windows_safety.hazards(source), source)
        for action in ['checkout', 'upload-artifact', 'download-artifact', 'cache']:
            self.assertEqual(windows_safety.hazards(f'uses: actions/{action}@v4'), [])
        self.assertEqual(windows_safety.hazards('uses: ./.github/actions/owner-tools'), [])

    # test-category: security
    def test_job_path_additions_do_not_allow_persistent_path_writes(self):
        allowed = '$directory | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append'
        self.assertEqual(windows_safety.hazards(allowed), [])
        for unsafe in ['setx PATH value',
                       "[Environment]::SetEnvironmentVariable('PATH', $value, 'Machine')",
                       "[Environment]::SetEnvironmentVariable('PATH', $value, 'User')",
                       r'Set-ItemProperty HKCU:\Environment -Name PATH -Value $value',
                       allowed + '; setx PATH value']:
            self.assertTrue(windows_safety.hazards(unsafe), unsafe)

    # test-category: security
    def test_hosted_guard_requires_literal_owner_binding(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workflow = root / '.github/workflows/test.yml'
            workflow.parent.mkdir(parents=True)
            action = root / '.github/actions/build/action.yml'
            action.parent.mkdir(parents=True)
            action.write_text("runs:\n  using: composite\n  steps:\n"
                              "    - uses: actions/setup-node@v4\n"
                              "      if: inputs.owner-runner != 'true'\n")
            job = ('jobs:\n  build:\n    runs-on: [self-hosted, butler-win]\n'
                   '    steps:\n      - uses: ./.github/actions/build\n')
            workflow.write_text(job)
            self.assertTrue(windows_safety.audit(root)[1])
            workflow.write_text(job + "        with:\n          owner-runner: 'true'\n")
            self.assertEqual(windows_safety.audit(root)[1], [])
            action.write_text(action.read_text().replace("inputs.owner-runner != 'true'", 'unknown.condition'))
            self.assertTrue(windows_safety.audit(root)[1])

    # test-category: security
    def test_oci_uses_job_executable_without_path_changes(self):
        sys.path.insert(0, str(ROOT.parents[1] / 'packages/butler-agent/rust/scripts'))
        try:
            import ci_oci
            with patch.dict(os.environ, BUTLER_ORAS_EXECUTABLE='job-tools/oras.exe'), \
                 patch.object(ci_oci.subprocess, 'run') as execute:
                ci_oci.command('version')
                self.assertEqual(execute.call_args.args[0][:2], ['job-tools/oras.exe', 'version'])
        finally:
            sys.path.pop(0)

    # test-category: security
    def test_windows_oras_extracts_verified_zip_and_rejects_bad_checksum(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as package:
            package.writestr('oras.exe', b'official executable fixture')
            package.writestr('../outside', b'must not extract')
        payload = archive.getvalue()
        checksum = hashlib.sha256(payload).hexdigest()
        for expected in [checksum, '0' * 64]:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                path_file = root / 'github-env'
                responses = [io.BytesIO(payload), io.BytesIO(
                    f'{expected}  oras_1.2.3_windows_amd64.zip\n'.encode())]
                with patch.dict(os.environ, RUNNER_TEMP=temporary, GITHUB_ENV=str(path_file)), \
                     patch.object(oras_setup.platform, 'system', return_value='Windows'), \
                     patch.object(oras_setup.platform, 'machine', return_value='AMD64'), \
                     patch.object(oras_setup.urllib.request, 'urlopen', side_effect=responses), \
                     patch.object(oras_setup.subprocess, 'run') as execute, \
                     contextlib.redirect_stdout(io.StringIO()):
                    if expected != checksum:
                        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                            oras_setup.install()
                        execute.assert_not_called()
                        self.assertFalse(path_file.exists())
                    else:
                        oras_setup.install()
                        installed = Path(path_file.read_text().strip().split('=', 1)[1])
                        self.assertTrue(path_file.read_text().startswith('BUTLER_ORAS_EXECUTABLE='))
                        self.assertTrue(installed.is_relative_to(root))
                        self.assertEqual(installed.read_bytes(), b'official executable fixture')
                        self.assertEqual(execute.call_args.args[0], [str(installed), 'version'])
                        self.assertFalse((root / 'outside').exists())

    # test-category: security
    def test_checker_rejects_windows_shell_and_oras_in_jobs_defaults_and_actions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / '.github/workflows').mkdir(parents=True)
            action = root / '.github/actions/setup/action.yml'
            action.parent.mkdir(parents=True)
            workflow = root / '.github/workflows/fixture.yml'
            job = ('jobs:\n  build:\n    runs-on: [self-hosted, butler-win]\n'
                   '    steps:\n      - uses: ./.github/actions/setup\n')
            for unsafe in ['shell: bash', 'shell: pwsh', 'shell: powershell', 'uses: oras-project/setup-oras@v1']:
                action.write_text('runs:\n  using: composite\n  steps:\n    - ' + unsafe + '\n')
                workflow.write_text(job)
                self.assertTrue(windows_safety.audit(root)[1], unsafe)
                action.write_text('runs:\n  using: composite\n  steps: []\n')
                workflow.write_text(job + '      - ' + unsafe + '\n')
                self.assertTrue(windows_safety.audit(root)[1], unsafe)
            action.write_text("runs:\n  using: composite\n  steps:\n    - shell: bash\n      if: runner.os != 'Windows'\n")
            workflow.write_text(job)
            self.assertEqual(windows_safety.audit(root)[1], [])
            action.write_text(action.read_text().replace("runner.os != 'Windows'", 'unknown.condition'))
            self.assertTrue(windows_safety.audit(root)[1])
            action.write_text('runs:\n  using: composite\n  steps: []\n')
            for prefix in ['', 'defaults:\n  run:\n    shell: pwsh\n']:
                workflow.write_text(prefix + job.replace('    steps:',
                    '    defaults:\n      run:\n        shell: pwsh\n    steps:'))
                self.assertTrue(windows_safety.audit(root)[1])
            workflow.write_text('defaults:\n  run:\n    shell: pwsh\n' + job)
            self.assertTrue(windows_safety.audit(root)[1])
            workflow.write_text(job + '      - shell: powershell -NoProfile -ExecutionPolicy Bypass -File "{0}"\n        run: echo safe\n')
            self.assertEqual(windows_safety.audit(root)[1], [])


    # test-category: security
    def test_symlink_check_requires_a_windows_unreachable_branch(self):
        unsafe = ["os.symlink(target, link)", "link.symlink_to(target)",
                  'New-Item -ItemType SymbolicLink -Path $link -Target $target',
                  'cmd /c mklink /D link target', 'mklink /H link target',
                  "if sys.platform == 'win32':\n    os.symlink(target, link)\nelse:\n    shutil.copytree(target, link)",
                  "shutil.copytree(target, link)\nlink.symlink_to(target)"]
        for source in unsafe:
            self.assertTrue(windows_safety.symlink_hazards(source), source)
        for condition in ["sys.platform == 'win32'", "os.name == 'nt'", "platform.system() == 'Windows'"]:
            source = f'if {condition}:\n    shutil.copytree(target, link)\nelse:\n    link.symlink_to(target)'
            self.assertEqual(windows_safety.symlink_hazards(source), [], source)
        self.assertEqual(windows_safety.symlink_hazards(
            "if sys.platform == 'win32':\n    pass\nelse:\n    link.symlink_to(target)"), [])
        self.assertEqual(windows_safety.symlink_hazards('cmd /c mklink /J link target'), [])

    # test-category: security
    def test_checker_follows_python_imports_to_privileged_link_creator(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workflow = root / '.github/workflows/fixture.yml'
            workflow.parent.mkdir(parents=True)
            workflow.write_text('jobs:\n  build:\n    runs-on: [self-hosted, butler-win]\n'
                                '    steps:\n      - run: python deploy/entry.py\n')
            scripts = root / 'deploy'
            scripts.mkdir()
            (scripts / 'entry.py').write_text('import bridge\n')
            (scripts / 'bridge.py').write_text('from extract import unpack\n')
            extraction = scripts / 'extract.py'
            extraction.write_text('def unpack():\n    link.symlink_to(target)\n')
            findings = windows_safety.audit(root)[1]
            self.assertTrue(any('extract.py:2:' in item for item in findings), findings)
            extraction.write_text("def unpack():\n    if sys.platform == 'win32':\n"
                                  '        shutil.copytree(target, link)\n    else:\n        link.symlink_to(target)\n')
            self.assertEqual(windows_safety.audit(root)[1], [])


if __name__ == '__main__':
    unittest.main()
