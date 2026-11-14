#!/usr/bin/env python3
"""Stage the headless CEF host and its runtime files."""

import argparse
import platform
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cef", required=True, type=Path)
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    system = platform.system()
    if system == "Darwin":
        print("macOS packaging is a later change", file=sys.stderr)
        return 2

    from fetch import VERSION, PINS

    key = (system, platform.machine())
    if key not in PINS:
        print(f"unsupported platform: {key}", file=sys.stderr)
        return 2
    cef_dir = args.cef.resolve() / VERSION / PINS[key]["dir"]
    out = args.out.resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    # Build inputs and the unrenamed launchers are not part of a host.
    excluded = {"archive.json", "CMakeLists.txt", "CREDITS.html", "bootstrap.exe", "bootstrapc.exe", "libcef.lib"}
    for source in cef_dir.iterdir():
        if source.is_file() and source.name not in excluded:
            shutil.copy2(source, out / source.name)
    shutil.copytree(cef_dir / "locales", out / "locales")
    if system == "Windows":
        executable = out / "butler_cef_host.exe"
        shutil.copy2(cef_dir / "bootstrapc.exe", executable)
        shutil.copy2(args.target / "butler_cef_host.dll", out / "butler_cef_host.dll")
    else:
        executable = out / "butler-cef-host"
        shutil.copy2(args.target / executable.name, executable)
    print(executable)
    return 0


if __name__ == "__main__":
    sys.exit(main())
