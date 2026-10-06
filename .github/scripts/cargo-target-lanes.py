#!/usr/bin/env python3
"""Populate the actual CI profile/feature lanes on every main push."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cache', SCRIPTS / 'cargo-artifact-cache.py')
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


def build_lane(platform, profile, mode, kind, base):
    if kind == 'perf':
        features = 'butler-e2e/defaults'
    elif profile == 'debug':
        features = 'workspace-no-defaults,butler-agent/static-ort' if mode == 'static-ort' else 'workspace-defaults'
    else:
        features = 'butler-agent/' + mode
    env = dict(base, TARGET_SNAPSHOT_PROFILE=profile, TARGET_SNAPSHOT_FEATURES=features)
    if platform == 'windows-x64':
        env.update(CARGO_BUILD_TARGET='x86_64-pc-windows-msvc', RUSTFLAGS='-C target-feature=+crt-static')
        if profile == 'release':
            env.update(CARGO_PROFILE_RELEASE_LTO='thin', CARGO_PROFILE_RELEASE_CODEGEN_UNITS='1')
    if env.get('OWNER_JOB_ROOT'):
        env['RUSTC_WRAPPER'] = ''
    os.environ.update(env)
    expected = cache.identity(platform, mode, kind)
    if env.get('OWNER_JOB_ROOT'):
        # The owner setup verifies the installed SDK but does not restore Cargo.
        release_spec = importlib.util.spec_from_file_location('snapshots', SCRIPTS / 'cargo-target-release.py')
        snapshots = importlib.util.module_from_spec(release_spec)
        release_spec.loader.exec_module(snapshots)
        # Main publishes only validated main outputs, never an earlier PR's tree.
        target = Path(env.get('CARGO_TARGET_DIR', 'target'))
        if target.is_symlink():
            raise ValueError('Symlink Cargo target directory')
        if target.exists():
            shutil.rmtree(target)
        snapshots.restore(expected)
    args = ['cargo', 'build', '--locked', '--timings', '-j', '8']
    if kind == 'perf':
        args += ['--release', '--tests', '-p', 'butler-e2e']
    elif profile == 'debug':
        args += ['--workspace', '--all-targets']
        if mode == 'static-ort':
            args += ['--no-default-features', '--features', 'butler-agent/static-ort']
    else:
        args += ['--profile', profile, '-p', 'butler-agent', '--bin', 'butler-agent',
                 '--no-default-features', '--features', mode]
    try:
        subprocess.run([sys.executable, str(SCRIPTS / 'isolated.py'), *args], check=True)
    finally:
        timings = Path(env['RUNNER_TEMP']) / 'cargo-target-timings' / cache.artifact_name(expected)
        timings.mkdir(parents=True, exist_ok=True)
        for html in Path(env.get('CARGO_TARGET_DIR', 'target')).glob('cargo-timings/*.html'):
            shutil.copy2(html, timings / html.name)
    destination = Path(env['RUNNER_TEMP']) / 'cargo-build-cache'
    cache.record(destination, expected, target=env.get('CARGO_TARGET_DIR', 'target'))
    # Free hosted-runner disk after the complete snapshot and timings are saved.
    if not env.get('OWNER_JOB_ROOT'):
        shutil.rmtree(Path(env.get('CARGO_TARGET_DIR', 'target')))


def main():
    base = dict(os.environ)
    platform = base['SNAPSHOT_PLATFORM']
    build_lane(platform, base['SNAPSHOT_PROFILE'], base['SNAPSHOT_MODE'], base['SNAPSHOT_KIND'], base)


if __name__ == '__main__':
    main()
