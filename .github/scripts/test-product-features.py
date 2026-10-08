#!/usr/bin/env python3
"""Pure selector contracts, exercised through the packaging CLI."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("product-features.py")


class ProductFeatures(unittest.TestCase):
    def select(self, ref, tag="", present=True, tag_args=None):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            releases = root / ".github" / "releases"
            releases.mkdir(parents=True)
            if present:
                (releases / "v0.1.0-preview.11.features.json").write_text('{"browser":false}')
            output = root / "github-env"
            env = dict(os.environ, GITHUB_REF=ref, GITHUB_REF_NAME="overridden-version",
                       GITHUB_ENV=str(output))
            result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(root),
                                     *(tag_args if tag_args is not None else ["--tag", tag])], env=env, check=True,
                                    capture_output=True, text=True)
            features = json.loads(result.stdout)
            self.assertEqual(output.read_text(),
                             f"BUTLER_FEATURE_BROWSER={str(features['browser']).lower()}\n")
            return features

    # test-category: pure-logic
    def test_exact_tag(self):
        self.assertEqual(self.select("refs/tags/v0.1.0-preview.11"), {"browser": False})

    # test-category: pure-logic
    def test_release_branch(self):
        for args in [[], ["--tag"], ["--tag="], ["--tag", ""]]:
            with self.subTest(args=args):
                self.assertEqual(self.select("refs/heads/release/0.1.0-preview.11",
                                             tag_args=args), {"browser": False})

    # test-category: pure-logic
    def test_other_branch_and_local_default_on(self):
        for ref in ["refs/heads/main", "refs/heads/feat/browser", "refs/pull/123/merge", ""]:
            with self.subTest(ref=ref):
                self.assertEqual(self.select(ref), {"browser": True})

    # test-category: pure-logic
    def test_missing_file_defaults_on(self):
        for ref in ["refs/tags/v0.1.0-preview.11", "refs/heads/release/0.1.0-preview.11"]:
            with self.subTest(ref=ref):
                self.assertEqual(self.select(ref, present=False), {"browser": True})

    # test-category: pure-logic
    def test_explicit_artifact_tag_takes_precedence(self):
        self.assertEqual(self.select("refs/heads/main", "v0.1.0-preview.11"), {"browser": False})
        self.assertEqual(self.select("refs/heads/release/0.1.0-preview.11", "v0.1.0-preview.10"),
                         {"browser": True})

    # test-category: pure-logic
    def test_invalid_release_ref_defaults_on(self):
        self.assertEqual(self.select("refs/heads/release/../v0.1.0-preview.11"), {"browser": True})


if __name__ == "__main__":
    unittest.main()
