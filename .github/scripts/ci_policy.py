"""Shared smoke job policy; integration uses per-job receipt selection."""


def rust_jobs(outputs, event):
    rust = outputs['rust'] == 'true'
    package = outputs['package'] == 'true'
    install = outputs['install'] == 'true'
    linux_package = outputs['linux-package'] == 'true'
    integration = outputs['tier'] == 'integration'
    arm_tests = rust and integration
    # ARM64 archives also run native Clippy/doctests on Rust smoke changes.
    selected = {
        'windows-check': rust, 'shellcheck': package, 'selftest': package,
        'linux-clippy': rust, 'linux-archive': rust,
        'linux-tests': rust, 'linux-perf-archive': rust and integration, 'linux-perf': rust and integration, 'linux-native': linux_package or install,
        'macos-archive': rust, 'macos-native': integration and (rust or package or install),
        'macos-tests': rust, 'macos-perf-archive': rust and integration, 'macos-perf': rust and integration, 'macos-package': package and integration, 'macos-updates': package and integration,
        'install-x64': install, 'install-arm64': install, 'install-macos': install and integration, 'install-merge': install and integration,
        'linux-arm64-archive': rust,
        'linux-arm64-native': arm_tests or linux_package or install,
        'linux-arm64-tests': arm_tests, 'linux-arm64-perf-archive': arm_tests, 'linux-arm64-perf': arm_tests,
        'linux-package-x64': linux_package, 'linux-package-arm64': linux_package,
        'ui': outputs['ui'] == 'true',
        'site': outputs['site'] == 'true' and (event != 'push' or integration),
        'ds': outputs['ds'] == 'true' and (event != 'push' or integration),
    }
    return selected


def windows_preview_jobs(outputs, event):
    """Owner-runner Windows smoke follows Rust/Windows inputs; installers run off PRs."""
    native = outputs['windows'] == 'true'
    installer = outputs['package'] == 'true' and event != 'pull_request'
    return {'build': installer, 'stub': native, 'release': installer and native, 'hosted': native}
