#!/usr/bin/env python3
"""Path-selected local checks; CI remains the authority for Clippy arguments."""
import argparse
import os
from pathlib import Path
import re
import runpy
import shlex
import shutil
import subprocess
import sys
import time
import types
import unittest

from prepush_cross import enable_hint, prerequisites

ROOT = Path(__file__).resolve().parents[2]
RUST = ROOT / 'packages/butler-agent/rust'
ISOLATE = ROOT / '.github/scripts/isolated.py'
ARM = 'aarch64-unknown-linux-gnu'
WINDOWS = 'x86_64-pc-windows-msvc'
MISSING_TOOLS = set()


def output(*args):
    if args[0] == 'git':
        args = ('git', '--work-tree=' + str(ROOT), *args[1:])
    cwd = RUST if args[0] in ('rustc', 'rustup') else ROOT
    return subprocess.check_output(args, cwd=cwd, text=True, stderr=subprocess.PIPE).rstrip('\n')


def git_optional(*args):
    try:
        return output('git', *args)
    except subprocess.CalledProcessError:
        return None


def comparison_base(tip='HEAD', local_ref='HEAD', remote='origin'):
    upstream = git_optional('rev-parse', '--symbolic-full-name', local_ref + '@{upstream}')
    default = git_optional('symbolic-ref', 'refs/remotes/' + remote + '/HEAD')
    for ref in ('origin/main', upstream, default):
        if ref:
            base = git_optional('merge-base', ref, tip)
            if base:
                return base
    print('prepush: WARNING: no base; CI checks', file=sys.stderr)
    return None


def changed_paths(base=None, tip=None):
    if base is None:
        base = comparison_base(tip or 'HEAD')
    # --no-renames retains both sides of moves across check boundaries.
    if base:
        paths = output('git', 'diff', '--name-only', '--no-renames', '-z',
                       base, *([tip] if tip else [])).split('\0')
    else:
        paths = (git_optional('diff-tree', '--root', '--no-commit-id', '--name-only',
                              '--no-renames', '-r', '-z', tip or 'HEAD') or '').split('\0')
    if tip is None:
        paths += output('git', 'ls-files', '--others', '--exclude-standard', '-z').split('\0')
    return base, sorted(set(paths) - {''})


def push_ranges(lines, remote='origin'):
    ranges = []
    for line in lines:
        local_ref, local_sha, remote_ref, remote_sha = line.split()
        if set(local_sha) == {'0'} or not remote_ref.startswith('refs/heads/'):
            continue
        base = remote_sha
        if set(base) == {'0'} or not git_optional('rev-parse', '--verify', base + '^{commit}'):
            base = comparison_base(local_sha, local_ref, remote)
        ranges.append((base or '', local_sha, remote_ref.removeprefix('refs/heads/')))
    return ranges


def clippy_lines(path):
    commands = []
    for line in (ROOT / path).read_text().splitlines():
        match = re.search(r'\bcargo clippy\s+(.+)$', line)
        if match and not line.lstrip().startswith('#'):
            commands.append(['cargo', 'clippy', *shlex.split(match[1])])
    if not commands:
        raise ValueError(f'No literal Clippy invocation in {path}; update prepush extraction')
    return commands


def for_target(command, target):
    command = list(command)
    if '--target' in command:
        if command[command.index('--target') + 1] != target:
            raise ValueError('CI Clippy target changed; update prepush target mapping')
    else:
        command[2:2] = ['--target', target]
    return command


def clippy_commands(host):
    host_commands = clippy_lines('.github/workflows/rust-clippy.yml')
    arm_commands = clippy_lines('.github/workflows/rust-archive.yml')
    windows_commands = clippy_lines('deploy/windows-preview-quality.ps1')
    return [(host, cmd) for cmd in host_commands] + [
        (ARM, for_target(cmd, ARM)) for cmd in arm_commands] + [
        (WINDOWS, for_target(cmd, WINDOWS)) for cmd in windows_commands]


def selection(paths):
    rust = any(p.startswith('packages/butler-agent/rust/') for p in paths)
    # Rust build scripts and include! inputs can live outside the workspace.
    if not rust:
        from ci_rust_inputs import consumes
        rust = any(consumes(p, ROOT) for p in paths)
    return {
        'rust': rust,
        'licenses': any(Path(p).name in ('Cargo.toml', 'Cargo.lock', 'package.json',
                                        'package-lock.json', 'bun.lock', 'bun.lockb')
                        or p.startswith('deploy/licenses/') for p in paths),
        'docs': any(Path(p).suffix.lower() in ('.md', '.txt', '.html')
                    or p == '.github/scripts/work-docs-lint.py' for p in paths),
        'workflows': [p for p in paths if p.startswith('.github/workflows/')
                      and Path(p).suffix in ('.yml', '.yaml') and (ROOT / p).is_file()],
        'powershell': [p for p in paths if p.endswith('.ps1') and (ROOT / p).is_file()],
    }


# Only these individual tests use the CI-installed OCI client. All their other
# tests still run locally; CI executes the original commands without filtering.
ORAS_TESTS = {
    'test-cargo-target.py': (
        'TargetSnapshot.test_local_oras_push_pull_verify_tamper_missing_and_write_once',),
    'test-native-deps.py': ('NativeDeps.test_native_sdk_local_oci_roundtrip_and_missing_tag',),
}


def ci_script_commands():
    source = (ROOT / '.github/workflows/rust-quality.yml').read_text()
    job = re.search(r'^  lint:.*?(?=^  [\w-]+:|\Z)', source, re.M | re.S)
    if not job or 'name: Repository and CI lint' not in job[0]:
        raise ValueError('Repository and CI lint job changed; update prepush extraction')
    commands = []
    for line in job[0].splitlines():
        match = re.fullmatch(
            r'\s*(?:run: )?python3 \.github/scripts/isolated\.py '
            r'(python3 \.github/scripts/test-[^\n]+)', line)
        if match:
            commands.append(shlex.split(match[1]))
        elif re.search(r'python3 .*test-[\w.-]+\.py', line):
            raise ValueError('CI-script invocation changed; update prepush extraction')
    if not commands:
        raise ValueError('No CI-script tests in Repository and CI lint')
    return commands


def python_tests(paths):
    inputs = {'scripts/prepush', '.githooks/pre-push', 'deploy/windows-preview-quality.ps1'}
    if inputs.intersection(paths) or any(p.startswith(('.github/scripts/', '.github/workflows/'))
                                         for p in paths):
        return ci_script_commands()
    return []


def local_ci_command(command):
    command = list(command)
    # The lint job obtains this file with authenticated gh api. Keep the offline
    # unittest suite, but never replace live workflow state with a fixture.
    if '--active-workflows' in command:
        index = command.index('--active-workflows')
        print('prepush: WARNING: SKIP live workflow-state check: missing '
              'GitHub API workflow-state file (network/auth); CI still checks it', file=sys.stderr)
        del command[index:index + 2]
    missing = ORAS_TESTS.get(Path(command[1]).name, ())
    oras = os.environ.get('BUTLER_ORAS_EXECUTABLE', 'oras')
    if missing and not shutil.which(oras):
        print(f'prepush: WARNING: SKIP {", ".join(missing)}: missing oras; '
              'CI still checks them', file=sys.stderr)
        return [command[0], str(Path(__file__).resolve()), '--ci-unittest',
                command[1], *missing]
    return command


def ci_unittest(script, skipped):
    namespace = runpy.run_path(str(Path(script).resolve()))
    for name in skipped:
        case, method = name.split('.')
        cls = namespace[case]
        setattr(cls, method, unittest.skip('missing oras; CI still checks it')(getattr(cls, method)))
    result = unittest.main(module=types.SimpleNamespace(**namespace), argv=[script], exit=False)
    return 0 if result.result.wasSuccessful() else 1


def tool_available(tool):
    if shutil.which(tool):
        return True
    if tool not in MISSING_TOOLS:
        print(f'prepush: WARNING: tool missing: {tool} — skipped, CI checks it', file=sys.stderr)
        MISSING_TOOLS.add(tool)
    return False


def run(label, command, cwd=ROOT):
    if not tool_available(str(command[0])):
        return True
    print(f'prepush: {label}: {shlex.join(map(str, command))}', flush=True)
    # Each check gets its own HOME/BUTLER_DATA, preserving the caller's caches.
    started = time.monotonic()
    code = subprocess.call([sys.executable, str(ISOLATE), *map(str, command)], cwd=cwd)
    passed = code == 0
    if not passed:
        print(f'prepush: {label}: exit {code}; diagnostics above', file=sys.stderr)
    print(f'prepush: {label}: {"PASS" if passed else "FAIL"} '
          f'{time.monotonic() - started:.2f}s', flush=True)
    return passed


def rust_checks():
    available = [tool_available(tool) for tool in ('cargo', 'rustc')]
    if not all(available):
        return True
    success = run('fmt', ['cargo', 'fmt', '--all', '--', '--check'], RUST)
    success = run('source-check', ['cargo', 'run', '--locked', '-p',
                                 'butler-source-check', '--', '.'], RUST) and success
    host = output('rustc', '-vV').split('host: ', 1)[1].splitlines()[0]
    has_rustup = tool_available('rustup')
    installed = set(output('rustup', 'target', 'list', '--installed').splitlines()) if has_rustup else set()
    ran, skipped = set(), set()
    availability = {}
    for target, command in clippy_commands(host):
        if target == host:
            success = run('clippy ' + target, command, RUST) and success
            continue
        if not has_rustup:
            skipped.add(target)
            continue
        if target not in availability:
            missing = prerequisites(target, installed, RUST)
            availability[target] = not missing
            if missing:
                skipped.add(target)
                print(f'prepush: WARNING: SKIP {target}: {"; ".join(missing)}; '
                      f'{enable_hint(target)}', file=sys.stderr)
        if availability[target]:
            ran.add(target)
            success = run('clippy ' + target, command, RUST) and success
    print(f'cross-target clippy: ran {len(ran)}, skipped {len(skipped)} (CI still checks them)',
          flush=True)
    return success


def powershell_check(paths):
    if not paths:
        return True
    if not tool_available('pwsh'):
        return True
    # Parse only; never execute the changed script. Environment avoids PS quoting.
    expression = ('$t=$null; $e=$null; '
                  '[System.Management.Automation.Language.Parser]::ParseFile('
                  '$env:PREPUSH_PS_FILE,[ref]$t,[ref]$e) > $null; '
                  'if ($e.Count) { $e | Out-String | Write-Error; exit 1 }')
    success = True
    for path in paths:
        os.environ['PREPUSH_PS_FILE'] = str(ROOT / path)
        success = run('PowerShell parse', ['pwsh', '-NoLogo', '-NoProfile',
                                          '-NonInteractive', '-Command', expression]) and success
    os.environ.pop('PREPUSH_PS_FILE', None)
    return success


def warn_working_tree(tip):
    if tip and tip != output('git', 'rev-parse', 'HEAD'):
        print('prepush: WARNING: pushed tip != HEAD; checks run on the working tree', file=sys.stderr)
    dirty = output('git', 'status', '--porcelain', '--untracked-files=normal')
    if dirty:
        print('prepush: WARNING: uncommitted changes may touch checked paths; '
              'checks run on the working tree', file=sys.stderr)


def check_range(base=None, tip=None, branch=None):
    started = time.monotonic()
    base, paths = changed_paths(base, tip)
    selected = selection(paths)
    warn_working_tree(tip)
    print(f'prepush: {len(paths)} changed paths vs {base}', flush=True)
    if branch is None:
        branch = output('git', 'symbolic-ref', '--quiet', '--short', 'HEAD')
    success = run('branch-name', ['python3', '.github/scripts/branch-name.py', branch])
    if base:
        success = run('whitespace', ['git', '--work-tree=' + str(ROOT), 'diff', '--check',
                                 base, *([tip] if tip else [])]) and success
    if selected['docs']:
        success = run('work-docs', ['python3', '.github/scripts/work-docs-lint.py']) and success
    if selected['workflows']:
        if tool_available('actionlint'):
            success = run('actionlint', ['actionlint', *selected['workflows']]) and success
    success = powershell_check(selected['powershell']) and success
    for command in python_tests(paths):
        success = run('CI-script ' + Path(command[1]).name, local_ci_command(command)) and success
    if base and selected['licenses']:
        success = run('notices', ['node', 'deploy/licenses/generate.mjs', '--check']) and success
        success = run('licenses', ['node', 'deploy/licenses/check.mjs']) and success
    if base and selected['rust']:
        success = rust_checks() and success
    print(f'prepush: {"PASS" if success else "FAIL"} in {time.monotonic() - started:.2f}s', flush=True)
    return 0 if success else 1


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] == '--ci-unittest':
        return ci_unittest(argv[1], argv[2:])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hook', action='store_true', help='read pre-push ref updates from stdin')
    parser.add_argument('--base', help='override the comparison base for local checks')
    parser.add_argument('--head', help='compare committed trees rather than local work')
    parser.add_argument('remote', nargs='?', default='origin')
    parser.add_argument('remote_url', nargs='?')
    args = parser.parse_args(argv)
    if args.hook:
        ranges = push_ranges(sys.stdin, args.remote)
        if not ranges:
            print('prepush: no branch updates; no checks')
        results = [check_range(base, tip, branch) for base, tip, branch in ranges]
        return 0 if all(result == 0 for result in results) else 1
    return check_range(args.base, args.head)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(f'prepush: {error}')
