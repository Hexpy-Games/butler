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
from ci_policy import rust_jobs
import ci_parts
from urllib.parse import urlencode

GROUPS = ('rust', 'ui', 'site', 'ds', 'package', 'install', 'linux-package', 'workflows', 'licenses')
SHARED = ('VERSION', 'LICENSE', 'package.json', 'bun.lock*', 'bunfig.toml', 'tsconfig*.json',
          '*eslint*', '*stylelint*', '*prettier*')
PACKAGING = ('packages/butler-app/client/electron/*', 'packages/butler-app/electron/*',
             'packages/butler-app/main/*', 'packages/butler-app/scripts/release/*',
             'packages/butler-app/scripts/windows/*', 'packages/butler-npm/*', 'deploy/*',
             'tests/smoke/*update*', 'tests/smoke/quick-fixes*', 'tests/smoke/settings-release*',
             'tests/support/quick-fixes*', 'tests/support/native-app-server*',
             'tests/support/update-work*', 'tests/support/electron-page-cdp*',
             'packages/butler-app/client/ui/src/components/layout/SessionObserverTimeline.tsx',
             'packages/butler-app/client/ui/src/components/settings/Update*')

# The locked inventory declares the non-manifest inputs it fingerprints too.
# Read the checkout, never an owner's runtime data directory.
LICENSE_INPUTS = set(json.loads((Path(__file__).resolve().parents[2] /
                                'deploy/licenses/catalog.json').read_text(encoding='utf-8'))['inputs'])


def matches(path, patterns):
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def categories(path):
    if path.startswith('.github/'):
        return set(GROUPS)
    notice = re.match(r'^(licen[cs]e|copying|notice|copyright)([._-]|$)', Path(path).name, re.I)
    license_input = path in LICENSE_INPUTS or bool(notice)
    runtime_markdown = (path.startswith('packages/butler-agent/resources/') or
                        (path.startswith('packages/butler-agent/rust/') and '/crates/' in path and '/docs/' not in path)) and not path.endswith('/README.md')
    if path.endswith('.md') and not path.startswith('packages/butler-site/') and not runtime_markdown and not license_input:
        return set()
    result = set()
    rust = path.startswith(('packages/butler-agent/rust/', 'packages/butler-agent/resources/', '.cargo/', '.config/')) or matches(path, ('Cargo.*', '**/Cargo.toml', '**/Cargo.lock', 'rust-toolchain*'))
    package = matches(path, PACKAGING)
    shared = matches(path, SHARED)
    ui = path.startswith(('packages/butler-app/client/', 'packages/butler-i18n/'))
    if rust or path == 'VERSION':
        result.add('rust')
    if rust or package or path == 'VERSION':
        result.update(('package', 'install', 'linux-package'))
    bun_source = path.startswith('packages/') and not rust and path.endswith(('.ts', '.tsx', '.js', '.jsx', '.mjs'))
    manifest = path.startswith('packages/') and path.endswith('/package.json')
    if ui or shared or bun_source or manifest or path.startswith(('tests/', 'tools/')) or (path.startswith('packages/') and not rust and not package and not path.startswith('packages/butler-site/')):
        result.add('ui')
    if path.startswith(('packages/butler-site/', 'packages/butler-app/client/ui/', 'packages/butler-i18n/')) or shared or matches(path, ('tests/smoke/ds-site-*',)):
        result.add('site')
    if path.startswith('packages/butler-app/client/ui/') or shared or matches(path, ('tests/smoke/ds-site-*',)):
        result.add('ds')
    if license_input or matches(path, ('*lock*', 'Cargo.toml', '**/Cargo.toml', '**/package.json', 'deploy/licenses/*', '**/licenses/*', 'LICENSE*')):
        result.add('licenses')
    if 'ui' in result:
        result.add('ds')  # Every UI/Bun owner retains the existing renderer browser smokes.
    # Unknown executable/configuration inputs fail closed, rather than silently
    # leaving a new package or tool untested. Assets/readme and plans are docs.
    if not result and not path.startswith(('assets/readme/', 'plans/')):
        result = set(GROUPS) - {'workflows'}
    return result


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def changed(base, head='HEAD'):
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


def trusted_run(run, repository, pr, workflow, branch=None):
    release = pr is None and branch and branch.startswith('release/')
    scope = (run['event'] in ('push', 'workflow_dispatch') and run.get('head_branch') == branch) if release else (run['event'] == 'pull_request' and any(p['number'] == pr for p in run['pull_requests']))
    return (run['status'] == 'completed' and run['conclusion'] in ('success', 'failure')
            and scope and run['path'] == f'.github/workflows/{workflow}'
            and run['head_repository']['full_name'] == repository)


def api_items(path, key):
    pages = json.loads(command('gh', 'api', path, '--paginate', '--slurp'))
    return [item for page in pages for item in page[key]]


def previous(repository, pr, workflow, branch=None):
    query = dict(per_page=100) if pr is None else dict(event='pull_request', per_page=100)
    if branch:
        query['branch'] = branch
    runs = api_items(f'repos/{repository}/actions/workflows/{workflow}/runs?{urlencode(query)}', 'workflow_runs')
    for run in runs:
        if not trusted_run(run, repository, pr, workflow, branch):
            continue
        artifacts = api_items(f'repos/{repository}/actions/runs/{run["id"]}/artifacts?per_page=100', 'artifacts')
        name = f'ci-inputs-{workflow}-{run["run_attempt"]}'
        if not any(a['name'] == name and not a['expired'] for a in artifacts):
            continue
        # A failed overall run may still have completely successful categories.
        # Require successful publication by our gate, never an interrupted write.
        jobs = api_items(f'repos/{repository}/actions/runs/{run["id"]}/attempts/{run["run_attempt"]}/jobs?per_page=100', 'jobs')
        if not any(any(s['name'] == 'Publish successful inputs' and s['conclusion'] == 'success'
                       for s in j.get('steps', [])) for j in jobs):
            continue
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            subprocess.run(['gh', 'run', 'download', str(run['id']), '--name', name, '--dir', directory], check=True, stdout=subprocess.DEVNULL)
            receipt = json.loads((Path(directory) / 'inputs.json').read_text())
        if receipt.get('schema') == 1 and receipt.get('pr') == pr and receipt.get('repository') == repository and receipt.get('workflow') == workflow and receipt.get('run') == run['id'] and (pr is not None or (receipt.get('tier') == 'integration' and receipt.get('branch') == branch and receipt.get('checkout') == run['head_sha'])):
            yield receipt


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
    if not integration:
        return {name: sorted(inputs) for name, inputs in mapping.items()}
    for name, inputs in mapping.items():
        if inputs & {'package', 'install', 'linux-package'}:
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
                    if receipt.get('job_hashes', {}).get(name) == digest:
                        job_reuse[name] = receipt['run']
            else:
                for group, digest in current.items():
                    if receipt['hashes'].get(group) == digest:
                        reuse.setdefault(group, receipt['run'])
    except (subprocess.CalledProcessError, ValueError, OSError, KeyError) as error:
        print(f'Reuse unavailable ({type(error).__name__}); unmatched checks will run.')
    return reuse, job_reuse


def select(event, workflow):
    level, candidate = tier()
    pr = event.get('pull_request', {})
    base = pr.get('base', {}).get('sha') or event.get('merge_group', {}).get('base_sha') or event.get('before')
    full = level == 'integration' or not base or set(base) == {'0'}
    if not full:
        command('git', 'cat-file', '-e', f'{base}^{{commit}}')
    paths = [] if full else changed(base)
    required = set(GROUPS) if full else set().union(*(categories(p) for p in paths))
    current = hashes(base or 'full')
    repository = os.environ['GITHUB_REPOSITORY']
    branch = os.environ.get('GITHUB_REF', '').removeprefix('refs/heads/') if candidate else pr.get('head', {}).get('ref')
    job_inputs = integration_inputs(workflow, current, candidate) if candidate else {}
    receipts = None
    if candidate:
        try:
            receipts = list(previous(repository, None, workflow, branch))
        except (subprocess.CalledProcessError, ValueError, OSError, KeyError) as error:
            print(f'Reuse unavailable ({type(error).__name__}); unmatched checks will run.')
            receipts = []
    reuse, job_reuse = reuse_inputs(repository, pr.get('number'), workflow, branch, current, job_inputs, receipts) if pr or candidate else ({}, {})
    parts, part_reuse, part_artifacts = ci_parts.select(workflow, job_inputs, receipts or []) if candidate else ({}, {}, [])
    outputs = {group: str(group in required and group not in reuse).lower() for group in GROUPS}
    jobs = {name: name not in job_reuse for name in job_inputs}
    if level == 'smoke':
        jobs = rust_jobs(dict(outputs, tier=level), os.environ['GITHUB_EVENT_NAME']) | {'lint': True} if workflow == 'rust-quality.yml' else {name: any(outputs[group] == 'true' for group in groups) for name, groups in job_groups(workflow).items()}
    artifacts = [dict(name=artifact, run=run) for name, run in job_reuse.items()
                 for artifact in producer_artifacts(workflow, name)]
    # Smoke uses the full workspace inventory; E2E is disabled separately.
    if level == 'smoke' and workflow == 'rust-quality.yml':
        parts = {name: dict(workspace=True, e2e=ci_parts.E2E, perf=ci_parts.PERF) for name in ci_parts.inventory(workflow)}
    restored = {artifact['name'] for artifact in artifacts}
    artifacts += [artifact for artifact in part_artifacts if artifact['name'] not in restored]
    if level == 'smoke' and workflow == 'windows-preview-smoke.yml':
        parts = {'hosted': ci_parts.HOSTED}
    outputs.update({'parts': json.dumps(parts), 'docs-only': str(not required).lower(), 'electron': outputs['package'],
                    'tier': level, 'candidate': candidate, 'jobs': json.dumps(jobs),
                    'artifacts': json.dumps(artifacts)})
    state = dict(schema=1, repository=repository, workflow=workflow, pr=pr.get('number'),
                 run=int(os.environ['GITHUB_RUN_ID']), base=base, checkout=command('git', 'rev-parse', 'HEAD'), hashes=current,
                 outputs=outputs, reuse=reuse, paths=paths, previous_paths=None,
                 head=pr.get('head', {}).get('sha'), tier=level, branch=branch,
                 job_inputs=job_inputs, job_reuse=job_reuse, part_reuse=part_reuse)
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        for key, value in outputs.items():
            output.write(f'{key}={value}\n')
        output.write('selection=' + json.dumps(state, separators=(',', ':')) + '\n')
    summary = ['### Changed inputs', f'Tier: **{level}**; candidate: `{candidate}`',
               f'Base: `{base}`; paths: {len(paths)}',
               f'Run groups: {", ".join(k for k, v in outputs.items() if v == "true")}',
               'Reused: ' + json.dumps(job_reuse or reuse),
               'E2E / perf: ' + ('integration only' if candidate else 'NONE (smoke)'),
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
    if state.get('job_inputs') and ci_parts.inventory(state['workflow']):
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
