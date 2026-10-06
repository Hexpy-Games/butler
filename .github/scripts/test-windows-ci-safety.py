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
for name, filename in [('windows_safety', 'windows-ci-safety.py'), ('oras_setup', 'setup-oras.py')]:
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    globals()[name] = module


class WindowsSafety(unittest.TestCase):
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
                path_file = root / 'github-path'
                responses = [io.BytesIO(payload), io.BytesIO(
                    f'{expected}  oras_1.2.3_windows_amd64.zip\n'.encode())]
                with patch.dict(os.environ, RUNNER_TEMP=temporary, GITHUB_PATH=str(path_file)), \
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
                        installed = Path(path_file.read_text().strip()) / 'oras.exe'
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
            for unsafe in ['shell: pwsh', 'shell: powershell', 'uses: oras-project/setup-oras@v1']:
                action.write_text('runs:\n  using: composite\n  steps:\n    - ' + unsafe + '\n')
                workflow.write_text(job)
                self.assertTrue(windows_safety.audit(root)[1], unsafe)
                action.write_text('runs:\n  using: composite\n  steps: []\n')
                workflow.write_text(job + '      - ' + unsafe + '\n')
                self.assertTrue(windows_safety.audit(root)[1], unsafe)
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
