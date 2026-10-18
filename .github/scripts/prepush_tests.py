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

import prepush_cross

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('prepush', ROOT / '.github/scripts/prepush.py')
prepush = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepush)


def ci_commands(path):
    # Independent extraction: compare every literal invocation, in order.
    return [shlex.split('cargo clippy ' + args) for args in re.findall(
        r'^\s*(?:run: )?(?:python3 .*isolated.py" )?cargo clippy (.+)$',
        (ROOT / path).read_text(), re.M)]


def isolate_git(test):
    """Keep fixture Git calls in their temp repos, whatever Git state the caller exports."""
    # Hooks and `rebase --exec` in a linked worktree export GIT_DIR; fixture `git init`
    # and `git config` would then write the caller's .git/config, shared by all worktrees.
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    identity = {'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.invalid',
                'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.invalid'}
    env.update(identity, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
    patcher = patch.dict(os.environ, env, clear=True)
    patcher.start()
    test.addCleanup(patcher.stop)


class PrepushChecks(unittest.TestCase):
    def setUp(self):
        isolate_git(self)

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
                if target != host and '--target' not in command:
                    command[2:2] = ['--target', target]
                if target != host:
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
    def test_cross_targets_skip_missing_prerequisites_but_host_runs(self):
        calls = []
        host = 'aarch64-apple-darwin'
        with patch.object(prepush, 'output', side_effect=['host: ' + host, host]), \
                patch.object(prepush, 'prerequisites', return_value=['C compiler missing']), \
                patch.object(prepush, 'run', side_effect=lambda *a: calls.append(a) or True), \
                contextlib.redirect_stderr(io.StringIO()) as errors, \
                contextlib.redirect_stdout(io.StringIO()) as summary:
            self.assertTrue(prepush.rust_checks())
        self.assertEqual(len(errors.getvalue().splitlines()), 2)
        self.assertIn('WARNING: SKIP ' + prepush.ARM + ': C compiler missing', errors.getvalue())
        self.assertIn('cargo-zigbuild/zig', errors.getvalue())
        self.assertIn('xwin', errors.getvalue())
        self.assertIn('ran 0, skipped 2 (CI still checks them)', summary.getvalue())
        self.assertTrue(all(c[0] in ('fmt', 'source-check', 'clippy ' + host) for c in calls))

    # test-category: pure-logic
    def test_ready_cross_targets_run_and_lint_or_build_failure_fails(self):
        host = 'aarch64-apple-darwin'
        for passed in (True, False):
            with self.subTest(passed=passed), \
                    patch.object(prepush, 'output', side_effect=['host: ' + host, host]), \
                    patch.object(prepush, 'prerequisites', return_value=[]), \
                    patch.object(prepush, 'run', side_effect=lambda label, *a:
                                 passed if label == 'clippy ' + prepush.ARM else True) as run, \
                    contextlib.redirect_stdout(io.StringIO()) as summary:
                self.assertEqual(prepush.rust_checks(), passed)
                self.assertIn('ran 2, skipped 0', summary.getvalue())
                self.assertIn('clippy ' + prepush.ARM, [c.args[0] for c in run.call_args_list])

    # test-category: pure-logic
    def test_cross_probe_checks_std_compiler_linker_and_headers(self):
        target = prepush.ARM
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(prepush_cross.shutil, 'which', return_value=None):
            missing = prepush_cross.prerequisites(target, set(), ROOT)
            self.assertIn('rustup target add ' + target, missing[0])
            self.assertIn('C compiler unavailable', missing[1])
        env = {'CC_' + target.replace('-', '_'): 'clang',
               'CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER': 'missing-ld'}
        with patch.dict(os.environ, env, clear=True), \
                patch.object(prepush_cross.shutil, 'which', side_effect=lambda c: c != 'missing-ld'):
            self.assertEqual(prepush_cross.probe_c_toolchain(target, ROOT),
                             'linker unavailable: missing-ld')
        for code in (0, 1):
            with patch.dict(os.environ, {'CC_' + target: 'clang'}, clear=True), \
                    patch.object(prepush_cross.shutil, 'which', return_value='clang'), \
                    patch.object(prepush_cross.subprocess, 'run', return_value=
                                 subprocess.CompletedProcess([], code, '', 'fatal: stdlib.h missing')) as run:
                reason = prepush_cross.probe_c_toolchain(target, ROOT)
                self.assertEqual(bool(reason), bool(code))
                if code:
                    self.assertIn('stdlib.h missing', reason)
                self.assertIn('--target=' + target, run.call_args.args[0])

    # test-category: pure-logic
    def test_cross_compiler_env_precedence_and_linker_driver(self):
        target = prepush.ARM
        env = {'CC': 'cc', 'TARGET_CC': 'target-cc',
               'CC_' + target.replace('-', '_'): 'underscore-cc',
               'CC_' + target: 'clang', 'CFLAGS': '-O1', 'TARGET_CFLAGS': '-O2',
               'CFLAGS_' + target.replace('-', '_'): '-O3'}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(prepush_cross.compiler_command(target),
                             ['clang', '--target=' + target, '-O1', '-O2', '-O3'])
        with patch.dict(os.environ, {
                'CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER': '/cross/bin/aarch64-linux-gnu-gcc'
                }, clear=True):
            self.assertEqual(prepush_cross.compiler_command(target), ['/cross/bin/aarch64-linux-gnu-gcc'])

    # test-category: pure-logic
    def test_clippy_lint_and_non_lint_exit_codes_both_fail(self):
        for code in (1, 101):
            with self.subTest(code=code), \
                    patch.object(prepush.subprocess, 'call', return_value=code), \
                    contextlib.redirect_stderr(io.StringIO()) as errors, \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(prepush.run('clippy', ['cargo', 'clippy']))
                self.assertIn(f'exit {code}; diagnostics above', errors.getvalue())

    # test-category: pure-logic
    def test_missing_tools_skip_but_real_check_failure_propagates(self):
        with patch.object(prepush, 'changed_paths', return_value=('HEAD', ['.github/workflows/rust-clippy.yml'])), \
                patch.object(prepush, 'output', return_value='ci/checks'), \
                patch.object(prepush, 'run', return_value=True), \
                patch.object(prepush.shutil, 'which', return_value=None), \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            self.assertEqual(prepush.main([]), 0)
            self.assertIn('tool missing: actionlint', errors.getvalue())
            self.assertTrue(prepush.powershell_check(['deploy/test.ps1']))
            self.assertIn('tool missing: pwsh', errors.getvalue())
        with patch.object(prepush, 'changed_paths', return_value=('HEAD', [])), \
                patch.object(prepush, 'output', return_value='ci/checks'), \
                patch.object(prepush, 'run', return_value=False):
            self.assertEqual(prepush.main([]), 1)

    # test-category: format-pin
    def test_hook_is_executable_and_cannot_silently_skip_checks(self):
        hook = ROOT / '.githooks/pre-push'
        self.assertTrue(os.access(hook, os.X_OK))
        self.assertEqual(hook.read_text().splitlines()[-1], 'exec "$root/scripts/prepush" --hook "$@"')
        self.assertNotRegex(hook.read_text(), r'\|\| true|SKIP|NO_VERIFY')
        tests = prepush.python_tests(['scripts/prepush', '.github/scripts/prepush.py'])
        self.assertIn('.github/scripts/test-integration-proof.py', tests)

    # test-category: pure-logic
    def test_missing_rust_and_node_tools_warn_once_without_running(self):
        for tool in ('cargo', 'rustc', 'node'):
            with self.subTest(tool=tool), \
                    patch.object(prepush, 'MISSING_TOOLS', set()), \
                    patch.object(prepush.shutil, 'which', side_effect=lambda name:
                                 None if name == tool else '/tools/' + name), \
                    patch.object(prepush.subprocess, 'call') as call, \
                    contextlib.redirect_stderr(io.StringIO()) as errors:
                for _ in range(2):
                    if tool == 'node':
                        self.assertTrue(prepush.run('notices', ['node', 'generate.mjs']))
                    else:
                        self.assertTrue(prepush.rust_checks())
                call.assert_not_called()
                self.assertEqual(errors.getvalue().splitlines(),
                                 [f'prepush: WARNING: tool missing: {tool} — skipped, CI checks it'])
