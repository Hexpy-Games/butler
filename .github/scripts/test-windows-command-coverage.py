#!/usr/bin/env python3
"""Pin distinct Windows machine and binary command coverage."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class WindowsCommandCoverage(unittest.TestCase):
    # test-category: format-pin
    def test_installed_selection_uses_target_feature_requirement(self):
        script = (ROOT / 'deploy/windows-e2e-artifacts.ps1').read_text()
        self.assertIn('[switch]$WithoutE2eFixtures', script)
        self.assertIn("if ($WithoutE2eFixtures) { @('--skip', '::requires_e2e_fixtures::') } else { @() }", script)
        self.assertIn('"$test`::" @selection --list', script)
        self.assertIn('$selection --test-threads=$threads', script)
        basic = (ROOT / 'deploy/windows-basic-capabilities.ps1').read_text()
        self.assertIn('[switch]$WithoutE2eFixtures', basic)
        self.assertIn("if ($WithoutE2eFixtures) { '--skip ::requires_e2e_fixtures::' } else { '' }", basic)
        release = (ROOT / '.github/workflows/release.yml').read_text()
        self.assertIn('windows-basic-capabilities.ps1 -Agent $agent -WithoutE2eFixtures', release)

    # test-category: format-pin
    def test_native_command_proofs_keep_machine_and_binary_coverage(self):
        repository = ROOT
        workflow = (repository / '.github/workflows/windows-preview-smoke.yml').read_text()
        triggers = workflow.split('permissions:', 1)[0]
        self.assertIn('  pull_request:\n    types: [opened, synchronize, reopened]\n', triggers)
        self.assertIn('  workflow_dispatch:', triggers)
        self.assertIn("branches: [main, 'release/**']", triggers)
        self.assertIn('main', triggers.split('push:', 1)[1].split('workflow_dispatch:', 1)[0])
        release = workflow.split('  release:\n', 1)[1].split('  hosted:\n', 1)[0]
        matrix = release.split('      - name: Installed release native command regression matrix\n', 1)[1]
        matrix = matrix.split('      - name:', 1)[0]
        self.assertIn('run: ../../../deploy/windows-installed-e2e.ps1 -Tests windows_commands', matrix)
        script = (repository / 'deploy/windows-installed-e2e.ps1').read_text()
        self.assertIn("Join-Path $env:BUTLER_E2E_INSTALLED_ROOT 'butler-agent.exe'", script)
        self.assertIn('-Mode Run -Tests $Tests -WithoutE2eFixtures', script)
        self.assertIn('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }', script)
        installed = "@('windows_startup_xml','installed_preview','windows_commands','projection_settlement')"
        self.assertIn('$expected = ' + installed, release)
        gate = (repository / '.github/actions/windows-preview-gate/action.yml').read_text()
        self.assertIn('release = ' + installed, gate)
        self.assertIn("'cli_remote','windows_commands','project_workspace'", gate)
        parts = (ROOT / '.github/scripts/ci_parts.py').read_text()
        self.assertIn("dict(shard='basics', tests='windows_commands,local_zone')", parts)
        install = (repository / '.github/workflows/install-smoke.yml').read_text()
        tarball = install.split('      - name: Keep the tarball for the smoke', 1)[1].split('  smoke:', 1)[0]
        self.assertIn("retention-days: ${{ startsWith(github.ref, 'refs/heads/release/') && 30 || 7 }}", tarball)


if __name__ == '__main__':
    unittest.main()
