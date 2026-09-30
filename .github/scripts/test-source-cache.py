"""Prove Cargo reuses unchanged sources and rebuilds changed, backdated sources."""
# test-category: pure-logic
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

script = Path(__file__).with_name("restore-source-mtimes.py")
targets_script = Path(__file__).with_name("cache-workspace-targets.py")
with tempfile.TemporaryDirectory(prefix="butler-source-cache-") as temporary:
    root = Path(temporary)
    crate = root / "packages/butler-agent/rust"
    (crate / "src").mkdir(parents=True)
    (crate / "Cargo.toml").write_text(
        '[package]\nname="cache-proof"\nversion="0.0.0"\nedition="2021"\n'
    )
    source = crate / "src/main.rs"
    source.write_text('fn main() { println!("old"); }\n')
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    snapshot = root / "snapshot.json"
    env = dict(os.environ, CARGO_TARGET_DIR=str(root / "target"))

    def restore():
        subprocess.run([sys.executable, str(script), str(root), str(snapshot)], check=True)

    def build():
        result = subprocess.check_output(
            ["cargo", "build", "--offline", "-j", "8", "--message-format", "json"],
            cwd=crate, env=env,
        )
        return next(json.loads(line)["fresh"] for line in result.splitlines()
                    if json.loads(line)["reason"] == "compiler-artifact")

    restore()
    assert not build()
    original = source.stat().st_mtime_ns
    target_cache = root / "target-cache"
    subprocess.run([sys.executable, str(targets_script), "save", str(target_cache)],
                   cwd=crate, env=env, check=True)
    for name in json.loads((target_cache / "files.json").read_text()):
        (root / "target" / name).unlink()
    subprocess.run([sys.executable, str(targets_script), "restore", str(target_cache)],
                   cwd=crate, env=env, check=True)
    os.utime(source, None)  # A new checkout of the same contents.
    restore()
    assert source.stat().st_mtime_ns == original
    assert build(), "Unchanged source should reuse Cargo's artifact"
    source.write_text('fn main() { println!("new"); }\n')
    os.utime(source, ns=(1, 1))  # Deliberately backdate changed contents.
    restore()
    assert not build(), "Changed contents must rebuild regardless of old timestamps"
    assert subprocess.check_output([str(root / "target/debug/cache-proof")]) == b"new\n"
    source.unlink()
    restore()
    assert str(source.relative_to(root)) not in json.loads(snapshot.read_text())
    deleted = subprocess.run(
        ["cargo", "build", "--offline", "-j", "8"], cwd=crate, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    assert deleted.returncode != 0 and b"no targets specified" in deleted.stderr
print("Cargo source-cache correctness proof passed")
