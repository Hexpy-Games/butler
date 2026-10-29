"""Experimental workspace selection stays independent of full Agent fallbacks."""
import os


def select(required, full, workflow, base, event, changed, categories, command=None):
    if full:
        required.discard('shell')
        if workflow == 'shell.yml':
            baseline = base or event.get('before') or event.get('pull_request', {}).get('base', {}).get('sha')
            if (not baseline or set(baseline) == {'0'}) and command:
                default = event.get('repository', {}).get('default_branch')
                if default:
                    baseline = command('git', 'merge-base', 'HEAD', f'origin/{default}')
            if baseline and set(baseline) != {'0'}:
                if any('shell' in categories(path) for path in changed(baseline)):
                    required.add('shell')
    if workflow == 'shell.yml' and os.environ['GITHUB_EVENT_NAME'] == 'workflow_dispatch':
        required.add('shell')
