#!/usr/bin/env python3
"""Compare immutable old signing tools and current tools in the same isolated HOME."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

if os.environ.get('BUTLER_SIGN_IDENTITY') == '-':
    print('Preview certificate fallback selected; no Developer ID identity to compare')
else:
    profile = Path(os.environ['BUTLER_SIGN_HOME'])
    assert profile.is_dir() and profile.resolve() != Path.home().resolve()
    subprocess.run(['git', 'fetch', '--no-tags', 'origin', 'tag', 'v0.1.0-preview.9'], check=True)
    old = subprocess.check_output(['git', 'show', 'v0.1.0-preview.9:deploy/macos/sign-and-notarize.sh'])
    current = Path('deploy/macos/sign-and-notarize.sh').resolve()
    with tempfile.TemporaryDirectory(prefix='signing-profile-proof-', dir=os.environ['RUNNER_TEMP']) as directory:
        root = Path(directory)
        old_script = root / 'old-signing.sh'
        old_script.write_bytes(old)
        old_script.chmod(0o700)
        binary = root / 'probe'
        subprocess.run(['clang', '-x', 'c', '-', '-o', str(binary)], input=b'int main(void){return 0;}\n', check=True)
        results = []
        for label, script in [('immutable-preview9', old_script), ('current-profile-binding', current)]:
            target = root / label
            shutil.copy2(binary, target)
            result = subprocess.run([str(script), 'agent', str(target)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            missing = 'The specified item could not be found in the keychain' in result.stderr
            print(f'Signing context proof {label}: exit={result.returncode} keychain_identity_missing={missing}')
            results.append(result)
        assert results[1].returncode == 0, 'Current signing context did not produce a verified Developer ID signature'
        if results[0].returncode == 0:
            print('The earlier missing-identity failure was not reproduced in this minimal probe; do not claim its cause')
        elif 'The specified item could not be found in the keychain' in results[0].stderr:
            print('PROVEN identical credential/binary/fresh HOME: old keychain lookup fails; current profile-bound signing and verification pass')
        else:
            print('Old tools failed for another reason; the earlier keychain failure cause remains unproven')
