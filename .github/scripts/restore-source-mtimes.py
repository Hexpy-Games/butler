"""Reuse Cargo source timestamps only after verifying the complete file contents."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root, snapshot = map(Path, sys.argv[1:])
previous = json.loads(snapshot.read_text()) if snapshot.exists() else {}
tracked = subprocess.check_output(
    ["git", "-C", str(root), "ls-files", "-z", "--", "packages/butler-agent/rust"],
    env=dict(os.environ, GIT_OPTIONAL_LOCKS="0"),
).decode().split("\0")
current = {}
restored = 0
for name in filter(None, tracked):
    path = root / name
    if path.is_symlink() or not path.is_file():
        continue
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    stat = path.stat()
    old = previous.get(name)
    if old and old[0] == digest:
        modified = old[1]
        restored += 1
    else:
        # A changed file must rebuild even if its checkout timestamp was old.
        modified = max(time.time_ns(), stat.st_mtime_ns)
    os.utime(path, ns=(stat.st_atime_ns, modified))
    current[name] = [digest, modified]
snapshot.parent.mkdir(parents=True, exist_ok=True)
snapshot.write_text(json.dumps(current))
print(f"Verified {len(current)} source files; restored {restored} unchanged timestamps")
