#!/usr/bin/env python3
"""Verified rolling OCI Cargo snapshots from existing main/release build jobs.

Immutable generation tags commit all chunks atomically. The compatibility tag
selects the latest generation; four generations per key survive package pruning,
so a restore can fall back past producers that are still running or failed.
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
import urllib.request

# Build scripts watch the recipe directory; imports must not create new inputs.
sys.dont_write_bytecode = True

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS.parents[1] / 'packages/butler-agent/rust/scripts'))
import ci_oci
import runner_cache

spec = importlib.util.spec_from_file_location('cargo_cache', SCRIPTS / 'cargo-artifact-cache.py')
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)
CHUNK_BYTES = 1800 * 1024**2
KEEP = 4
# Older generations a restore checks after the tagged one: one manifest lookup each.
WALK_BACK = KEEP - 1


class UnsuccessfulProducer(ValueError):
    """A completed CI run can contain other failed lanes; never publish those."""


def api(endpoint, method='GET'):
    """Use the workflow token without requiring GitHub CLI on owner hosts."""
    url = 'https://api.github.com/' + endpoint
    field = 'jobs' if '/jobs?' in endpoint else 'artifacts' if '/artifacts?' in endpoint else None
    entries = []
    while url:
        if not url.startswith('https://api.github.com/'):
            raise ValueError('Untrusted GitHub API pagination URL')
        request = urllib.request.Request(url, method=method, headers={
            'Authorization': 'Bearer ' + (os.environ.get('GITHUB_TOKEN') or os.environ['GH_TOKEN']),
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        })
        with urllib.request.urlopen(request, timeout=60) as response:
            if method == 'DELETE':
                return None
            value = json.load(response)
            if not field and not isinstance(value, list):
                return value
            entries.extend(value[field] if field else value)
            links = response.headers.get('Link', '')
            next_page = re.search(r'<([^>]+)>;\s*rel="next"', links)
            url = next_page[1] if next_page else None
    return {field: entries} if field else entries


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


def checked_generation(manifest, directory, expected, compatible):
    """Read a generation manifest; prefer an exact identity when `compatible` is None."""
    download(manifest, directory / 'generation.json')
    generation = json.loads((directory / 'generation.json').read_text())
    metadata = generation['metadata']
    if compatible is None:
        compatible = not cache.matches(metadata['identity'], expected)
    if not cache.matches(metadata['identity'], expected, compatible):
        raise ValueError('Cargo snapshot identity mismatch')
    trusted(metadata)
    return generation, compatible


def fetch_chunks(published, manifest, generation, directory):
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
    (directory / 'cache.json').write_text(json.dumps(generation['metadata']))


def fetch_snapshot(published, manifest, directory, expected, compatible=False):
    generation, _ = checked_generation(manifest, directory, expected, compatible)
    fetch_chunks(published, manifest, generation, directory)
    cache.verify(directory, expected, compatible)


def older_generations(expected, tried):
    """Generation suffixes under this compatibility key, newest first, minus the tried one."""
    prefix = compatible_tag(expected) + '--'
    suffixes = {tag.removeprefix(prefix) for tag in ci_oci.tags(f'{ci_oci.REGISTRY}/cargo-target')
                if tag.startswith(prefix) and re.fullmatch(r'\d+-\d+', tag.removeprefix(prefix))}
    suffixes.discard(tried['name'][:-5])
    return sorted(suffixes, key=lambda value: tuple(map(int, value.split('-'))), reverse=True)


def walk_back(expected, tried, directory):
    """Newest finished green generation, exact identity first; None when there is none."""
    prefix = compatible_tag(expected) + '--'
    older = older_generations(expected, tried)
    if len(older) > WALK_BACK:
        print(f'Checking the newest {WALK_BACK} of {len(older)} older Cargo snapshots.')
    fallback = None
    for suffix in older[:WALK_BACK]:
        published = release(prefix + suffix)
        manifest = next((entry for entry in published['assets'] if entry['name'] == suffix + '.json'),
                        None) if published else None
        if manifest is None:
            print(f'Cargo snapshot {suffix} was pruned; skipping it.')
            continue
        try:
            generation, compatible = checked_generation(manifest, directory, expected, None)
        except UnsuccessfulProducer as error:
            print(f'Cargo snapshot {suffix} skipped: {error}.')
            continue
        if not compatible:
            return published, manifest, generation, compatible
        fallback = fallback or (published, manifest, generation, compatible)
    return fallback


def tagged_release(expected):
    """The tag a restore tries first: exact, then the legacy profile key, then compatible."""
    published = release(tag_name(expected))
    if published:
        return published, expected, False
    if 'profile_config' in expected:
        # Existing snapshots already pin the exact manifest digest, which
        # proves these same profile settings. Keep that safe warm upgrade path.
        legacy = dict(expected, runtime=os.environ.get('ORT_LIB_PATH', ''))
        legacy.pop('profile_config')
        published = release(tag_name(legacy))
        if published:
            return published, legacy, False
    return release(compatible_tag(expected)), expected, True


def describe(generation, compatible):
    metadata = generation['metadata']
    match = 'compatible' if compatible else 'exact'
    return f'run {int(metadata["run_id"])} attempt {int(metadata.get("run_attempt", 1))}, {match} identity'


def restore(expected):
    local = persistent_target(expected)
    if local and restore_local(local, expected):
        return True
    published, selected_identity, compatible = tagged_release(expected)
    candidates = generations(published['assets']) if published else []
    if not candidates:
        print('No persistent CI snapshot for this lane; cold Cargo build follows.')
        return False
    with tempfile.TemporaryDirectory(dir=os.environ['RUNNER_TEMP']) as temporary:
        directory = Path(temporary)
        manifest = candidates[0]
        try:
            generation, _ = checked_generation(manifest, directory, selected_identity, compatible)
            reason = 'tagged generation; producer lane finished green'
        except UnsuccessfulProducer as error:
            print(f'Newest Cargo snapshot {manifest["name"][:-5]} skipped: {error}.')
            found = walk_back(expected, manifest, directory)
            if not found:
                print('No finished green Cargo snapshot for this lane; cold Cargo build follows.')
                return False
            published, manifest, generation, compatible = found
            selected_identity = expected
            reason = 'newest older generation whose producer lane finished green'
        print(f'Selected Cargo snapshot {manifest["name"][:-5]} ({describe(generation, compatible)}): {reason}.')
        fetch_chunks(published, manifest, generation, directory)
        restore_tree(directory, selected_identity, compatible)
    return True


def legacy_refs(base):
    # Old targets have only a ref hash. Resolve protected release/tag names
    # once during migration, including refs absent from a shallow checkout.
    base = runner_cache.namespace(base)
    if not runner_cache.lexists(base):
        return []
    legacy = False
    for path in runner_cache.children(base):
        if runner_cache.linked(path):
            raise ValueError(f'Linked Cargo ref directory: {path}')
        legacy |= runner_cache.is_directory(path) and not runner_cache.lexists(path / runner_cache.MARKER)
    if not legacy:
        return []
    output = subprocess.check_output(
        ['git', 'ls-remote', '--refs', 'origin', 'refs/heads/release/*', 'refs/tags/*'],
        cwd=os.environ.get('GITHUB_WORKSPACE'), text=True)
    return [line.split()[1] for line in output.splitlines()]


def persistent_target(expected):
    base = os.environ.get('BUTLER_PERSISTENT_TARGET')
    if not base:
        return None
    refs = legacy_refs(Path(base))
    target = runner_cache.prepare(base, os.environ['GITHUB_REF'], compatible_tag(expected), refs)
    os.environ['CARGO_TARGET_DIR'] = str(target)
    with open(os.environ['GITHUB_ENV'], 'a') as output:
        output.write(f'CARGO_TARGET_DIR={target}\n')
    return target


def target_path(path):
    """Cargo target trees exceed Windows MAX_PATH, so their paths take the extended form."""
    return Path(runner_cache.extended(path))


def restore_local(target, expected):
    marker = target_path(target / 'ci-local.json')
    if not marker.is_file():
        return False
    metadata = json.loads(marker.read_text())
    if not cache.matches(metadata['identity'], expected, compatible=True):
        raise ValueError('Local Cargo target identity mismatch')
    sources = target_path(target / 'ci-local-sources.json')
    if cache.digest(sources) != metadata['sources_sha256']:
        raise ValueError('Local Cargo source digest mismatch')
    cache.source_times.restore(Path(os.environ['GITHUB_WORKSPACE']), json.loads(sources.read_text()))
    print('Reused isolated runner-local Cargo target; Cargo verifies unit fingerprints.')
    return True


def save_local(target, expected):
    # Capture only after a successful build. A failed compile must retain the
    # previous digest so changed sources stay dirty on the next checkout.
    sources = target_path(target / 'ci-local-sources.json')
    sources.write_text(json.dumps(cache.source_times.capture(Path(os.environ['GITHUB_WORKSPACE']))))
    marker = dict(identity=expected, sources_sha256=cache.digest(sources))
    target_path(target / 'ci-local.json').write_text(json.dumps(marker))
    if os.environ.get('BUTLER_PERSISTENT_TARGET'):
        runner_cache.record_size(os.environ['BUTLER_PERSISTENT_TARGET'], target)


def restore_tree(directory, expected, compatible=False):
    cache.verify(directory, expected, compatible)
    directory = directory.resolve()
    # Extended paths skip normalization, so collapse separators and `..` first.
    target = Path(os.path.abspath(os.environ.get('CARGO_TARGET_DIR', 'target')))
    # Do not merge newer/foreign fingerprints or executables into the snapshot.
    if runner_cache.lexists(target) and runner_cache.linked(target):
        raise ValueError('Symlink Cargo target directory')
    runner_cache.delete_tree(target)
    os.makedirs(runner_cache.extended(target.parent), exist_ok=True)
    stage = Path(tempfile.mkdtemp(dir=runner_cache.extended(target.parent)))
    try:
        # Windows applies MAX_PATH to cwd plus a relative name, and Cargo units
        # nest past it below the stage: extract to the extended stage instead.
        cache.extract(directory, base=stage)
        os.rename(stage / 'target', runner_cache.extended(target))
    except BaseException as error:
        try:
            runner_cache.delete_tree(stage)
        except OSError as cleanup:  # Report the restore failure, not its cleanup.
            error.add_note(f'Cargo snapshot stage cleanup also failed: {cleanup}')
        raise
    runner_cache.delete_tree(stage)
    cache.source_times.restore(Path(os.environ['GITHUB_WORKSPACE']),
                              json.loads((directory / 'sources.json').read_text()))
    print(f'Restored verified CI Cargo snapshot at {json.loads((directory / "cache.json").read_text())["sha"]}.')


def tag_name(expected):
    return cache.artifact_name(expected).removeprefix('cargo-build-cache-')


def compatible_tag(expected):
    return 'compatible-' + tag_name(cache.compatible_identity(expected))


def recorded_parts(directory, prefix):
    """Upload parts written by the recorder, numbered consecutively from zero."""
    names = sorted(path.name for path in directory.glob(prefix + '-*.zst'))
    if not names or names != [f'{prefix}-{index:04}.zst' for index in range(len(names))]:
        raise ValueError('Cargo snapshot parts are missing or misnamed')
    return names


def report_free_disk(label):
    usage = shutil.disk_usage(os.environ['RUNNER_TEMP'])
    print(f'Free disk {label}: {usage.free / 1024**3:.1f} of {usage.total / 1024**3:.1f} GiB.', flush=True)


def prune(tag, prefix):
    # GHCR does not implement registry manifest deletion. Package version
    # deletion uses the same workflow token, with package admin access inherited
    # from the linked repository. Never delete another compatibility key.
    repository = os.environ['GITHUB_REPOSITORY']
    owner = repository.split('/')[0]
    endpoint = f'orgs/{owner}/packages/container/butler-ci%2Fcargo-target/versions'
    pages = api(endpoint + '?per_page=100')
    versions = []
    for entry in pages:
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
        api(endpoint + '/' + str(entry['id']), method='DELETE')


def publish(directory, run_id):
    metadata = json.loads((directory / 'cache.json').read_text())
    if str(metadata['run_id']) != str(run_id):
        raise ValueError('Cargo snapshot run mismatch')
    trusted(metadata, publishing=True)
    prefix = f'{int(run_id)}-{int(metadata["run_attempt"])}'
    chunks = recorded_parts(directory, prefix)
    cache.verify(directory, metadata['identity'], parts=chunks)
    tag = compatible_tag(metadata['identity'])
    reference = f'{ci_oci.REGISTRY}/cargo-target:{tag}--{prefix}'
    committed = ci_oci.manifest(reference, anonymous=False)
    if committed is None:
        sources = directory / (prefix + '-sources.json')
        shutil.copyfile(directory / 'sources.json', sources)
        manifest = directory / (prefix + '.json')
        manifest.write_text(json.dumps(dict(metadata=metadata, chunks=chunks)))
        # OCI commits its manifest only after every complete chunk is stored.
        ci_oci.push(reference, [*(directory / name for name in chunks), sources, manifest])
    else:
        with tempfile.TemporaryDirectory() as temporary:
            manifest = next(entry for entry in committed['assets'] if entry['name'] == prefix + '.json')
            download_manifest = Path(temporary) / 'generation.json'
            ci_oci.fetch(manifest, download_manifest, anonymous=False)
            if json.loads(download_manifest.read_text())['metadata'] != metadata:
                raise ValueError('Committed Cargo generation cannot be overwritten')
    ci_oci.checked('tag', reference, tag, anonymous=False)
    ci_oci.checked('tag', reference, tag_name(metadata['identity']), anonymous=False)
    if os.environ.get('BUTLER_OCI_LAYOUT') != '1':
        prune(tag, prefix)


def publish_lane(platform, mode, kind):
    expected = cache.identity(platform, mode, kind)
    run_id = os.environ['GITHUB_RUN_ID']
    prefix = f'{int(run_id)}-{int(os.environ.get("GITHUB_RUN_ATTEMPT", "1"))}'
    report_free_disk('before snapshot')
    # The only extra disk is one compressed copy, written directly as upload parts.
    with tempfile.TemporaryDirectory(dir=os.environ['RUNNER_TEMP']) as temporary:
        directory = Path(temporary)
        cache.record(directory, expected, target=os.environ.get('CARGO_TARGET_DIR', 'target'),
                     part=(prefix, CHUNK_BYTES))
        report_free_disk('after compression')
        publish(directory, run_id)


if __name__ == '__main__':
    if len(sys.argv) != 5 or sys.argv[1] != 'publish-lane':
        raise SystemExit('Usage: cargo-target-release.py publish-lane PLATFORM MODE KIND')
    publish_lane(*sys.argv[2:])
