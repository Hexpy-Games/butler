"""Strip Linux archive executables after building, preserving Cargo cache keys."""
import json
import os
from pathlib import Path
import subprocess
import sys

metadata = json.loads(Path(sys.argv[1]).read_text())
build = metadata["rust-build-meta"]
target = Path(build["target-directory"])
paths = {Path(binary["binary-path"]) for binary in metadata["rust-binaries"].values()}
paths.add(target / "debug" / "butler-agent")
for binaries in build["non-test-binaries"].values():
    for binary in binaries:
        # Nextest also reports a lance-arrow .rlib as a dylib. It is a build
        # input, so leave its symbols intact for future links from this cache.
        path = target / binary["path"]
        if path.suffix != ".rlib":
            paths.add(path)

before = sum(path.stat().st_size for path in paths)
for path in sorted(paths):
    stat = path.stat()
    subprocess.run(["strip", "--strip-all", str(path)], check=True)
    # Cargo checks dependency output mtimes, including lance-arrow's .so.
    # Stripping metadata must not make its consumers rebuild unstripped.
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
after = sum(path.stat().st_size for path in paths)
print(f"Stripped {len(paths)} archive binaries: {before} -> {after} bytes")
