#!/usr/bin/env python3
"""Select smoke/integration checks and reuse proven identical inputs."""
import fnmatch
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile

# Also importable by pure-logic tests loaded from an absolute file path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from ci_policy import CI_TEST_INPUTS, rust_jobs, windows_preview_jobs
import ci_parts
import ci_rust_inputs
import ci_runtime_crates
import ci_tool_path
import ci_receipts
import ci_shell
from ci_main_baseline import latest_main_run
from urllib.parse import urlencode

GROUPS = ('shell', 'rust', 'ui', 'site', 'ds', 'package', 'install', 'linux-package', 'workflows', 'licenses', 'signing')
SHARED = ('VERSION', 'LICENSE', 'package.json', 'bun.lock*', 'bunfig.toml', 'tsconfig*.json',
          '*eslint*', '*stylelint*', '*prettier*')
WINDOWS_BROWSER_INPUTS = ('tests/smoke/composer-permission-agent-smoke.ts',
                          'tests/support/smoke-browser*', 'tests/support/bun-child-stdio.ts')
PACKAGING = ('packages/butler-app/client/electron/*', 'packages/butler-app/electron/*',
             'packages/butler-app/main/*', 'packages/butler-app/scripts/release/*',
             'packages/butler-app/scripts/windows/*', 'deploy/*',
             'tests/smoke/*update*', 'tests/smoke/quick-fixes*', 'tests/smoke/settings-release*',
             'tests/support/quick-fixes*', 'tests/support/native-app-server*',
             'tests/support/update-work*', 'tests/support/electron-page-cdp*',
             'packages/butler-app/client/ui/src/components/layout/SessionObserverTimeline.tsx',
             'packages/butler-app/client/ui/src/components/settings/Update*') + WINDOWS_BROWSER_INPUTS
# PR packaging exceptions; main/release still exercise every Rust payload change.
PR_PACKAGING = PACKAGING + ('VERSION', 'Cargo.toml', 'Cargo.lock', '**/Cargo.toml',
                            '**/Cargo.lock', 'packages/butler-agent/rust/scripts/*',
                            'packages/butler-agent/rust/crates/butler-platform/**')
BUN_MACOS = ('tests/unit/prepare-native-agent-script.test.ts',
             'tests/unit/run-fast-unit-tests.sh', 'tools/validation/*',
             '.github/workflows/bun-unit.yml')
MACOS = ('packages/butler-agent/rust/crates/butler-platform/**',
         '**/*macos*', '**/*darwin*', 'deploy/macos*')
# These harness inputs are never shipped in a production Agent payload.
RUST_TEST_ONLY = ('packages/butler-agent/rust/crates/butler-e2e/tests/*',
                  'packages/butler-agent/rust/crates/butler-e2e/fixtures/*')
SITE_CHECK_INPUTS = ('tests/smoke/ds-site-*', 'tests/smoke/font-assets-check.ts',
                     'tests/support/smoke-browser.ts', 'tests/support/ds-viewer-mobile-checks.ts')
SIGNING = ('deploy/macos*', 'packages/butler-app/scripts/release/*',
           'packages/butler-app/client/electron/*',
           'packages/butler-agent/rust/scripts/package-standalone-agent.py',
           'packages/butler-agent/rust/scripts/check_host_links.py',
           'VERSION', 'package.json', 'bun.lock', 'bun.lockb')
# Native Windows smoke inputs beyond Rust; other CI configuration stays out.
WINDOWS = ('deploy/windows**', '.github/workflows/**windows**', '.github/actions/**windows**/**',
           '.github/actions/release-python/**', '.github/actions/rust-agent-setup/**', '.github/scripts/**windows**',
           'windows**', '**/windows**', '**/windows**/**',
           'packages/butler-agent/rust/crates/butler-platform/**',
           'packages/butler-agent/rust/crates/butler-vault/**',
           'packages/butler-agent/rust/crates/butler-e2e/src/bin/e2e-vault.rs',
           'packages/butler-agent/rust/crates/butler-e2e/tests/vault.rs',
           'packages/butler-agent/rust/crates/butler-e2e/tests/vault/**',
           'packages/butler-agent/rust/crates/butler-e2e/tests/e2e/windows_**') + WINDOWS_BROWSER_INPUTS

# Lint-only inputs have no product consumer. Matching consumer rules below also
# apply: integration reuse hashes must observe release-only workflow changes.
CI_LINT_ONLY = (
    '.github/workflows/ci-windows-main-failure.yml', '.github/workflows/release*.yml',
    '.github/workflows/post-release-verify.yml', '.github/workflows/macos-release-recovery.yml',
    '.github/workflows/e2e.yml', '.github/workflows/branch-name.yml', '.github/workflows/ds-approval.yml', '.github/workflows/ci-store-maintenance.yml',
    '.github/scripts/integration-proof.py', '.github/scripts/recover-release.py', '.github/scripts/publish-release-checksums.py', '.github/scripts/test-*.py',
    '.github/scripts/ci-changes.py', '.github/scripts/ci_parts.py', '.github/scripts/ci_consumer_test_support.py',
    '.github/scripts/ci_rust_inputs.py', '.github/scripts/ci_input_tests.py', '.github/scripts/ci_tier_tests.py', '.github/scripts/ci_receipts.py',
    '.github/scripts/ci_runtime_crates.py', '.github/scripts/runtime-crates.json', '.github/scripts/ci_runtime_tests.py',
    '.github/scripts/ci_ds_approval_tests.py', '.github/scripts/ci_main_failure.py', '.github/scripts/ci_main_baseline.py',
    '.github/scripts/ci-main-gate.py', '.github/scripts/ci_windows_cascade_tests.py', '.github/scripts/ci-check-selected.py', '.github/scripts/ds-approval.py',
    '.github/workflows/issue-links.yml', '.github/scripts/issue_links.py',
)
# Integration packaging keys include Rust/UI and transitive producer inputs.
NATIVE_CI = ('rust', 'ui', 'package', 'install', 'linux-package')
CI_CONSUMERS = (
    # Lint publishes both workflow and license receipts. Its tested scripts and
    # their transitive imports must invalidate the license receipt as well.
    (('licenses',), (
        '.github/scripts/test-*.py', '.github/scripts/ds-approval.py', '.github/scripts/cargo-artifact-cache.py', '.github/scripts/agent-provenance.py',
        '.github/scripts/integration-proof.py', '.github/scripts/recover-release.py', '.github/scripts/check-gate.py', '.github/scripts/ci_tool_path.py',
        '.github/scripts/ci-check-selected.py', '.github/scripts/cargo-target-release.py',
        '.github/scripts/runner_cache.py', '.github/scripts/ci-changes.py',
        '.github/scripts/ci_policy.py', '.github/scripts/ci_parts.py',
        '.github/scripts/ci_consumer_test_support.py', '.github/scripts/ci_rust_inputs.py',
        '.github/scripts/ci_input_tests.py', '.github/scripts/ci_tier_tests.py',
        '.github/scripts/ci_ds_approval_tests.py', '.github/scripts/ci_runtime_crates.py',
        '.github/scripts/runtime-crates.json', '.github/scripts/ci_runtime_tests.py',
        '.github/scripts/ci_receipts.py', '.github/scripts/ci_main_failure.py',
        '.github/scripts/ci_main_baseline.py', '.github/scripts/ci-main-gate.py',
        '.github/scripts/issue_links.py', '.github/scripts/ci_windows_cascade_tests.py',
        '.github/scripts/prepare-windows-zstd.py',
        '.github/scripts/*windows*safety.py')),
    (('rust',), ('.github/workflows/rust-*.yml', '.github/scripts/ci_runtime_crates.py',
                  '.github/scripts/runtime-crates.json')),
    (NATIVE_CI, (
        '.github/workflows/rust-archive.yml', '.github/workflows/rust-tests.yml',
        '.github/actions/e2e-stub/*', '.github/workflows/native-agent.yml',
        '.github/actions/publish-cargo-target/*', '.github/workflows/install-smoke.yml',
        '.github/workflows/merge-agent-manifests.yml',
        '.github/scripts/test-ci-invariants.py', '.github/scripts/test-native-archive-safety.py',
        '.github/scripts/test-windows-ci-safety.py',
        '.github/scripts/test-windows-command-coverage.py')),
    (NATIVE_CI + ('workflows',), (
        '.github/scripts/agent-provenance.py', '.github/scripts/cargo-artifact-cache.py',
        '.github/scripts/cargo-target-release.py', '.github/scripts/runner_cache.py',
        '.github/scripts/check-gate.py', '.github/scripts/ci_policy.py',
        '.github/scripts/ci_tool_path.py', '.github/actions/release-python/**',
        '.github/actions/rust-agent-setup/*', '.github/actions/build-agent-archive/*',
        '.github/workflows/linux-packages.yml', '.github/workflows/macos-app-package.yml',
        '.github/scripts/*windows*safety.py', '.github/scripts/prepare-windows-zstd.py')),
    (NATIVE_CI, ('.github/workflows/macos-*.yml',)),
    (('signing',), ('.github/workflows/macos-selftest.yml',)),
    (('ui',), ('.github/workflows/bun-*.yml',)),
    (NATIVE_CI + ('site', 'ds', 'workflows'), ('.github/actions/bun-setup/*',)),
    (('site', 'ds', 'workflows'), ('.github/workflows/*site*.yml',)),
    (('rust', 'ui', 'package'), ('.github/workflows/*windows*.yml',
                               '.github/actions/*windows*/**', '.github/scripts/*windows*')),
    (('workflows',), ('.github/actions/build-windows-agent/*',
                      '.github/actions/package-windows-app/*',
                      '.github/actions/windows-runner-*/*',
                      '.github/actions/windows-preview-gate/*',
                      '.github/workflows/windows-powershell-diagnostics.yml',
                      '.github/workflows/windows-released-smoke.yml')),
)

# The locked inventory declares the non-manifest inputs it fingerprints too.
# Read the checkout, never an owner's runtime data directory.
LICENSE_INPUTS = set(json.loads((Path(__file__).resolve().parents[2] /
                                'deploy/licenses/catalog.json').read_text(encoding='utf-8'))['inputs'])


def matches(path, patterns):
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def github_categories(path):
    if path == '.github/workflows/shell.yml':
        return {'shell'}
    if path.endswith('.md') or path.startswith('.github/releases/'):
        return set()
    # This orchestrator owns all groups, unlike the reusable rust-* jobs.
    if path == '.github/workflows/rust-quality.yml':
        return set(GROUPS) - {'shell'}
    groups = {group for consumers, patterns in CI_CONSUMERS
              if matches(path, patterns) for group in consumers}
    if not groups and not matches(path, CI_LINT_ONLY):
        return set(GROUPS) - {'shell'}  # Unknown legacy CI inputs fail closed.
    return groups | {'workflows'}  # Lint and ci-invariants read every CI input.


def categories(path, event=None):
    if path.startswith('packages/butler-shell/'):
        return {'shell'}
    if path.startswith('.github/'):
        return github_categories(path)
    notice = re.match(r'^(licen[cs]e|copying|notice|copyright)([._-]|$)', Path(path).name, re.I)
    license_input = path in LICENSE_INPUTS or bool(notice)
    external_rust = ci_rust_inputs.consumes(path, Path(__file__).resolve().parents[2])
    runtime_markdown = (path.startswith('packages/butler-agent/resources/') or
                        (path.startswith('packages/butler-agent/rust/') and '/crates/' in path and '/docs/' not in path)) and not path.endswith('/README.md')
    # Repository and CI lint is unconditional in rust-quality.yml, including docs-only PRs.
    if path.endswith('.md') and not path.startswith('packages/butler-site/') and not runtime_markdown and not license_input and not external_rust:
        return set()
    result = set()
    rust = external_rust or path.startswith(('packages/butler-agent/rust/', 'packages/butler-agent/resources/', '.cargo/', '.config/')) or matches(path, ('Cargo.*', '**/Cargo.toml', '**/Cargo.lock', 'rust-toolchain*'))
    package = matches(path, PACKAGING)
    shared = matches(path, SHARED)
    ui = path.startswith(('packages/butler-app/client/', 'packages/butler-i18n/'))
    if rust or path == 'VERSION':
        result.add('rust')
    if (rust and not matches(path, RUST_TEST_ONLY) and
            (event != 'pull_request' or matches(path, PR_PACKAGING))) or package or path == 'VERSION':
        result.update(('package', 'install', 'linux-package'))
    bun_source = path.startswith('packages/') and not path.startswith('packages/butler-agent/rust/') and path.endswith(('.ts', '.tsx', '.js', '.jsx', '.mjs'))
    manifest = path.startswith('packages/') and path.endswith('/package.json')
    if ui or shared or bun_source or manifest or path.startswith(('tests/', 'tools/')) or (path.startswith('packages/') and not rust and not package and not path.startswith('packages/butler-site/')):
        result.add('ui')
    if path.startswith(('packages/butler-site/', 'packages/butler-app/client/ui/', 'packages/butler-i18n/')) or shared or matches(path, SITE_CHECK_INPUTS):
        result.add('site')
    # DS showcase/config/smoke imports can reach any UI-check input. Retain the
    # conservative UI implication until its complete input graph is selected.
    if 'ui' in result:
        result.add('ds')
    if license_input or matches(path, ('*.lock', '*.lockb', '*-lock.json', 'Cargo.lock', 'Cargo.toml', '**/Cargo.toml', '**/package.json', 'deploy/licenses/*', '**/licenses/*', 'LICENSE*')):
        result.add('licenses')
    if matches(path, SIGNING):
        result.add('signing')
    if matches(path, CI_TEST_INPUTS):
        result.add('workflows')
    # Unknown executable/configuration inputs fail closed, rather than silently
    # leaving a new package or tool untested. Assets/readme are product assets.
    if not result and not path.startswith('assets/readme/'):
        result = set(GROUPS) - {'workflows', 'shell'}
    if path.startswith('packages/butler-agent/rust/tools/source-check/'):
        result.add('shell')
    return result


def windows_native(path):
    return matches(path, WINDOWS)


def windows_runtime(path, event=None):
    # Crates the Windows agent links, from the checked-in Cargo graph closure.
    return 'rust' in categories(path, event) and ci_runtime_crates.selects(path, ci_rust_inputs.consumes)


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def changed(base, head='HEAD'):
    # Diff from the merge base so commits that reached the base branch after
    # this branch forked are not counted as this change's paths.
    try:
        base = command('git', 'merge-base', base, head)
    except subprocess.CalledProcessError:
        pass
    # --no-renames includes both removed and added paths; NUL handles any name.
    raw = subprocess.check_output(['git', 'diff', '--no-renames', '--name-only', '-z', base, head])
    return raw.decode().split('\0')[:-1]


def hashes(base):
    digests = {group: hashlib.sha256(b'ci-inputs-v1') for group in GROUPS}
    raw = subprocess.check_output(['git', 'ls-tree', '-rz', 'HEAD'])
    for entry in raw.split(b'\0'):
        if not entry:
            continue
        path = entry.split(b'\t', 1)[1].decode()
        for group in categories(path):
            digests[group].update(entry + b'\0')
    return {group: digest.hexdigest() for group, digest in digests.items()}


trusted_run = ci_receipts.trusted_run


def api_items(path, key):
    pages = json.loads(command('gh', 'api', path, '--paginate', '--slurp'))
    return [item for page in pages for item in page[key]]


def previous(repository, pr, workflow, branch=None, base_ref=None, current_head=None):
    return ci_receipts.previous(repository, pr, workflow, branch, base_ref, api_items, current_head)


def tier():
    ref = os.environ.get('GITHUB_REF', '')
    integration = ref.startswith('refs/heads/release/') and os.environ['GITHUB_EVENT_NAME'] in ('push', 'workflow_dispatch')
    candidate = ref.removeprefix('refs/heads/release/') if integration else ''
    if integration and not re.fullmatch(r'\d+\.\d+\.\d+(-preview\.\d+)?', candidate):
        raise ValueError(f'Invalid release candidate: {candidate}')
    return ('integration' if integration else 'smoke'), candidate


def job_groups(workflow, integration=False):
    source = (Path(__file__).resolve().parents[1] / 'workflows' / workflow).read_text()
    match = re.search(r"groups: '([^']+)'", source)
    groups = json.loads(match[1]) if match else {}
    mapping = {name: {group for group, names in groups.items() if name in names}
               for names in groups.values() for name in names}
    for name, inputs in mapping.items():
        if integration and inputs & {'package', 'install', 'linux-package'}:
            inputs.update(('rust', 'ui'))
    dependencies = {}
    for block in re.split(r'(?=^  [a-z][a-z0-9-]*:\n)', source, flags=re.M):
        name = block.split(':', 1)[0].strip()
        needs = re.search(r'^    needs: (.+)$', block, re.M)
        if needs:
            dependencies[name] = re.findall(r'[a-z][a-z0-9-]*', needs[1])
    # Consumer input hashes include their producers' inputs, even when the
    # consumer does not itself compile/package those files.
    for _ in range(len(mapping)):
        for name, inputs in mapping.items():
            for dependency in dependencies.get(name, []):
                inputs.update(mapping.get(dependency, set()))
    return {name: sorted(inputs) for name, inputs in mapping.items()}


# Producer artifacts required when an unchanged producer is skipped. Rehydrate
# them in the changes workflow, so consumers use their existing artifact paths.
ARTIFACTS = {
    'linux-archive': ['rust-linux-x64'], 'macos-archive': ['rust-darwin-arm64'],
    'linux-arm64-archive': ['rust-linux-arm64'],
    'linux-perf-archive': ['perf-rust-linux-x64'],
    'macos-perf-archive': ['perf-rust-darwin-arm64'],
    'linux-arm64-perf-archive': ['perf-rust-linux-arm64'],
    'linux-native': ['agent-payload-linux-x64'],
    'macos-native': ['agent-payload-darwin-arm64'],
    'linux-arm64-native': ['agent-payload-linux-arm64'],
    'macos-updates': ['macos-update-agent-builds'],
    'install-x64': ['agent-linux-x64'], 'install-arm64': ['agent-linux-arm64'],
    'install-macos': ['agent-darwin-arm64'],
    'build': ['agent-windows-x64'], 'stub': ['windows-e2e'],
    'release': ['windows-completed-installed'],
    'hosted': [f'windows-completed-{n}' for n in ('remote', 'recovery', 'data', 'basics')],
}


def integration_inputs(workflow, current, candidate):
    inputs = {name: hashlib.sha256(json.dumps([candidate, 'integration',
              [(group, current[group]) for group in groups]]).encode()).hexdigest()
              for name, groups in job_groups(workflow, integration=True).items()}
    if 'lint' in inputs:
        # Whitespace lint observes all changed paths, including documentation.
        inputs['lint'] = hashlib.sha256(json.dumps([candidate, 'integration',
                         command('git', 'rev-parse', 'HEAD^{tree}')]).encode()).hexdigest()
    return inputs


def producer_artifacts(workflow, name):
    if workflow == 'windows-installer.yml':
        return ['windows-installer-preview'] if name == 'build' else []
    return ARTIFACTS.get(name, [])


def reuse_inputs(repository, pr, workflow, branch, current, job_inputs, receipts=None):
    reuse, job_reuse, seen = {}, {}, set()
    try:
        for receipt in (previous(repository, pr, workflow, branch) if receipts is None else receipts):
            if job_inputs:
                for name, digest in job_inputs.items():
                    # A later failure invalidates older passing results, even
                    # with identical inputs. Never rerun a flaky test to green.
                    if name in seen or receipt.get('job_inputs', {}).get(name) != digest:
                        continue
                    seen.add(name)
                    if (receipt.get('job_hashes', {}).get(name) == digest
                            and (pr is None or ci_receipts.passed_job(receipt, name))):
                        job_reuse[name] = receipt['run']
            else:
                for group, digest in current.items():
                    if receipt['hashes'].get(group) == digest:
                        reuse.setdefault(group, receipt['run'])
    except (subprocess.CalledProcessError, ValueError, OSError, KeyError, TypeError) as error:
        print(f'Reuse unavailable ({type(error).__name__}); unmatched checks will run.')
    return reuse, job_reuse


def main_base(workflow):
    """Include merges whose selecting workflow was superseded before completion."""
    try:
        # Only a green run proves its commit; a failed one never becomes the
        # baseline, so later pushes reselect (and keep failing) its checks.
        run = latest_main_run(workflow, os.environ['GITHUB_REPOSITORY'], command,
                              exclude_sha=os.environ.get('GITHUB_SHA'), conclusions=('success',))
        if run is None:
            return None
        base = run['head_sha']
        if not re.fullmatch(r'[0-9a-f]{40}', base):
            return None
        command('git', 'merge-base', '--is-ancestor', base, 'HEAD')
        return base
    except (subprocess.CalledProcessError, ValueError, OSError, KeyError, TypeError):
        print('Main baseline unavailable; all checks will run.')
    return None


def selection_base(event, workflow):
    if (os.environ['GITHUB_EVENT_NAME'] == 'push'
            and os.environ.get('GITHUB_REF') == 'refs/heads/main'):
        return main_base(workflow)
    return (event.get('pull_request', {}).get('base', {}).get('sha')
            or event.get('merge_group', {}).get('base_sha') or event.get('before'))


def select(event, workflow):
    level, candidate = tier()
    pr = event.get('pull_request', {})
    base = selection_base(event, workflow)
    full = level == 'integration' or not base or set(base) == {'0'}
    if not full:
        command('git', 'cat-file', '-e', f'{base}^{{commit}}')
    paths = [] if full else changed(base)
    required = set(GROUPS) if full else set().union(*(categories(p, os.environ['GITHUB_EVENT_NAME']) for p in paths))
    ci_shell.select(required, full, workflow, base, event, changed, categories, command)
    current = hashes(base or 'full')
    label = any(label['name'] == 'ci:windows-native' for label in pr.get('labels', []))
    native_required = (full or label or any(windows_native(p) or windows_runtime(p, os.environ['GITHUB_EVENT_NAME']) for p in paths) or
                       (os.environ['GITHUB_EVENT_NAME'] != 'pull_request' and 'rust' in required))
    # Windows stub receipts use the package group, including all Rust harness inputs.
    if workflow == 'windows-preview-smoke.yml':
        if native_required:
            required.add('package')
        current['package'] = hashlib.sha256(
            json.dumps([current['package'], current['rust']]).encode()).hexdigest()
    repository = os.environ['GITHUB_REPOSITORY']
    branch = os.environ.get('GITHUB_REF', '').removeprefix('refs/heads/') if candidate else pr.get('head', {}).get('ref')
    smoke_pr = bool(pr and pr.get('head', {}).get('repo', {}).get('full_name') == repository
                    and pr.get('base', {}).get('repo', {}).get('full_name') == repository
                    and branch and pr.get('base', {}).get('ref'))
    job_inputs = (integration_inputs(workflow, current, candidate) if candidate else
                  ci_receipts.smoke_inputs(workflow, current, job_groups(workflow), command) if smoke_pr else {})
    receipts = None
    if candidate or smoke_pr:
        try:
            receipts = list(previous(repository, pr.get('number'), workflow, branch,
                                     pr.get('base', {}).get('ref'), pr.get('head', {}).get('sha')))
        except (subprocess.CalledProcessError, ValueError, OSError, KeyError, TypeError) as error:
            print(f'Reuse unavailable ({type(error).__name__}); unmatched checks will run.')
            receipts = []
    reuse, job_reuse = reuse_inputs(repository, pr.get('number'), workflow, branch, current, job_inputs, receipts) if smoke_pr or candidate else ({}, {})
    if candidate and workflow == 'rust-quality.yml':
        ci_parts.couple_perf_native(job_reuse)
    parts, part_reuse, part_artifacts = ci_parts.select(workflow, job_inputs, receipts or []) if candidate else ({}, {}, [])
    outputs = {group: str(group in required and group not in reuse).lower() for group in GROUPS}
    jobs = {name: name not in job_reuse for name in job_inputs}
    if level == 'smoke':
        jobs = rust_jobs(dict(outputs, tier=level, macos=str(full or any(matches(p, MACOS) for p in paths)).lower()), os.environ['GITHUB_EVENT_NAME']) | {'lint': True} if workflow == 'rust-quality.yml' else {name: any(outputs[group] == 'true' for group in groups) for name, groups in job_groups(workflow).items()}
    if level == 'smoke':
        jobs = {name: enabled and name not in job_reuse for name, enabled in jobs.items()}
    artifacts = [dict(name=artifact, run=run) for name, run in job_reuse.items()
                 for artifact in producer_artifacts(workflow, name)
                 if candidate or (name == 'linux-archive' and jobs.get('linux-tests'))]
    # Smoke uses the full workspace inventory; E2E is disabled separately.
    if level == 'smoke' and workflow == 'rust-quality.yml':
        parts = {name: dict(workspace=True, e2e=ci_parts.E2E, perf=ci_parts.PERF) for name in ci_parts.inventory(workflow)}
        parts['ui'] = dict(macos=os.environ['GITHUB_EVENT_NAME'] != 'pull_request' and
                           (outputs['package'] == 'true' or outputs['signing'] == 'true' or
                            any(matches(p, BUN_MACOS + SHARED) for p in paths)))
    restored = {artifact['name'] for artifact in artifacts}
    artifacts += [artifact for artifact in part_artifacts if artifact['name'] not in restored]
    if level == 'smoke' and workflow == 'windows-preview-smoke.yml':
        parts = {'hosted': ci_parts.HOSTED}
        native = outputs['package'] == 'true' and native_required
        jobs = windows_preview_jobs(dict(outputs, windows=str(native).lower(), label=str(label).lower()), os.environ['GITHUB_EVENT_NAME'])
    elif workflow == 'windows-preview-smoke.yml':
        jobs['hosted-build'] = False  # Integration builds on the owner PC.
    if os.environ['GITHUB_EVENT_NAME'] == 'pull_request' and workflow not in ('rust-quality.yml', 'windows-preview-smoke.yml'):
        jobs = dict.fromkeys(jobs, False)
    outputs.update({'parts': json.dumps(parts), 'docs-only': str(not required).lower(), 'electron': outputs['package'],
                    'tool-e2e': ci_tool_path.runs(os.environ['GITHUB_EVENT_NAME'], paths), 'tier': level,
                    'candidate': candidate, 'jobs': json.dumps(jobs), 'artifacts': json.dumps(artifacts)})
    state = dict(schema=1, repository=repository, workflow=workflow, pr=pr.get('number'),
                 run=int(os.environ['GITHUB_RUN_ID']), base=base, checkout=command('git', 'rev-parse', 'HEAD'), hashes=current,
                 outputs=outputs, reuse=reuse, paths=paths, previous_paths=None,
                 head=pr.get('head', {}).get('sha'), tier=level, branch=branch,
                 base_ref=pr.get('base', {}).get('ref'), head_repository=pr.get('head', {}).get('repo', {}).get('full_name'),
                 job_inputs=job_inputs, job_reuse=job_reuse, part_reuse=part_reuse)
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        for key, value in outputs.items():
            output.write(f'{key}={value}\n')
        output.write('selection=' + json.dumps(state, separators=(',', ':')) + '\n')
    summary = ['### Changed inputs', f'Tier: **{level}**; candidate: `{candidate}`',
               f'Base: `{base}`; paths: {len(paths)}',
               f'Run groups: {", ".join(k for k, v in outputs.items() if v == "true")}',
               'Reused: ' + json.dumps(job_reuse or reuse),
               'E2E / perf: ' + ('integration only' if candidate else ci_tool_path.SUMMARY if outputs['tool-e2e'] == 'true' else 'NONE (smoke)'),
               'Jobs: ' + json.dumps(jobs)]
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as output:
        output.write('\n\n'.join(summary) + '\n')


def record():
    jobs = json.loads(os.environ['RESULTS'])
    assert jobs['changes']['result'] == 'success', jobs
    state = json.loads(jobs['changes']['outputs']['selection'])
    groups = json.loads(os.environ['JOB_GROUPS'])
    passed = {}
    selected = json.loads(state['outputs'].get('jobs', '{}'))
    for group, names in groups.items():
        results = [jobs[name]['result'] if jobs[name].get('outputs', {}).get('compile') != 'failure' else 'failure' for name in names]
        expected = ['success' if selected.get(name, True) else 'skipped' for name in names]
        if state['outputs'][group] == 'true' and results == expected:
            passed[group] = state['hashes'][group]
        elif group in state['reuse'] and all(result == 'skipped' for result in results):
            passed[group] = state['hashes'][group]
    job_passed = {}
    for name, digest in state.get('job_inputs', {}).items():
        if jobs[name]['result'] == ('skipped' if name in state['job_reuse'] else 'success') and jobs[name].get('outputs', {}).get('compile') != 'failure':
            job_passed[name] = digest
    part_state = {}
    if state.get('tier') == 'integration' and state.get('job_inputs') and ci_parts.inventory(state['workflow']):
        actual = api_items(f'repos/{state["repository"]}/actions/runs/{state["run"]}/attempts/{os.environ["GITHUB_RUN_ATTEMPT"]}/jobs?per_page=100', 'jobs')
        part_state = ci_parts.record(state, actual)
    directory = Path(os.environ['RUNNER_TEMP']) / 'ci-inputs'
    directory.mkdir(exist_ok=True)
    (directory / 'inputs.json').write_text(json.dumps(dict(state, **part_state, hashes=passed, job_hashes=job_passed,
                                                        job_results={name: jobs[name]['result'] for name in state.get('job_inputs', {})})) + '\n')


if __name__ == '__main__':
    if sys.argv[1] == 'record':
        record()
    else:
        select(json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text()), sys.argv[2])
