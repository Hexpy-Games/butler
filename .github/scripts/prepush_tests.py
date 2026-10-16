"""Derived CI parity and local-entrypoint checks, loaded by integration-proof tests."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('prepush', ROOT / '.github/scripts/prepush.py')
prepush = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepush)


def ci_commands(path):
    # Independent extraction: compare every literal invocation, in order.
    return [shlex.split('cargo clippy ' + args) for args in re.findall(
        r'^\s*(?:run: )?(?:python3 .*isolated.py" )?cargo clippy (.+)$',
        (ROOT / path).read_text(), re.M)]


class PrepushChecks(unittest.TestCase):
    # test-category: format-pin
    def test_clippy_targets_and_flags_are_derived_from_ci(self):
        quality = (ROOT / '.github/workflows/rust-quality.yml').read_text()
        arm_job = quality.split('\n  linux-arm64-archive:', 1)[1].split('\n  linux-arm64-perf', 1)[0]
        self.assertIn('runner: ubuntu-24.04-arm', arm_job)
        self.assertIn('clippy: true', arm_job)
        self.assertIn('uses: ./.github/workflows/rust-archive.yml', arm_job)
        windows = (ROOT / '.github/workflows/windows-preview-smoke.yml').read_text()
        self.assertIn('run: ../../../deploy/windows-preview-quality.ps1', windows)
        host = 'x86_64-unknown-linux-gnu'
        expected = []
        sources = [(host, '.github/workflows/rust-clippy.yml'),
                   ('aarch64-unknown-linux-gnu', '.github/workflows/rust-archive.yml'),
                   ('x86_64-pc-windows-msvc', 'deploy/windows-preview-quality.ps1')]
        for target, source in sources:
            commands = ci_commands(source)
            self.assertTrue(commands, source)
            for command in commands:
                if '--target' not in command:
                    command[2:2] = ['--target', target]
                self.assertEqual(command[command.index('--target') + 1], target)
                expected.append((target, command))
        self.assertEqual(prepush.clippy_commands(host), expected)
        entry = (ROOT / 'scripts/prepush').read_text()
        self.assertIn('isolated.py python3 .github/scripts/prepush.py', entry)

    # test-category: pure-logic
    def test_rust_toolchain_discovery_uses_pinned_workspace(self):
        with patch.object(prepush.subprocess, 'check_output', return_value='installed\n') as call:
            for command in [('rustc', '-vV'), ('rustup', 'target', 'list', '--installed')]:
                self.assertEqual(prepush.output(*command), 'installed')
                self.assertEqual(call.call_args.kwargs['cwd'], prepush.RUST)
            prepush.output('git', 'rev-parse', 'HEAD')
            self.assertEqual(call.call_args.kwargs['cwd'], prepush.ROOT)

    # test-category: pure-logic
    def test_path_selection_and_deleted_inputs(self):
        docs = prepush.selection(['AGENTS.md'])
        self.assertTrue(docs['docs'])
        self.assertFalse(docs['rust'])
        self.assertFalse(docs['licenses'])
        rust = prepush.selection(['packages/butler-agent/rust/crates/deleted/src/lib.rs'])
        self.assertTrue(rust['rust'])
        self.assertFalse(rust['licenses'])
        self.assertTrue(prepush.selection(['packages/butler-agent/rust/Cargo.lock'])['licenses'])
        self.assertFalse(prepush.selection(['clock.rs'])['licenses'])
        self.assertTrue(prepush.selection(['.github/workflows/rust-clippy.yml'])['workflows'])

    # test-category: pure-logic
    def test_changed_paths_include_commits_staged_unstaged_untracked_and_deletions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root, text=True)
            git('init', '-q', '-b', 'ci/checks')
            git('config', 'user.email', 'test@example.invalid')
            git('config', 'user.name', 'Test')
            for name in ('deleted', 'unstaged', 'staged'):
                (root / name).write_text('base\n')
            git('add', '.')
            git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base')
            git('update-ref', 'refs/remotes/origin/main', 'HEAD')
            (root / 'committed').write_text('committed\n')
            git('add', '.')
            git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'change')
            (root / 'deleted').unlink()
            (root / 'staged').write_text('new\n')
            git('add', '.')
            (root / 'unstaged').write_text('new\n')
            (root / 'untracked space').write_text('new\n')
            with patch.object(prepush, 'ROOT', root):
                _, paths = prepush.changed_paths()
            self.assertEqual(paths, ['committed', 'deleted', 'staged', 'unstaged', 'untracked space'])

    # test-category: security
    def test_each_check_has_fresh_home_and_data_and_preserves_cache(self):
        command = ['python3', '-c',
                   'import os; from pathlib import Path; '
                   'assert os.environ["HOME"] != os.environ["BUTLER_DATA"]; '
                   'assert not (Path.home()/"marker").exists(); '
                   '(Path.home()/"marker").touch(); '
                   'assert os.environ.get("CARGO_HOME"); assert os.environ.get("RUSTUP_HOME")']
        self.assertTrue(prepush.run('isolation 1', command))
        self.assertTrue(prepush.run('isolation 2', command))

    # test-category: pure-logic
    def test_missing_targets_fail_without_installing(self):
        calls = []
        def output(*args):
            return 'host: x86_64-unknown-linux-gnu' if args[0] == 'rustc' else ''
        with patch.object(prepush, 'output', side_effect=output), \
                patch.object(prepush, 'run', side_effect=lambda *a: calls.append(a) or True), \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            self.assertFalse(prepush.rust_checks())
        for target in ('x86_64-unknown-linux-gnu', prepush.ARM, prepush.WINDOWS):
            self.assertIn('rustup target add ' + target, errors.getvalue())
        self.assertEqual([c[0] for c in calls], ['fmt', 'source-check'])

    # test-category: pure-logic
    def test_required_tool_failure_propagates_and_powershell_warns(self):
        with patch.object(prepush, 'changed_paths', return_value=('HEAD', ['.github/workflows/rust-clippy.yml'])), \
                patch.object(prepush, 'output', return_value='ci/checks'), \
                patch.object(prepush, 'run', return_value=True), \
                patch.object(prepush.shutil, 'which', return_value=None), \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            self.assertEqual(prepush.main([]), 1)
            self.assertIn('go install github.com/rhysd/actionlint', errors.getvalue())
            self.assertTrue(prepush.powershell_check(['deploy/test.ps1']))
            self.assertIn('WARNING: pwsh', errors.getvalue())
        with patch.object(prepush, 'changed_paths', return_value=('HEAD', [])), \
                patch.object(prepush, 'output', return_value='ci/checks'), \
                patch.object(prepush, 'run', return_value=False):
            self.assertEqual(prepush.main([]), 1)

    # test-category: format-pin
    def test_hook_is_executable_and_cannot_silently_skip_checks(self):
        hook = ROOT / '.githooks/pre-push'
        self.assertTrue(os.access(hook, os.X_OK))
        self.assertEqual(hook.read_text().splitlines()[-1], 'exec "$root/scripts/prepush" --hook')
        self.assertNotRegex(hook.read_text(), r'\|\| true|SKIP|NO_VERIFY')
        tests = prepush.python_tests(['scripts/prepush', '.github/scripts/prepush.py'])
        self.assertIn('.github/scripts/test-integration-proof.py', tests)
