#!/usr/bin/env python3
"""Workflow contracts for Windows snapshot lanes."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]


class WindowsSnapshotLanes(unittest.TestCase):
    # test-category: format-pin
    def test_release_preparation_matches_tag_build_and_is_outside_gate(self):
        action = lambda name: (ROOT / f'.github/actions/{name}/action.yml').read_text()
        tag = action('build-windows-agent')
        prepare = action('prepare-windows-release-target')
        command = lambda source: re.search(r'cargo build --timings[^\n]+', source)[0]
        self.assertEqual(command(prepare), command(tag).replace('${{ inputs.profile }}', 'release'))
        for value in ["CARGO_PROFILE_RELEASE_LTO: thin", "CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1'"]:
            self.assertIn(value, prepare)
        self.assertIn("$env:CARGO_PROFILE_RELEASE_LTO = 'thin'", tag)
        self.assertIn("$env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '1'", tag)
        self.assertNotIn('$env:GITHUB_REF_NAME =', prepare)
        self.assertIn("align-candidate-tag-ref:", prepare)
        self.assertIn("default: 'false'", prepare)
        workflow = (ROOT / '.github/workflows/windows-preview-smoke.yml').read_text()
        job = workflow.split('  prepare-release-target:', 1)[1].split('\n  stub:', 1)[0]
        self.assertIn('needs: build', job)
        self.assertIn('group: windows-release-target-${{ github.ref }}', job)
        self.assertIn('cancel-in-progress: true', job)
        self.assertNotIn('align-candidate-tag-ref:', job)
        self.assertNotIn('prepare-windows-release-target', action('windows-preview-build'))
        gate = workflow.split('\n  gate:', 1)[1].split('\n  diagnostics:', 1)[0]
        self.assertNotIn('prepare-release-target', gate)
        self.assertIn('needs: [changes, build, stub, release, hosted]', gate)

    # test-category: format-pin
    def test_hosted_clippy_restores_on_pr_and_publishes_only_main(self):
        workflow = (ROOT / '.github/workflows/rust-windows-check.yml').read_text()
        self.assertIn('artifact-cache-kind: clippy', workflow)
        self.assertIn('snapshot-target: x86_64-pc-windows-msvc', workflow)
        defaults, jobs = workflow.split('jobs:', 1)
        self.assertIn('packages: read', defaults)
        self.assertNotIn('packages: write', defaults)
        check, main = jobs.split('  check-main:', 1)
        self.assertIn("if: github.event_name != 'push' || github.ref != 'refs/heads/main'", check)
        self.assertNotIn('packages: write', check)
        self.assertIn("if: github.event_name == 'push' && github.ref == 'refs/heads/main'", main)
        self.assertIn('packages: write', main)
        for key in ('outputs', 'defaults', 'steps'):
            self.assertIn(f'{key}: &check-{key}', check)
            self.assertIn(f'{key}: *check-{key}', main)
        for job in (check, main):
            self.assertIn('name: Windows Clippy check (x86_64-pc-windows-msvc)', job)
            self.assertIn('runs-on: windows-latest', job)
            self.assertIn('timeout-minutes: 60', job)
        publish = workflow.split('      - name: Publish hosted Windows clippy snapshot', 1)[1].split('      - name: Summarize', 1)[0]
        self.assertIn("if: github.event_name == 'push' && github.ref == 'refs/heads/main'", publish)
        self.assertIn('kind: clippy', publish)
        self.assertIn('producer: Windows Clippy check (x86_64-pc-windows-msvc)', publish)
        self.assertIn('cargo clippy --workspace --all-targets', workflow)
        setup = (ROOT / '.github/actions/rust-agent-setup/action.yml').read_text()
        self.assertLess(setup.index('Pin hosted Windows clippy linker'), setup.index('Restore persistent main Cargo'))
        flags = setup.split('    - name: Configure Windows snapshot compiler flags', 1)[1].split('    # The quota', 1)[0]
        self.assertIn("inputs.artifact-cache-kind != 'clippy'", flags)


if __name__ == '__main__':
    unittest.main()
