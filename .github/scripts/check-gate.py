#!/usr/bin/env python3
"""Fail closed on failed, cancelled or unexpectedly skipped selected checks."""
import json
import os

jobs = json.loads(os.environ['RESULTS'])
assert jobs['changes']['result'] == 'success', jobs
changes = jobs['changes']['outputs']
rust = changes['rust'] == 'true'
package = changes['package'] == 'true'
install = changes['install'] == 'true'
linux_package = changes['linux-package'] == 'true'
arm_tests = rust and os.environ['EVENT'] != 'pull_request'
selected = {
    'source': rust, 'linux-clippy': rust, 'linux-archive': rust or linux_package or install,
    'linux-tests': rust, 'macos-archive': rust or package or install,
    'macos-tests': rust, 'macos-package': package,
    'install-x64': install, 'install-arm64': install, 'install-macos': install, 'install-merge': install,
    'linux-arm64-archive': arm_tests or linux_package or install,
    'linux-arm64-tests': arm_tests, 'linux-package-x64': linux_package, 'linux-package-arm64': linux_package,
    'ui': changes['ui'] == 'true',
    'site': changes['site'] == 'true' and os.environ['EVENT'] != 'push',
    'ds': changes['ds'] == 'true' and os.environ['EVENT'] != 'push',
}
for name, enabled in selected.items():
    expected = 'success' if enabled else 'skipped'
    assert jobs[name]['result'] == expected, f'{name}: {jobs[name]["result"]}, expected {expected}'
print('All selected checks passed.')
