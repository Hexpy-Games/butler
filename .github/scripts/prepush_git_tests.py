"""Exercise the installed hook in disposable main and linked Git worktrees."""
import contextlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from prepush_tests import ROOT, PrepushChecks, isolate_git, prepush


class PrepushGitChecks(unittest.TestCase):
    def setUp(self):
        isolate_git(self)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'main'
        self.root.mkdir()
        self.remote = Path(self.temp.name) / 'remote.git'
        self.git(self.root, 'init', '-q', '-b', 'ci/main-check')
        files = ['.githooks/pre-push', 'scripts/prepush',
                 '.github/scripts/isolated.py', '.github/scripts/prepush.py',
                 '.github/scripts/branch-name.py', '.github/scripts/ci_rust_inputs.py',
                 '.github/scripts/prepush_cross.py']
        for name in files:
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, destination)
        self.commit(self.root, 'base')
        self.base = self.git(self.root, 'rev-parse', 'HEAD').strip()
        self.git(self.root, 'init', '-q', '--bare', str(self.remote))
        self.git(self.root, 'remote', 'add', 'origin', str(self.remote))
        self.git(self.root, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
        self.git(self.root, 'config', 'core.hooksPath', '.githooks')
        self.linked = Path(self.temp.name) / 'linked'
        self.git(self.root, 'worktree', 'add', '-qb', 'ci/linked', str(self.linked))
        # Commit scripts before installing the hook; test pushes only change payload.
        for worktree in (self.root, self.linked):
            (worktree / 'payload').write_text('committed\n')
            self.commit(worktree, 'payload')
            (worktree / 'not-pushed.rs').write_text('untracked\n')

    def git(self, worktree, *args):
        return subprocess.check_output(['git', *(['--work-tree=' + str(worktree)]
                                              if args[0] != 'init' else []), *args],
                                       cwd=worktree, text=True, stderr=subprocess.STDOUT)

    def commit(self, worktree, message):
        self.git(worktree, 'add', '.')
        self.git(worktree, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message)

    def push(self, worktree, ref):
        return self.git(worktree, 'push', '--dry-run', 'origin', ref)

    # test-category: pure-logic
    def test_main_and_linked_new_branch_push_without_upstream(self):
        for worktree, name in ((self.root, 'ci/main-check'), (self.linked, 'ci/linked')):
            with self.subTest(worktree=worktree):
                result = self.push(worktree, 'HEAD:refs/heads/' + name)
                self.assertIn('prepush: 1 changed paths vs ' + self.base, result)
                self.assertIn('branch-name.py ' + name, result)
                self.assertIn('prepush: PASS', result)
                self.assertNotIn('prepush: fmt:', result)

    # test-category: pure-logic
    def test_existing_remote_tip_and_pushed_commit_instead_of_head(self):
        self.git(self.root, '-c', 'core.hooksPath=/dev/null', 'push', '-q',
                 'origin', 'HEAD:refs/heads/ci/existing')
        tip = self.git(self.root, 'rev-parse', 'HEAD').strip()
        (self.root / 'later').write_text('later\n')
        self.commit(self.root, 'later')
        result = self.push(self.root, tip + ':refs/heads/ci/new-tip')
        self.assertIn('prepush: 1 changed paths', result)
        self.assertIn('pushed tip != HEAD', result)
        result = self.push(self.root, 'HEAD:refs/heads/ci/existing')
        self.assertIn('prepush: 2 changed paths vs ' + tip, result)

    # test-category: pure-logic
    def test_detached_head_push_uses_destination_branch(self):
        self.git(self.linked, 'checkout', '-q', '--detach')
        result = self.push(self.linked, 'HEAD:refs/heads/ci/detached')
        self.assertIn('branch-name.py ci/detached', result)
        self.assertIn('prepush: PASS', result)

    # test-category: pure-logic
    def test_delete_and_annotated_tag_push_run_no_checks(self):
        self.git(self.root, '-c', 'core.hooksPath=/dev/null', 'push', '-q',
                 'origin', 'HEAD:refs/heads/ci/delete')
        self.git(self.root, 'tag', '-am', 'tag', 'test-tag')
        for ref in (':refs/heads/ci/delete', 'refs/tags/test-tag'):
            result = self.push(self.root, ref)
            self.assertIn('prepush: no branch updates; no checks', result)
            self.assertNotIn('prepush: branch-name:', result)

    # test-category: security
    def test_inherited_git_state_is_removed_before_nested_repo_and_cargo(self):
        gitdir = self.git(self.linked, 'rev-parse', '--absolute-git-dir').strip()
        command = ['python3', str(ROOT / '.github/scripts/isolated.py'), 'python3', '-c',
                   'import os, shutil, subprocess, tempfile; '
                   'assert not any(k.startswith("GIT_") for k in os.environ); '
                   'd=tempfile.mkdtemp(); subprocess.run(["git", "init", "-q", d], check=True); '
                   # macOS temp dirs are symlinks (/var -> /private/var); Git
                   # reports the resolved path.
                   'assert os.path.realpath(subprocess.check_output(["git", "-C", d, "rev-parse", '
                   '"--show-toplevel"], text=True).strip()) == os.path.realpath(d); '
                   'shutil.rmtree(d); assert os.environ["HOME"] != os.environ["BUTLER_DATA"]']
        env = dict(os.environ, GIT_DIR=gitdir, GIT_WORK_TREE=str(self.linked),
                   GIT_INDEX_FILE=gitdir + '/index', GIT_COMMON_DIR=str(self.root / '.git'),
                   GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='user.name', GIT_CONFIG_VALUE_0='Test')
        subprocess.run(command, cwd=self.linked, env=env, check=True)
        result = subprocess.check_output(
            [str(self.linked / '.githooks/pre-push')], input=(
                f'HEAD {self.git(self.linked, "rev-parse", "HEAD").strip()} '
                f'refs/heads/ci/exported {"0" * 40}\n'), cwd=self.linked, env=env, text=True)
        self.assertIn('prepush: PASS', result)

    # test-category: security
    def test_fixtures_never_touch_the_calling_repository(self):
        # Hooks and `rebase --exec` in a linked worktree export GIT_DIR, and that
        # worktree shares .git/config with every other worktree.
        caller = Path(self.temp.name) / 'caller'
        subprocess.run(['git', 'init', '-q', '-b', 'ci/caller', str(caller)], check=True)
        subprocess.run(['git', '-C', str(caller), 'commit', '-q', '--allow-empty', '-m', 'caller'],
                       check=True)
        subprocess.run(['git', '-C', str(caller), 'worktree', 'add', '-q', '-b', 'ci/other',
                        str(Path(self.temp.name) / 'caller-linked')], check=True)
        config = caller / '.git/config'
        before = (config.read_text(), self.git(caller, 'for-each-ref'))
        fixtures = (PrepushChecks('test_changed_paths_include_commits_staged_unstaged_'
                                  'untracked_and_deletions'),
                    PrepushGitChecks('test_detached_head_push_uses_destination_branch'))
        with patch.dict(os.environ, GIT_DIR=str(caller / '.git/worktrees/caller-linked')):
            for fixture in fixtures:
                result = unittest.TestResult()
                fixture.run(result)
                self.assertTrue(result.wasSuccessful(), result.errors + result.failures)
        self.assertEqual((config.read_text(), self.git(caller, 'for-each-ref')), before)

    # test-category: pure-logic
    def test_shared_bare_config_does_not_break_linked_hook(self):
        self.git(self.root, 'config', 'core.bare', 'true')
        result = self.push(self.linked, 'HEAD:refs/heads/ci/bare-config')
        self.assertIn('prepush: PASS', result)

    # test-category: pure-logic
    def test_missing_remote_tip_falls_back_and_multiple_updates_are_checked(self):
        tip = self.git(self.linked, 'rev-parse', 'HEAD').strip()
        lines = f'HEAD {tip} refs/heads/ci/one {"1" * 40}\n'
        lines += f'HEAD {tip} refs/heads/ci/two {"0" * 40}\n'
        with patch.object(prepush, 'ROOT', self.linked), \
                patch('sys.stdin', io.StringIO(lines)), \
                patch.object(prepush, 'check_range', side_effect=[1, 0]) as check, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(prepush.main(['--hook']), 1)
        self.assertEqual(check.call_args_list[0].args, (self.base, tip, 'ci/one'))
        self.assertEqual(check.call_args_list[1].args, (self.base, tip, 'ci/two'))

    # test-category: pure-logic
    def test_no_origin_main_uses_upstream_then_remote_head_then_tip(self):
        self.git(self.root, 'remote', 'rename', 'origin', 'alternate')
        self.git(self.root, 'update-ref', 'refs/remotes/alternate/trunk', self.base)
        self.git(self.root, 'update-ref', '-d', 'refs/remotes/alternate/main')
        self.git(self.root, 'config', 'branch.ci/main-check.remote', 'alternate')
        self.git(self.root, 'config', 'branch.ci/main-check.merge', 'refs/heads/trunk')
        ref = 'HEAD:refs/heads/ci/fallback'
        result = self.git(self.root, 'push', '--dry-run', 'alternate', ref)
        self.assertIn('changed paths vs ' + self.base, result)
        self.git(self.root, 'config', '--unset', 'branch.ci/main-check.merge')
        self.git(self.root, 'symbolic-ref', 'refs/remotes/alternate/HEAD',
                 'refs/remotes/alternate/trunk')
        result = self.git(self.root, 'push', '--dry-run', 'alternate', ref)
        self.assertIn('changed paths vs ' + self.base, result)
        self.git(self.root, 'symbolic-ref', '--delete', 'refs/remotes/alternate/HEAD')
        result = self.git(self.root, 'push', '--dry-run', 'alternate', ref)
        self.assertEqual(result.count('WARNING: no base; CI checks'), 1)
        self.assertIn('prepush: 1 changed paths', result)
        self.assertIn('prepush: PASS', result)
        self.assertNotIn('Traceback', result)

    # test-category: pure-logic
    def test_unrelated_base_is_skipped_and_dirty_tree_warns(self):
        self.git(self.root, 'checkout', '-q', '--orphan', 'ci/unrelated')
        self.git(self.root, 'rm', '-rf', '.')
        (self.root / 'not-pushed.rs').unlink()
        (self.root / 'unrelated').write_text('root commit\n')
        self.commit(self.root, 'unrelated')
        unrelated = self.git(self.root, 'rev-parse', 'HEAD').strip()
        with patch.object(prepush, 'ROOT', self.root), \
                contextlib.redirect_stderr(io.StringIO()) as errors:
            base, paths = prepush.changed_paths(tip=unrelated)
        self.assertIsNone(base)
        self.assertEqual(paths, ['unrelated'])
        self.assertIn('no base; CI checks', errors.getvalue())
        (self.linked / 'payload').write_text('dirty\n')
        result = self.push(self.linked, 'HEAD:refs/heads/ci/dirty')
        self.assertIn('uncommitted changes may touch checked paths', result)
        self.assertIn('prepush: PASS', result)
