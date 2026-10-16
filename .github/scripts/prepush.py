#!/usr/bin/env python3
"""Path-selected local checks; CI remains the authority for Clippy arguments."""
import argparse
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import time

from prepush_cross import enable_hint, prerequisites

ROOT = Path(__file__).resolve().parents[2]
RUST = ROOT / 'packages/butler-agent/rust'
ISOLATE = ROOT / '.github/scripts/isolated.py'
ARM = 'aarch64-unknown-linux-gnu'
WINDOWS = 'x86_64-pc-windows-msvc'


def output(*args):
    if args[0] == 'git':
        args = ('git', '--work-tree=' + str(ROOT), *args[1:])
    cwd = RUST if args[0] in ('rustc', 'rustup') else ROOT
    return subprocess.check_output(args, cwd=cwd, text=True).rstrip('\n')


def changed_paths(base=None, tip=None):
    base = base or output('git', 'merge-base', 'origin/main', tip or 'HEAD')
    # --no-renames retains both sides of moves across check boundaries.
    paths = output('git', 'diff', '--name-only', '--no-renames', '-z', base, *([tip] if tip else [])).split('\0')
    if tip is None:
        paths += output('git', 'ls-files', '--others', '--exclude-standard', '-z').split('\0')
    return base, sorted(set(paths) - {''})


def push_ranges(lines):
    ranges = []
    for line in lines:
        local_ref, local_sha, remote_ref, remote_sha = line.split()
        if set(local_sha) == {'0'} or not remote_ref.startswith('refs/heads/'):
            continue
        base = remote_sha
        if set(base) == {'0'}:
            base = output('git', 'merge-base', 'origin/main', local_sha)
        else:
            # A remote's old tip need not be in the local object database.
            try:
                output('git', 'cat-file', '-e', base + '^{commit}')
            except subprocess.CalledProcessError:
                base = output('git', 'merge-base', 'origin/main', local_sha)
        ranges.append((base, local_sha, remote_ref.removeprefix('refs/heads/')))
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
    return [(host, for_target(cmd, host)) for cmd in host_commands] + [
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


def python_tests(paths):
    tests = set()
    for path in paths:
        if path.startswith('.github/scripts/') and path.endswith('.py'):
            candidate = ROOT / path
            if candidate.name.startswith('test-'):
                tests.add(path)
            sibling = candidate.with_name('test-' + candidate.name)
            if sibling.is_file():
                tests.add(sibling.relative_to(ROOT).as_posix())
    # The derived prepush tests are also loaded by the existing CI entry point.
    inputs = {'scripts/prepush', '.githooks/pre-push', '.github/scripts/prepush.py',
              '.github/scripts/prepush_tests.py', '.github/scripts/prepush_git_tests.py',
              '.github/scripts/prepush_cross.py',
              '.github/scripts/isolated.py', 'deploy/windows-preview-quality.ps1'}
    if inputs.intersection(paths) or any(p.startswith('.github/workflows/') for p in paths):
        tests.add('.github/scripts/test-integration-proof.py')
    return sorted(tests)


def run(label, command, cwd=ROOT):
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
    success = run('fmt', ['cargo', 'fmt', '--all', '--', '--check'], RUST)
    success = run('source-check', ['cargo', 'run', '--locked', '-p',
                                 'butler-source-check', '--', '.'], RUST) and success
    host = output('rustc', '-vV').split('host: ', 1)[1].splitlines()[0]
    installed = set(output('rustup', 'target', 'list', '--installed').splitlines())
    ran, skipped = set(), set()
    availability = {}
    for target, command in clippy_commands(host):
        if target == host:
            success = run('clippy ' + target, command, RUST) and success
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
    if not shutil.which('pwsh'):
        print('prepush: WARNING: pwsh unavailable; changed .ps1 files were not parsed',
              file=sys.stderr)
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


def check_range(base=None, tip=None, branch=None):
    started = time.monotonic()
    base, paths = changed_paths(base, tip)
    selected = selection(paths)
    print(f'prepush: {len(paths)} changed paths vs {base}', flush=True)
    if branch is None:
        branch = output('git', 'symbolic-ref', '--quiet', '--short', 'HEAD')
    success = run('branch-name', ['python3', '.github/scripts/branch-name.py', branch])
    success = run('whitespace', ['git', '--work-tree=' + str(ROOT), 'diff', '--check',
                                 base, *([tip] if tip else [])]) and success
    if selected['docs']:
        success = run('work-docs', ['python3', '.github/scripts/work-docs-lint.py']) and success
    if selected['workflows']:
        if not shutil.which('actionlint'):
            print('prepush: actionlint missing; install: go install '
                  'github.com/rhysd/actionlint/cmd/actionlint@latest', file=sys.stderr)
            success = False
        else:
            success = run('actionlint', ['actionlint', *selected['workflows']]) and success
    success = powershell_check(selected['powershell']) and success
    for test in python_tests(paths):
        success = run('CI-script tests', ['python3', test]) and success
    if selected['licenses']:
        success = run('notices', ['node', 'deploy/licenses/generate.mjs', '--check']) and success
        success = run('licenses', ['node', 'deploy/licenses/check.mjs']) and success
    if selected['rust']:
        success = rust_checks() and success
    print(f'prepush: {"PASS" if success else "FAIL"} in {time.monotonic() - started:.2f}s', flush=True)
    return 0 if success else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hook', action='store_true', help='read pre-push ref updates from stdin')
    parser.add_argument('--base', help='override the comparison base for local checks')
    parser.add_argument('--head', help='compare committed trees rather than local work')
    args = parser.parse_args(argv)
    if args.hook:
        ranges = push_ranges(sys.stdin)
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
