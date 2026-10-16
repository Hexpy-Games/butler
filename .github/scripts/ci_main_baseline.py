"""Bounded per-workflow main-push baseline shared by selection and merge policy."""
import json
from urllib.parse import urlencode


def latest_main_run(workflow, repository, command, exclude_sha=None, conclusions=('success', 'failure')):
    query = urlencode(dict(branch='main', event='push', status='completed', per_page=100))
    runs = json.loads(command('gh', 'api',
        f'repos/{repository}/actions/workflows/{workflow}/runs?{query}'))['workflow_runs']
    for run in sorted(runs, key=lambda run: run['id'], reverse=True):
        if (run['status'] == 'completed' and run['conclusion'] != 'cancelled'
                and (conclusions is None or run['conclusion'] in conclusions)
                and run['event'] == 'push' and run['head_branch'] == 'main'
                and run['path'] == f'.github/workflows/{workflow}'
                and run['head_repository']['full_name'] == repository
                and run['head_sha'] != exclude_sha):
            return run
    return None
