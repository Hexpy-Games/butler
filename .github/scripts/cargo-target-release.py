#!/usr/bin/env python3
"""Verified rolling OCI Cargo snapshots from existing main/release build jobs.

Immutable generation tags commit all chunks atomically. The compatibility tag
selects the latest generation; two generations per key survive package pruning.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

# Build scripts watch the recipe directory; imports must not create new inputs.
sys.dont_write_bytecode = True

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS.parents[1] / 'packages/butler-agent/rust/scripts'))
import ci_oci

spec = importlib.util.spec_from_file_location('cargo_cache', SCRIPTS / 'cargo-artifact-cache.py')
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)
CHUNK_BYTES = 1800 * 1024**2
KEEP = 2


class UnsuccessfulProducer(ValueError):
    """A completed CI run can contain other failed lanes; never publish those."""


def api(endpoint):
    field = 'jobs' if '/jobs?' in endpoint else 'artifacts' if '/artifacts?' in endpoint else None
    if field:
        pages = json.loads(cache.output('gh', 'api', '--paginate', '--slurp', endpoint))
        return {field: [entry for page in pages for entry in page[field]]}
    return json.loads(cache.output('gh', 'api', endpoint))


def release(tag):
    return ci_oci.manifest(f'{ci_oci.REGISTRY}/cargo-target:{tag}')


def generations(assets):
    return sorted((entry for entry in assets if re.fullmatch(r'\d+-\d+\.json', entry['name'])),
                  key=lambda entry: tuple(map(int, entry['name'][:-5].split('-'))), reverse=True)


def trusted(metadata, publishing=False):
    repository = os.environ['GITHUB_REPOSITORY']
    attempt = int(metadata.get('run_attempt', 1))
    endpoint = f'repos/{repository}/actions/runs/{int(metadata["run_id"])}/attempts/{attempt}'
    run = api(endpoint)
    branch = run['head_branch']
    if (run['head_repository']['full_name'] != repository or run['event'] != 'push'
            or not (branch == 'main' or branch.startswith('release/'))
            or run['head_sha'] != metadata['sha']):
        raise ValueError('Cargo snapshot is not a same-repository main/release push')
    if not publishing and run['status'] != 'completed':
        raise UnsuccessfulProducer('Cargo snapshot producer is not complete yet')
    jobs = api(endpoint + '/jobs?per_page=100')['jobs']
    producer = metadata['producer_name']
    identity = metadata['identity']
    platform = identity['platform']
    allowed = {'native': [f'Build native Agent ({platform})', 'Build unsigned Windows preview'],
               'dev': [f'Build archives ({platform})', 'Platform contracts and debug stub chat'],
               'perf': [f'Build perf harness ({platform})']}[identity['kind']]
    if producer not in allowed or ('Windows' in producer or 'stub chat' in producer) and platform != 'windows-x64':
        raise UnsuccessfulProducer('Cargo snapshot producer lane is invalid')
    matches = [job for job in jobs if job['name'] == producer or job['name'].endswith(' / ' + producer)]
    if publishing:
        matches = [job for job in matches if job['status'] == 'in_progress']
    else:
        matches = [job for job in matches if job['status'] == 'completed' and job['conclusion'] == 'success']
    if len(matches) != 1:
        raise UnsuccessfulProducer('Cargo snapshot producer lane did not succeed')


def download(entry, destination):
    ci_oci.fetch(entry, destination)


def fetch_snapshot(published, manifest, directory, expected):
    download(manifest, directory / 'generation.json')
    generation = json.loads((directory / 'generation.json').read_text())
    metadata = generation['metadata']
    if metadata['identity'] != expected:
        raise ValueError('Cargo snapshot identity mismatch')
    trusted(metadata)
    if not generation['chunks'] or len(set(generation['chunks'])) != len(generation['chunks']):
        raise ValueError('Cargo snapshot chunks are incomplete or duplicated')
    assets = {entry['name']: entry for entry in published['assets']}
    with (directory / 'cache.tar.zst').open('wb') as archive:
        for name in generation['chunks']:
            if not re.fullmatch(re.escape(manifest['name'][:-5]) + r'-\d{4}\.zst', name):
                raise ValueError('Invalid Cargo snapshot chunk name')
            download(assets[name], directory / 'chunk')
            with (directory / 'chunk').open('rb') as chunk:
                shutil.copyfileobj(chunk, archive)
            (directory / 'chunk').unlink()
    source_name = manifest['name'][:-5] + '-sources.json'
    download(assets[source_name], directory / 'sources.json')
    (directory / 'cache.json').write_text(json.dumps(metadata))
    cache.verify(directory, expected)


def restore(expected):
    published = release(tag_name(expected))
    candidates = generations(published['assets']) if published else []
    if not candidates:
        print('No persistent CI snapshot for this lane; cold Cargo build follows.')
        return False
    with tempfile.TemporaryDirectory(dir=os.environ['RUNNER_TEMP']) as temporary:
        directory = Path(temporary)
        try:
            fetch_snapshot(published, candidates[0], directory, expected)
        except UnsuccessfulProducer:
            print('Cargo snapshot producer is not successful yet; cold Cargo build follows.')
            return False
        restore_tree(directory, expected)
    return True


def restore_tree(directory, expected):
    cache.verify(directory, expected)
    directory = directory.resolve()
    target = Path(os.environ.get('CARGO_TARGET_DIR', 'target')).absolute()
    # Do not merge newer/foreign fingerprints or executables into the snapshot.
    if target.is_symlink():
        raise ValueError('Symlink Cargo target directory')
    if target.exists():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent) as stage:
        previous = Path.cwd()
        try:
            os.chdir(stage)
            cache.extract(directory.resolve())
        finally:
            os.chdir(previous)
        (Path(stage) / 'target').rename(target)
    cache.source_times.restore(Path(os.environ['GITHUB_WORKSPACE']),
                              json.loads((directory / 'sources.json').read_text()))
    print(f'Restored verified CI Cargo snapshot at {json.loads((directory / "cache.json").read_text())["sha"]}.')


def tag_name(expected):
    return cache.artifact_name(expected).removeprefix('cargo-build-cache-')


def split(archive, directory, prefix):
    chunks = []
    with archive.open('rb') as source:
        while True:
            name = f'{prefix}-{len(chunks):04}.zst'
            destination = directory / name
            with destination.open('wb') as output:
                remaining = CHUNK_BYTES
                while remaining and (block := source.read(min(1024**2, remaining))):
                    output.write(block)
                    remaining -= len(block)
            if destination.stat().st_size == 0:
                destination.unlink()
                break
            chunks.append(name)
    return chunks


def prune(tag, prefix):
    # GHCR does not implement registry manifest deletion. Package version
    # deletion uses the same workflow token, with package admin access inherited
    # from the linked repository. Never delete another compatibility key.
    repository = os.environ['GITHUB_REPOSITORY']
    owner = repository.split('/')[0]
    endpoint = f'orgs/{owner}/packages/container/butler-ci%2Fcargo-target/versions'
    pages = json.loads(cache.output('gh', 'api', '--paginate', '--slurp', endpoint + '?per_page=100'))
    versions = []
    for entry in (entry for page in pages for entry in page):
        tags = entry['metadata']['container']['tags']
        matching = [value.removeprefix(tag + '--') for value in tags if value.startswith(tag + '--')]
        if matching:
            versions.append((max(tuple(map(int, value.split('-'))) for value in matching), entry))
    ordered = sorted(versions, key=lambda value: value[0], reverse=True)
    if ordered and ordered[0][0] > tuple(map(int, prefix.split('-'))):
        latest = '-'.join(map(str, ordered[0][0]))
        reference = f'{ci_oci.REGISTRY}/cargo-target:{tag}--{latest}'
        ci_oci.checked('tag', reference, tag, anonymous=False)
    for _, entry in ordered[KEEP:]:
        subprocess.run(['gh', 'api', '--method', 'DELETE', endpoint + '/' + str(entry['id'])], check=True)


def publish(directory, run_id):
    metadata = json.loads((directory / 'cache.json').read_text())
    if str(metadata['run_id']) != str(run_id):
        raise ValueError('Cargo snapshot run mismatch')
    trusted(metadata, publishing=True)
    cache.verify(directory, metadata['identity'])
    tag = tag_name(metadata['identity'])
    prefix = f'{int(run_id)}-{int(metadata["run_attempt"])}'
    reference = f'{ci_oci.REGISTRY}/cargo-target:{tag}--{prefix}'
    committed = ci_oci.manifest(reference, anonymous=False)
    if committed is None:
        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary)
            chunks = split(directory / 'cache.tar.zst', stage, prefix)
            sources = stage / (prefix + '-sources.json')
            shutil.copyfile(directory / 'sources.json', sources)
            manifest = stage / (prefix + '.json')
            manifest.write_text(json.dumps(dict(metadata=metadata, chunks=chunks)))
            # OCI commits its manifest only after every complete chunk is stored.
            ci_oci.push(reference, [*(stage / name for name in chunks), sources, manifest])
    else:
        with tempfile.TemporaryDirectory() as temporary:
            manifest = next(entry for entry in committed['assets'] if entry['name'] == prefix + '.json')
            download_manifest = Path(temporary) / 'generation.json'
            ci_oci.fetch(manifest, download_manifest, anonymous=False)
            if json.loads(download_manifest.read_text())['metadata'] != metadata:
                raise ValueError('Committed Cargo generation cannot be overwritten')
    ci_oci.checked('tag', reference, tag, anonymous=False)
    if os.environ.get('BUTLER_OCI_LAYOUT') != '1':
        prune(tag, prefix)


def publish_lane(platform, mode, kind):
    expected = cache.identity(platform, mode, kind)
    directory = Path(os.environ['RUNNER_TEMP']) / 'cargo-build-cache'
    cache.record(directory, expected, target=os.environ.get('CARGO_TARGET_DIR', 'target'))
    publish(directory, os.environ['GITHUB_RUN_ID'])


if __name__ == '__main__':
    if len(sys.argv) != 5 or sys.argv[1] != 'publish-lane':
        raise SystemExit('Usage: cargo-target-release.py publish-lane PLATFORM MODE KIND')
    publish_lane(*sys.argv[2:])
