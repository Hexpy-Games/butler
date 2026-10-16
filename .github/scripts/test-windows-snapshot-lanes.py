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


if __name__ == '__main__':
    unittest.main()
