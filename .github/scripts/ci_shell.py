"""Experimental workspace selection stays independent of full Agent fallbacks."""
import os


def select(required, full, workflow, base, event, changed, categories):
    if full:
        required.discard('shell')
        if workflow == 'shell.yml':
            baseline = base or event.get('before') or event.get('pull_request', {}).get('base', {}).get('sha')
            if baseline and set(baseline) != {'0'}:
                if any('shell' in categories(path) for path in changed(baseline)):
                    required.add('shell')
    if workflow == 'shell.yml' and os.environ['GITHUB_EVENT_NAME'] == 'workflow_dispatch':
        required.add('shell')
