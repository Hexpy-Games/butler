"""Bound runner-local caches without traversing links or reparse points."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

MARKER = 'last-used.json'
OTHER_REFS = 3


def log(message):
    # `cargo-artifact-cache.py target` reserves stdout for the selected path.
    print(message, file=sys.stderr)


def linked(path):
    info = os.lstat(extended(path))
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def namespace(path):
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        if os.path.lexists(part) and linked(part):
            raise ValueError(f'Cache namespace contains a link: {part}')
    return path


def contained(base, path):
    path = Path(os.path.abspath(path))
    if path == base or not path.is_relative_to(base):
        raise ValueError(f'Refusing cache operation outside namespace: {path}')
    for part in path.relative_to(base).parts[:-1]:
        base = base / part
        if os.path.lexists(base) and linked(base):
            raise ValueError(f'Cache ancestor contains a link: {base}')
    return path


def extended(path):
    value = str(path)
    if os.name == 'nt' and not value.startswith('\\\\?\\'):
        return '\\\\?\\UNC\\' + value[2:] if value.startswith('\\\\') else '\\\\?\\' + value
    return value


def remove_tree(base, path):
    """Validate the boundary once, then inspect every entry without following it."""
    base = namespace(base)
    return _remove_tree(contained(base, path))


def _remove_tree(path):
    if not os.path.lexists(extended(path)):
        return 0
    info = os.lstat(extended(path))
    if linked(path):
        # Windows directory junctions require rmdir, not unlink or chmod.
        operation = os.rmdir if stat.S_ISDIR(info.st_mode) else os.unlink
        operation(extended(path))
        return 0
    if not info.st_mode & stat.S_IWRITE:
        os.chmod(extended(path), info.st_mode | stat.S_IWRITE | stat.S_IREAD)
    if stat.S_ISDIR(info.st_mode):
        size = sum(_remove_tree(path / child.name) for child in Path(extended(path)).iterdir())
        os.rmdir(extended(path))
        return size
    os.unlink(extended(path))
    return info.st_size


def tree_bytes(path):
    """Only cold/missing estimates and completed builds need a metadata walk."""
    if linked(path):
        return 0
    if not path.is_dir():
        return path.stat().st_size
    return sum(tree_bytes(path / child.name) for child in Path(extended(path)).iterdir())


def read_marker(directory):
    marker = directory / MARKER
    if not os.path.lexists(marker):
        return {}
    if linked(marker):
        raise ValueError(f'Linked cache marker: {marker}')
    try:
        value = json.loads(marker.read_text())
        return value if isinstance(value, dict) else {}
    except (ValueError, OSError):
        return {}


def write_marker(directory, value, preserve_time=False):
    marker = directory / MARKER
    previous = (marker if marker.exists() else directory).stat() if preserve_time else None
    if os.path.lexists(marker) and linked(marker):
        raise ValueError(f'Linked cache marker: {marker}')
    marker.write_text(json.dumps(value))
    if previous:
        os.utime(marker, ns=(previous.st_atime_ns, previous.st_mtime_ns))


def ref_key(ref):
    return hashlib.sha256(ref.encode()).hexdigest()[:16]


def last_used(directory):
    marker = directory / MARKER
    return (marker if marker.exists() else directory).stat().st_mtime_ns


def evict(base, directory, reason):
    freed = remove_tree(base, directory)
    log(f'Runner cache evicted {directory.name}: {reason}; bytes freed={freed}')


def prune_identities(base, directory, selected=None):
    children = []
    for child in directory.iterdir():
        if linked(child):
            raise ValueError(f'Linked Cargo cache entry: {child}')
        if child.is_dir():
            children.append(child)
    keep = selected or (max(children, key=lambda path: path.stat().st_mtime_ns) if children else None)
    changed = False
    for child in children:
        if child != keep:
            evict(base, child, 'obsolete Cargo identity')
            changed = True
    return changed


def budget(variable, default):
    value = float(os.environ.get(variable, default))
    if not 0 < value < float('inf'):
        raise ValueError(f'{variable} must be a positive finite GiB count')
    return int(value * 1024**3)


def prepare(base, ref, identity, known_refs=()):
    base = namespace(base)
    base.mkdir(parents=True, exist_ok=True)
    if Path(identity).name != identity or identity in ('.', '..'):
        raise ValueError('Invalid Cargo identity directory')
    current = base / ref_key(ref)
    target = current / identity
    contained(base, target)
    cap = budget('BUTLER_PERSISTENT_TARGET_MAX_GB', 120)
    names = {ref_key(name): name for name in (*known_refs, 'refs/heads/main', ref)}
    entries = []
    for directory in base.iterdir():
        if linked(directory):
            raise ValueError(f'Linked Cargo ref directory: {directory}')
        if directory.is_dir():
            metadata = read_marker(directory)
            name = names.get(directory.name, metadata.get('ref', ''))
            entries.append((directory, name, last_used(directory)))
    entries.sort(key=lambda entry: entry[2], reverse=True)
    tags = [path for path, name, _ in entries if name.startswith('refs/tags/')]
    keep = {current, base / ref_key('refs/heads/main'), *tags[:1]}
    keep.update(path for path, name, _ in entries if name.startswith('refs/heads/release/'))
    others = [path for path, name, _ in entries if path not in keep and not name.startswith('refs/tags/')]
    keep.update(others[:OTHER_REFS])
    retained = []
    for directory, name, used in entries:
        if directory not in keep:
            evict(base, directory, 'ref retention')
            continue
        changed = prune_identities(base, directory, target if directory == current else None)
        metadata = read_marker(directory)
        size = metadata.get('bytes')
        if changed or type(size) is not int or size < 0:
            size = tree_bytes(directory)
            write_marker(directory, dict(ref=name, bytes=size), preserve_time=True)
        retained.append((directory, used, size))
    total = sum(size for _, _, size in retained)
    for directory, _, size in sorted(retained, key=lambda entry: entry[1]):
        if total <= cap:
            break
        if directory in (current, base / ref_key('refs/heads/main')):
            continue
        evict(base, directory, 'namespace size cap')
        total -= size
    log(f'Runner Cargo cache estimated bytes={total}; cap bytes={cap}')
    if total > cap:
        log('::warning::Protected main/current Cargo targets exceed the namespace cap')
    target.mkdir(parents=True, exist_ok=True)
    metadata = read_marker(current)
    write_marker(current, dict(metadata, ref=ref))
    os.utime(target, None)
    return target


def record_size(base, target):
    base = namespace(base)
    target = contained(base, target)
    directory = target.parent
    if directory.parent != base or linked(target):
        raise ValueError('Invalid persistent Cargo target')
    metadata = read_marker(directory)
    size = tree_bytes(directory)
    write_marker(directory, dict(metadata, bytes=size))
    log(f'Runner Cargo ref {directory.name}: measured bytes={size}')


def auxiliary_caches():
    base = namespace(os.environ['OWNER_CACHE_ROOT'])
    cap = budget('BUTLER_DEPENDENCY_CACHE_MAX_GB', 10)
    for name in ('npm', 'bun', 'nuget'):
        directory = base / name
        if not directory.exists() and not directory.is_symlink():
            continue
        if linked(directory):
            raise ValueError(f'Linked dependency cache: {directory}')
        size = tree_bytes(directory)
        log(f'Runner {name} cache measured bytes={size}; cap bytes={cap}')
        if size > cap:
            evict(base, directory, 'dependency cache size cap')


if __name__ == '__main__':
    auxiliary_caches()
