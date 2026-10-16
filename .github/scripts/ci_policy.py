"""Shared smoke job policy; integration uses per-job receipt selection."""


def rust_jobs(outputs, event):
    rust = outputs['rust'] == 'true'
    package = outputs['package'] == 'true'
    signing = outputs.get('signing') == 'true'
    install = outputs['install'] == 'true'
    linux_package = outputs['linux-package'] == 'true'
    integration = outputs['tier'] == 'integration'
    arm_tests = rust and integration
    macos = rust and (event != 'pull_request' or outputs.get('macos') == 'true')
    # ARM64 Clippy/doctests live on main push and release, never on PRs.
    selected = {
        'windows-check': rust, 'shellcheck': package or signing, 'selftest': package or signing,
        'linux-clippy': rust, 'linux-archive': rust,
        'linux-tests': rust, 'linux-perf-archive': rust and integration, 'linux-perf': rust and integration, 'linux-native': linux_package or install,
        'macos-archive': macos, 'macos-native': integration and (rust or package or install),
        'macos-tests': macos, 'macos-perf-archive': rust and integration, 'macos-perf': rust and integration, 'macos-package': package and integration, 'macos-updates': package and integration,
        'install-x64': install, 'install-arm64': install, 'install-macos': install and integration, 'install-merge': install and integration,
        'linux-arm64-archive': rust and event != 'pull_request',
        'linux-arm64-native': arm_tests or linux_package or install,
        'linux-arm64-tests': arm_tests, 'linux-arm64-perf-archive': arm_tests, 'linux-arm64-perf': arm_tests,
        'linux-package-x64': linux_package, 'linux-package-arm64': linux_package,
        'ui': outputs['ui'] == 'true',
        'site': outputs['site'] == 'true' and (event != 'push' or integration),
        'ds': outputs['ds'] == 'true' and (event != 'push' or integration),
    }
    return selected


def windows_preview_jobs(outputs, event):
    """Native smoke runs on Windows PRs, main and dispatch; builds are release-only."""
    native = outputs['windows'] == 'true'
    installer = outputs['package'] == 'true' and outputs.get('tier') == 'integration'
    return {'build': installer, 'stub': native, 'release': installer and native, 'hosted': native}
