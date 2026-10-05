#!/usr/bin/env python3
"""Select PR checks and reuse only proven, identical inputs of the same PR."""
import fnmatch
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile

GROUPS = ('rust', 'ui', 'site', 'ds', 'package', 'install', 'linux-package', 'workflows', 'licenses')
SHARED = ('VERSION', 'LICENSE', 'package.json', 'bun.lock', 'bunfig.toml', 'tsconfig*.json',
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
    rust = path.startswith(('packages/butler-agent/rust/', 'packages/butler-agent/resources/', '.cargo/', '.config/')) or matches(path, ('Cargo.*', 'rust-toolchain*'))
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


def trusted_run(run, repository, pr, workflow):
    return (run['status'] == 'completed' and run['conclusion'] in ('success', 'failure')
            and run['event'] == 'pull_request' and run['path'] == f'.github/workflows/{workflow}'
            and run['head_repository']['full_name'] == repository
            and any(p['number'] == pr for p in run['pull_requests']))


def previous(repository, pr, workflow):
    runs = json.loads(command('gh', 'api', f'repos/{repository}/actions/workflows/{workflow}/runs?event=pull_request&per_page=100'))['workflow_runs']
    for run in runs:
        if not trusted_run(run, repository, pr, workflow):
            continue
        artifacts = json.loads(command('gh', 'api', f'repos/{repository}/actions/runs/{run["id"]}/artifacts?per_page=100'))['artifacts']
        name = f'ci-inputs-{workflow}-{run["run_attempt"]}'
        if not any(a['name'] == name and not a['expired'] for a in artifacts):
            continue
        # A failed overall run may still have completely successful categories.
        # Require successful publication by our gate, never an interrupted write.
        jobs = json.loads(command('gh', 'api', f'repos/{repository}/actions/runs/{run["id"]}/attempts/{run["run_attempt"]}/jobs?per_page=100'))['jobs']
        if not any(any(s['name'] == 'Publish successful inputs' and s['conclusion'] == 'success'
                       for s in j.get('steps', [])) for j in jobs):
            continue
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            subprocess.run(['gh', 'run', 'download', str(run['id']), '--name', name, '--dir', directory], check=True, stdout=subprocess.DEVNULL)
            receipt = json.loads((Path(directory) / 'inputs.json').read_text())
        if receipt.get('schema') == 1 and receipt.get('pr') == pr and receipt.get('repository') == repository and receipt.get('workflow') == workflow and receipt.get('run') == run['id']:
            yield receipt


def select(event, workflow):
    pr = event.get('pull_request', {})
    base = pr.get('base', {}).get('sha') or event.get('merge_group', {}).get('base_sha') or event.get('before')
    full = os.environ['GITHUB_EVENT_NAME'] in ('schedule', 'workflow_dispatch') or not base or set(base) == {'0'}
    if not full:
        command('git', 'cat-file', '-e', f'{base}^{{commit}}')
    paths = [] if full else changed(base)
    required = set(GROUPS) if full else set().union(*(categories(p) for p in paths))
    current = hashes(base or 'full')
    reuse = {}
    previous_paths = None
    repository = os.environ['GITHUB_REPOSITORY']
    if pr:
        try:
            for receipt in previous(repository, pr['number'], workflow):
                if previous_paths is None and receipt.get('head') and pr.get('head'):
                    try:
                        previous_paths = changed(receipt['head'], pr['head']['sha'])
                    except subprocess.CalledProcessError:
                        pass  # Force-pushed history may be absent; hashes remain authoritative.
                for group in required:
                    if receipt['hashes'].get(group) == current[group]:
                        reuse.setdefault(group, receipt['run'])
        except (subprocess.CalledProcessError, ValueError, OSError, KeyError) as error:
            print(f'Reuse unavailable ({type(error).__name__}); unmatched checks will run.')
    outputs = {group: str(group in required and group not in reuse).lower() for group in GROUPS}
    outputs['docs-only'] = str(not required).lower()
    outputs['electron'] = outputs['package']
    # Preserve full main/nightly coverage and the existing main package policy.
    if os.environ['GITHUB_EVENT_NAME'] != 'pull_request':
        if workflow == 'rust-quality.yml':
            outputs['package'] = 'false'
        outputs['install'] = outputs['linux-package'] = 'true'
    state = dict(schema=1, repository=repository, workflow=workflow, pr=pr.get('number'),
                 run=int(os.environ['GITHUB_RUN_ID']), base=base, checkout=command('git', 'rev-parse', 'HEAD'), hashes=current,
                 outputs=outputs, reuse=reuse, paths=paths, previous_paths=previous_paths,
                 head=pr.get('head', {}).get('sha'))
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        for key, value in outputs.items():
            output.write(f'{key}={value}\n')
        output.write('selection=' + json.dumps(state, separators=(',', ':')) + '\n')
    summary = ['### Changed inputs', f'Base: `{base}`', f'Paths: {len(paths)}', f'Paths since previous passed inputs: {json.dumps(previous_paths)}',
               f'Run: {", ".join(k for k, v in outputs.items() if v == "true")}',
               'Reused: ' + json.dumps(reuse)]
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as output:
        output.write('\n\n'.join(summary) + '\n')


def record():
    jobs = json.loads(os.environ['RESULTS'])
    assert jobs['changes']['result'] == 'success', jobs
    state = json.loads(jobs['changes']['outputs']['selection'])
    groups = json.loads(os.environ['JOB_GROUPS'])
    passed = {}
    for group, names in groups.items():
        results = [jobs[name]['result'] if jobs[name].get('outputs', {}).get('compile') != 'failure' else 'failure' for name in names]
        if state['outputs'][group] == 'true' and all(result == 'success' for result in results):
            passed[group] = state['hashes'][group]
        elif group in state['reuse'] and all(result == 'skipped' for result in results):
            passed[group] = state['hashes'][group]
    directory = Path(os.environ['RUNNER_TEMP']) / 'ci-inputs'
    directory.mkdir(exist_ok=True)
    (directory / 'inputs.json').write_text(json.dumps(dict(state, hashes=passed)) + '\n')


if __name__ == '__main__':
    if sys.argv[1] == 'record':
        record()
    else:
        select(json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text()), sys.argv[2])
