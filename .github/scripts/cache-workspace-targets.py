"""Retain non-library workspace outputs discarded by rust-cache's cleanup."""
import json
from pathlib import Path
import shutil
import subprocess
import sys

mode, directory = sys.argv[1:]
cache = Path(directory)
metadata = json.loads(subprocess.check_output(
    ["cargo", "metadata", "--locked", "--no-deps", "--format-version", "1"]
))
target = Path(metadata["target_directory"])
manifest = cache / "files.json"
if mode == "save":
    members = set(metadata["workspace_members"])
    paths = set()
    for package in metadata["packages"]:
        if package["id"] not in members:
            continue
        for binary in package["targets"]:
            if not set(binary["kind"]) & {"bin", "test", "bench", "example"}:
                continue
            # Qualification changes on each commit, so the real agent must
            # relink anyway. Its library outputs already live in rust-cache.
            if binary["name"] == "butler-agent":
                continue
            stem = binary["name"].replace("-", "_")
            for prefix in [stem, "lib" + stem]:
                paths.update((target / "debug/deps").glob(prefix + "-*"))
            paths.add(target / "debug" / binary["name"])
            paths.add(target / "debug" / (binary["name"] + ".d"))
    names = sorted(str(path.relative_to(target)) for path in paths
                   if path.is_file() and not path.is_symlink())
    source, destination = target, cache
elif mode == "restore":
    names = json.loads(manifest.read_text()) if manifest.exists() else []
    source, destination = cache, target
else:
    raise ValueError(mode)
for name in names:
    relative = Path(name)
    assert not relative.is_absolute() and ".." not in relative.parts, name
    output = destination / relative
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / relative, output)
if mode == "save":
    cache.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(names))
print(f"{mode}: {len(names)} workspace target files, including dependency records")
