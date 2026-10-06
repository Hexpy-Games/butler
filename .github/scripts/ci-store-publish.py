#!/usr/bin/env python3
"""Authenticate and publish in one isolated native Python process on every OS."""
import os
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SDK_SCRIPTS = ROOT / 'packages/butler-agent/rust/scripts'
sys.path.insert(0, str(SDK_SCRIPTS))
import ci_oci
import static_ort_prebuilt


def main(args):
    if not args or args[0] not in ('native-deps', 'cargo-target'):
        raise SystemExit('Usage: ci-store-publish.py native-deps TARGET | cargo-target PLATFORM MODE KIND')
    expected = 2 if args[0] == 'native-deps' else 4
    if len(args) != expected:
        raise SystemExit('Wrong publisher argument count')
    ci_oci.authenticate()
    if args[0] == 'native-deps':
        static_ort_prebuilt.publish(SDK_SCRIPTS / 'prepare-static-ort.py', args[1])
    else:
        subprocess.run([sys.executable, str(ROOT / '.github/scripts/cargo-target-release.py'),
                        'publish-lane', *args[1:]], check=True, env=os.environ)


if __name__ == '__main__':
    main(sys.argv[1:])
