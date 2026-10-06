#!/usr/bin/env python3
"""One-time release cleanup, gated on four anonymous, fully verified OCI SDKs."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[2] / 'packages/butler-agent/rust/scripts'
sys.path.insert(0, str(SCRIPTS))
import ci_oci
import static_ort_prebuilt as sdk
spec = importlib.util.spec_from_file_location('recipe', SCRIPTS / 'prepare-static-ort.py')
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)
NATIVE_RELEASES = [
    'native-deps-90cd9bb1f17ec8022ca46d5ae9414aeb80b55563281ac04599f8ffb1f34602f1',
    'native-deps-c83180291321cc68ea0dc81fdbaea10dc5310045aa92fb127bd5362c7f419c26',
    'native-deps-43a69967890a6a840ff427914b928347429994e57221cda104e10232c7dac47f',
    'native-deps-75debaba84b370f4fc8d665eded797fb6a351c89b6fe2e0581d48c12683c46a3',
]


def gh(endpoint):
    return json.loads(subprocess.check_output(['gh', 'api', '--paginate', '--slurp', endpoint], text=True))


def verify_native():
    reference = ci_oci.REGISTRY + '/native-deps'
    tags = ci_oci.checked('repo', 'tags', reference).splitlines()
    lock = json.loads(recipe.LOCK.read_text())
    for target in sorted(recipe.TARGETS):
        # Fingerprints are host-independent. Only current recipe keys count.
        fingerprint = sdk.key(recipe.SCRIPT, recipe.target_lock(lock, target), target)
        tag = target + '-' + fingerprint
        if tag not in tags:
            raise ValueError(f'Missing current anonymous OCI SDK for {target}')
        entry = sdk.release(fingerprint, target)
        if entry is None:
            raise ValueError(f'OCI SDK is not public: {target}')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sdk.download_asset(entry, root / 'sdk.zip')
            (root / 'sdk').mkdir()
            sdk.unpack(root / 'sdk.zip', root / 'sdk')
            recipe.adopt(root / 'sdk', fingerprint, recipe.target_lock(lock, target), target)
        print('Verified anonymous SDK including inner digests:', tag)


def cleanup():
    verify_native()  # No release/tag mutations until all four targets pass.
    repository = os.environ['GITHUB_REPOSITORY']
    releases = [entry for page in gh(f'repos/{repository}/releases?per_page=100') for entry in page]
    for entry in releases:
        tag = entry['tag_name']
        if tag in NATIVE_RELEASES or tag.startswith('cargo-target-'):
            subprocess.run(['gh', 'release', 'delete', tag, '--repo', repository, '--cleanup-tag', '--yes'], check=True)
            print('Removed release and tag:', tag)
    refs = [entry for page in gh(f'repos/{repository}/git/matching-refs/tags/') for entry in page]
    for entry in refs:
        tag = entry['ref'].removeprefix('refs/tags/')
        if tag in NATIVE_RELEASES or re.fullmatch(r'cargo-target-[A-Za-z0-9_-]+', tag):
            subprocess.run(['gh', 'api', '--method', 'DELETE', f'repos/{repository}/git/refs/tags/{tag}'], check=True)
            print('Removed orphan CI tag:', tag)


if __name__ == '__main__':
    cleanup()
