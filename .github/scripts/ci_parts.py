"""Input receipts for individual matrix jobs inside reusable test workflows."""
import re

E2E = [1, 2, 3, 4, 5, 6, 'ins-02', 'ins-14', 'install']
PERF = [1, 2, 3, 'idle']
HOSTED = [
    dict(shard='remote', tests='gateway_remote,gateway_pairing,cli_remote'),
    dict(shard='recovery', tests='queue_shutdown,service_supervision,service_diagnostics'),
    dict(shard='data', tests='cli_surface,migration,durable_configuration,project_workspace,queue_notifications'),
    dict(shard='basics', tests='windows_commands'),
]


def inventory(workflow):
    if workflow == 'rust-quality.yml':
        return {f'{platform}-{kind}': (['workspace'] + [f'e2e-{shard}' for shard in E2E]
                                      if kind == 'tests' else [f'perf-{shard}' for shard in PERF])
                for platform in ['linux', 'linux-arm64', 'macos'] for kind in ['tests', 'perf']}
    return {'hosted': [item['shard'] for item in HOSTED]} if workflow == 'windows-preview-smoke.yml' else {}


def select(workflow, inputs, receipts):
    expected = {f'{job}/{part}': inputs[job] for job, parts in inventory(workflow).items() for part in parts}
    reuse, seen = {}, set()
    for receipt in receipts:
        for key, digest in expected.items():
            parent = key.split('/')[0]
            if key in seen or receipt.get('job_inputs', {}).get(parent) != digest:
                continue
            if key not in receipt.get('part_results', {}):
                continue  # Receipts before matrix support cannot prove a shard.
            seen.add(key)
            if receipt.get('part_hashes', {}).get(key) == digest:
                reuse[key] = receipt['run']
    outputs = {}
    for job, parts in inventory(workflow).items():
        pending = [part for part in parts if f'{job}/{part}' not in reuse]
        outputs[job] = dict(workspace='workspace' in pending,
                           e2e=[shard for shard in E2E if f'e2e-{shard}' in pending],
                           perf=[shard for shard in PERF if f'perf-{shard}' in pending])
    if workflow == 'windows-preview-smoke.yml':
        outputs['hosted'] = [item for item in HOSTED if f'hosted/{item["shard"]}' not in reuse]
    artifacts = [dict(name=f'windows-completed-{key.split("/")[1]}', run=run)
                 for key, run in reuse.items() if key.startswith('hosted/')]
    return outputs, reuse, artifacts


def key_for_name(name):
    match = re.fullmatch(r'(linux|linux-arm64|macos)-(tests|perf) / (workspace|(?:E2E|Performance) \([^ ]+ ([^)]+)\))', name)
    if match:
        platform, kind, label, shard = match.groups()
        part = 'workspace' if label == 'workspace' else ('e2e-' if kind == 'tests' else 'perf-') + shard
        return f'{platform}-{kind}/{part}'
    match = re.fullmatch(r'Hosted Windows E2E \(([^)]+)\)', name)
    return f'hosted/{match[1]}' if match else None


def record(state, jobs):
    results, hashes = {}, {}
    for job in jobs:
        key = key_for_name(job['name'])
        if key and job['conclusion'] in ('success', 'failure', 'cancelled'):
            results[key] = job['conclusion']
            if job['conclusion'] == 'success':
                hashes[key] = state['job_inputs'][key.split('/')[0]]
    for key in state.get('part_reuse', {}):
        if key not in results:
            results[key] = 'skipped'
            hashes[key] = state['job_inputs'][key.split('/')[0]]
    return dict(part_results=results, part_hashes=hashes)
