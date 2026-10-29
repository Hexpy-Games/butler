"""Selection boundaries for the separate experimental Cargo workspace."""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('shell_changes', Path(__file__).with_name('ci-changes.py'))
changes = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(changes)


class ShellSelection(unittest.TestCase):
    # test-category: format-pin
    def test_checks_and_experimental_packaging_run_independently(self):
        workflow = (Path(__file__).resolve().parents[1] / 'workflows/shell.yml').read_text()
        shell = workflow.split('  shell:\n', 1)[1].split('  package:\n', 1)[0]
        package = workflow.split('  package:\n', 1)[1]
        self.assertNotRegex(package, r'(?m)^    needs:')
        self.assertIn(
            "    if: github.event_name == 'workflow_dispatch' || "
            "(github.event_name == 'push' && github.ref == 'refs/heads/main')\n",
            package,
        )
        self.assertNotRegex(shell, r'\bcargo check\b')
        self.assertIn(
            'cargo clippy --locked --workspace --all-targets --profile test -- -D warnings',
            shell,
        )
        self.assertIn(
            "cache-on-failure: ${{ github.event_name == 'push' && "
            "github.ref == 'refs/heads/main' }}",
            shell,
        )

    # test-category: pure-logic
    def test_shell_has_only_explicit_inputs(self):
        paths = changes.command('git', 'ls-files').splitlines()
        paths += ['unknown/config.ini', '.github/workflows/unknown.yml',
                  '.github/workflows/shell.yml', 'packages/butler-shell/new/README.md',
                  'packages/butler-shell/Cargo.lock', 'packages/butler-shell/new/src/lib.rs']
        for path in paths:
            expected = path.startswith(('packages/butler-shell/',
                                       'packages/butler-agent/rust/tools/source-check/'))
            expected |= path == '.github/workflows/shell.yml'
            with self.subTest(path=path):
                self.assertEqual('shell' in changes.categories(path), expected)
                if path.startswith('packages/butler-shell/'):
                    self.assertEqual(changes.categories(path), {'shell'})

    # test-category: pure-logic
    def test_full_fallback_uses_changed_paths_and_dispatch_for_shell(self):
        for event, path, expected in [
            ('push', 'README.md', False),
            ('push', 'packages/butler-shell/Cargo.lock', True),
            ('pull_request', '.github/workflows/shell.yml', True),
            ('workflow_dispatch', 'README.md', True),
        ]:
            with self.subTest(event=event, path=path), patch.dict(os.environ, GITHUB_EVENT_NAME=event):
                required = set(changes.GROUPS)
                changes.ci_shell.select(required, True, 'shell.yml', None, {'before': 'base'},
                                        lambda base: [path], changes.categories)
                self.assertEqual('shell' in required, expected)

    # test-category: pure-logic
    def test_new_branch_push_compares_with_the_default_branch(self):
        for path, expected in [('README.md', False), ('.github/workflows/shell.yml', True)]:
            with self.subTest(path=path), patch.dict(os.environ, GITHUB_EVENT_NAME='push'):
                required = set(changes.GROUPS)
                diff = lambda base: [path] if base == 'fork' else []
                with patch.object(changes, 'command', return_value='fork') as command:
                    changes.ci_shell.select(required, True, 'shell.yml', '0' * 40,
                                            {'repository': {'default_branch': 'main'}},
                                            diff, changes.categories, command)
                command.assert_called_once_with('git', 'merge-base', 'HEAD', 'origin/main')
                self.assertEqual('shell' in required, expected)
