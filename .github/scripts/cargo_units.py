"""Find Cargo units that the current build no longer uses.

Cargo never deletes a unit whose hash changed (a dependency or workspace version
bump), so a snapshot that is restored, rebuilt and recorded again keeps every
superseded copy and grows each generation. Each unit's fingerprint records the
fingerprints of the units it was built against:

- a unit whose recorded dependency no longer exists is dirty or dead, because
  Cargo rebuilds a unit whenever a dependency's fingerprint changes;
- of the top-level units (no remaining dependents) built for the same target,
  profile and settings, only the newest belongs to the current build;
- everything those newest units reach is live, and the rest stays out.
"""
import collections
import json
from pathlib import PurePosixPath
import re

UNIT = re.compile(r'(.+)-([0-9a-f]{16})')
OUTPUT = re.compile(r'.+-([0-9a-f]{16})(?:\..*)?')
HASHED_DIRECTORIES = {'.fingerprint', 'build', 'deps', 'examples'}


def units(target):
    """Each fingerprint in `target`, identified by its output directory and unit hash."""
    for fingerprints in [*target.glob('*/.fingerprint'), *target.glob('*/*/.fingerprint')]:
        profile = fingerprints.parent.relative_to(target).as_posix()
        for directory in fingerprints.iterdir():
            unit = UNIT.fullmatch(directory.name)
            if not unit or not directory.is_dir():
                continue
            for described in directory.glob('*.json'):
                value = described.with_suffix('')
                if not value.is_file():
                    continue  # An interrupted build; its outputs are kept as they are.
                data = json.loads(described.read_text())
                # Declared features come from the manifest: every live copy of a unit shares them.
                settings = {name: field for name, field in data.items()
                            if name not in ('deps', 'local', 'declared_features')}
                yield dict(id=f'{profile}/{unit[2]}', value=value.read_text().strip(),
                           deps=[entry[-1].to_bytes(8, 'little').hex() for entry in data['deps']],
                           slot=(profile, unit[1], value.name, json.dumps(settings, sort_keys=True)),
                           mtime=value.stat().st_mtime)


def consistent(found, by_value):
    """Units whose recorded dependency fingerprints all still exist among consistent units."""
    good = set(range(len(found)))
    changed = True
    while changed:
        changed = False
        for index in list(good):
            if not all(good.intersection(by_value.get(value, ())) for value in found[index]['deps']):
                good.discard(index)
                changed = True
    return good


def live(found, by_value, good):
    dependents = collections.Counter(other for index in good for value in found[index]['deps']
                                     for other in by_value[value] if other in good)
    newest = {}
    for index in good:
        newest[found[index]['slot']] = max(newest.get(found[index]['slot'], 0), found[index]['mtime'])
    pending = [index for index in good
               if not dependents[index] and found[index]['mtime'] == newest[found[index]['slot']]]
    reached = set()
    while pending:
        index = pending.pop()
        if index not in reached:
            reached.add(index)
            pending.extend(other for value in found[index]['deps'] for other in by_value[value] if other in good)
    return {found[index]['id'] for index in reached}


def stale(target):
    """Unit ids (`<profile>/<hash>`) that the newest build no longer uses."""
    try:
        found = list(units(target))
    except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError, OverflowError) as error:
        print(f'Keeping every Cargo unit; unreadable fingerprint: {error!r}')
        return set()
    by_value = collections.defaultdict(list)
    for index, unit in enumerate(found):
        by_value[unit['value']].append(index)
    # The newest unit was just built against existing dependencies. If they do
    # not resolve, this Cargo records fingerprints differently; keep everything.
    newest = max((unit for unit in found if unit['deps']), key=lambda unit: unit['mtime'], default=None)
    if newest and not all(value in by_value for value in newest['deps']):
        print('Keeping every Cargo unit; unrecognized dependency fingerprints.')
        return set()
    ids = {unit['id'] for unit in found}
    kept = live(found, by_value, consistent(found, by_value))
    if ids:
        print(f'Cargo snapshot keeps {len(kept)} of {len(ids)} units; {len(ids - kept)} superseded units stay out.')
    return ids - kept


def excluded(name, units):
    """Whether archive member `name` (`<root>/<profile>/<dir>/<entry>`) belongs to a stale unit."""
    parts = PurePosixPath(name).parts
    if len(parts) < 4 or parts[-2] not in HASHED_DIRECTORIES:
        return False
    output = OUTPUT.fullmatch(parts[-1])
    return bool(output) and '/'.join([*parts[1:-2], output[1]]) in units
