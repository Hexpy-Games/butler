#!/usr/bin/env python3
"""Rolling main-only Cargo snapshots, outside the Actions cache quota.

Use release assets like the native SDK publisher. Each immutable generation is
committed by uploading its manifest last. Two complete generations survive;
chunks fit GitHub's 2 GiB per-asset limit. Consumers verify GitHub digests, inner
digests and the successful main producer before touching their build tree.
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
import urllib.error

# Build scripts watch the recipe directory; imports must not create new inputs.
sys.dont_write_bytecode = True

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS.parents[1] / 'packages/butler-agent/rust/scripts'))
from static_ort_prebuilt import request, download_asset

spec = importlib.util.spec_from_file_location('cargo_cache', SCRIPTS / 'cargo-artifact-cache.py')
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)
CHUNK_BYTES = 1800 * 1024**2
KEEP = 2


class UnsuccessfulProducer(ValueError):
    """A completed main run can contain other failed lanes; never publish those."""


def api(endpoint):
    field = 'jobs' if '/jobs?' in endpoint else 'artifacts' if '/artifacts?' in endpoint else None
    if field:
        pages = json.loads(cache.output('gh', 'api', '--paginate', '--slurp', endpoint))
        return {field: [entry for page in pages for entry in page[field]]}
    return json.loads(cache.output('gh', 'api', endpoint))


def release(tag, allow_draft=False):
    repository = os.environ['GITHUB_REPOSITORY']
    try:
        with request(f'https://api.github.com/repos/{repository}/releases/tags/{tag}') as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return draft_release(tag) if allow_draft else None
        raise
    if result['draft'] and not allow_draft:
        return None
    return complete_assets(result)


def complete_assets(published):
    repository = os.environ['GITHUB_REPOSITORY']
    endpoint = f'repos/{repository}/releases/{int(published["id"])}/assets?per_page=100'
    pages = json.loads(cache.output('gh', 'api', '--paginate', '--slurp', endpoint))
    published['assets'] = [entry for page in pages for entry in page]
    return published


def draft_release(tag):
    # The tag endpoint documents published releases. Only the write-token
    # publisher enumerates drafts, including an interrupted first upload.
    repository = os.environ['GITHUB_REPOSITORY']
    pages = json.loads(cache.output('gh', 'api', '--paginate', '--slurp',
                                   f'repos/{repository}/releases?per_page=100'))
    found = next((entry for page in pages for entry in page
                  if entry['tag_name'] == tag and entry['draft']), None)
    return complete_assets(found) if found else None


def generations(assets):
    return sorted((entry for entry in assets if re.fullmatch(r'\d+-\d+\.json', entry['name'])),
                  key=lambda entry: tuple(map(int, entry['name'][:-5].split('-'))), reverse=True)


def trusted(metadata):
    repository = os.environ['GITHUB_REPOSITORY']
    attempt = int(metadata.get('run_attempt', 1))
    endpoint = f'repos/{repository}/actions/runs/{int(metadata["run_id"])}/attempts/{attempt}'
    run = api(endpoint)
    if (run['head_repository']['full_name'] != repository or run['event'] != 'push'
            or run['head_branch'] != 'main' or run['head_sha'] != metadata['sha']
            or run['status'] != 'completed'):
        raise ValueError('Cargo snapshot is not a completed same-repository main push')
    jobs = api(endpoint + '/jobs?per_page=100')['jobs']
    identity = metadata['identity']
    lane = f'Build target snapshot {identity.get("profile")} {identity.get("mode")} {metadata.get("runner_kind", "hosted")} ({identity["platform"]})'
    if run.get('path') == '.github/workflows/cargo-target-main.yml':
        jobs = [job for job in jobs if job['name'] == lane]
    if not cache.valid_producer(run, jobs, repository, identity['platform'], identity['kind']):
        raise UnsuccessfulProducer('Cargo snapshot producer lane did not succeed')


def download(entry, destination):
    # Reuse the SDK's bounded download and redirect-safe authentication pattern.
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', entry.get('digest') or ''):
        raise ValueError('Cargo snapshot lacks GitHub SHA-256')
    download_asset(entry, destination)


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
    candidates = generations(published['assets']) if published and not published['draft'] else []
    if not candidates:
        print('No persistent main snapshot for this lane; cold Cargo build follows.')
        return False
    with tempfile.TemporaryDirectory(dir=os.environ['RUNNER_TEMP']) as temporary:
        directory = Path(temporary)
        fetch_snapshot(published, candidates[0], directory, expected)
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
    print(f'Restored verified main Cargo snapshot at {json.loads((directory / "cache.json").read_text())["sha"]}.')


def tag_name(expected):
    return 'cargo-target-' + cache.artifact_name(expected).removeprefix('cargo-build-cache-')


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


def prune(tag, published):
    retained = generations(published['assets'])[:KEEP]
    prefixes = {entry['name'][:-5] for entry in retained}
    repository = os.environ['GITHUB_REPOSITORY']
    for entry in published['assets']:
        prefix = re.match(r'^(\d+-\d+)(?:\.json|-)', entry['name'])
        if prefix and prefix[1] not in prefixes:
            subprocess.run(['gh', 'release', 'delete-asset', tag, entry['name'],
                            '--repo', repository, '--yes'], check=True)


def publish(directory, run_id):
    metadata = json.loads((directory / 'cache.json').read_text())
    if str(metadata['run_id']) != str(run_id):
        raise ValueError('Cargo snapshot run mismatch')
    trusted(metadata)
    cache.verify(directory, metadata['identity'])
    tag = tag_name(metadata['identity'])
    repository = os.environ['GITHUB_REPOSITORY']
    published = release(tag, allow_draft=True)
    gh = ['gh', 'release']
    if published is None:
        subprocess.run([*gh, 'create', tag, '--repo', repository, '--target', metadata['sha'],
                        '--draft', '--prerelease', '--latest=false', '--title', tag,
                        '--notes', 'Verified Cargo build inputs from successful main pushes.'], check=True)
    prefix = f'{int(run_id)}-{int(metadata["run_attempt"])}'
    if published and any(entry['name'] == prefix + '.json' for entry in published['assets']):
        if published['draft']:
            subprocess.run([*gh, 'edit', tag, '--repo', repository, '--draft=false', '--latest=false'], check=True)
        prune(tag, published)
        return
    # Resume a failed upload without overwriting a committed generation.
    if published:
        for entry in published['assets']:
            if entry['name'].startswith(prefix + '-'):
                subprocess.run([*gh, 'delete-asset', tag, entry['name'], '--repo', repository, '--yes'], check=True)
    with tempfile.TemporaryDirectory() as temporary:
        stage = Path(temporary)
        chunks = split(directory / 'cache.tar.zst', stage, prefix)
        sources = stage / (prefix + '-sources.json')
        shutil.copyfile(directory / 'sources.json', sources)
        for name in [*chunks, sources.name]:
            subprocess.run([*gh, 'upload', tag, str(stage / name), '--repo', repository], check=True)
        uploaded = {entry['name']: entry for entry in release(tag, allow_draft=True)['assets']}
        for name in [*chunks, sources.name]:
            entry = uploaded[name]
            if entry.get('digest') != 'sha256:' + cache.digest(stage / name) or entry['size'] != (stage / name).stat().st_size:
                raise ValueError('Published Cargo snapshot GitHub digest mismatch')
        manifest = stage / (prefix + '.json')
        manifest.write_text(json.dumps(dict(metadata=metadata, chunks=chunks)))
        subprocess.run([*gh, 'upload', tag, str(manifest), '--repo', repository], check=True)
    if published is None or published['draft']:
        subprocess.run([*gh, 'edit', tag, '--repo', repository, '--draft=false', '--latest=false'], check=True)
    prune(tag, release(tag))


def publish_run(run_id):
    repository = os.environ['GITHUB_REPOSITORY']
    artifacts = api(f'repos/{repository}/actions/runs/{int(run_id)}/artifacts?per_page=100')['artifacts']
    for artifact in artifacts:
        if artifact['expired'] or not artifact['name'].startswith('cargo-build-cache-'):
            continue
        with tempfile.TemporaryDirectory() as temporary:
            subprocess.run(['gh', 'run', 'download', str(run_id), '--repo', repository,
                            '--name', artifact['name'], '--dir', temporary], check=True)
            directory = Path(temporary)
            try:
                publish(directory, run_id)
            except UnsuccessfulProducer:
                print('Not publishing a snapshot from an unsuccessful producer lane.')


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != 'publish-run':
        raise SystemExit('Usage: cargo-target-release.py publish-run RUN_ID')
    publish_run(sys.argv[2])
