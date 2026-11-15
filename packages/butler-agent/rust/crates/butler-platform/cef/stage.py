#!/usr/bin/env python3
"""Stage the headless CEF host and its runtime files."""

import argparse
import platform
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def write_plist(contents, name, identifier):
    info = dict(
        CFBundleName=name,
        CFBundleExecutable=name,
        CFBundleIdentifier=identifier,
        CFBundlePackageType="APPL",
        CFBundleInfoDictionaryVersion="6.0",
        CFBundleVersion="0.0.0",
        CFBundleShortVersionString="0.0.0",
        LSMinimumSystemVersion="12.0",
        NSHighResolutionCapable=True,
        LSUIElement=True,
    )
    with (contents / "Info.plist").open("wb") as file:
        plistlib.dump(info, file)


def stage_mac(cef_dir, target, out):
    app = out / "ButlerCefHost.app"
    contents = app / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    (contents / "Frameworks").mkdir()
    binary = target / "butler-cef-host"
    executable = contents / "MacOS" / binary.name
    shutil.copy2(binary, executable)
    framework = "Chromium Embedded Framework.framework"
    shutil.copytree(cef_dir / framework, contents / "Frameworks" / framework, symlinks=True)
    identifier = "games.hexpy.butler.cef-host"
    write_plist(contents, binary.name, identifier)
    for suffix in ["", " (GPU)", " (Renderer)", " (Plugin)", " (Alerts)"]:
        name = f"butler-cef-host Helper{suffix}"
        helper = contents / "Frameworks" / f"{name}.app" / "Contents"
        (helper / "MacOS").mkdir(parents=True)
        shutil.copy2(binary, helper / "MacOS" / name)
        helper_suffix = "." + suffix.strip(" ()").lower() if suffix else ""
        write_plist(helper, name, identifier + ".helper" + helper_suffix)
    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(app)], check=True)
    return executable


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cef", required=True, type=Path)
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    system = platform.system()

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
    if system == "Darwin":
        print(stage_mac(cef_dir, args.target, out))
        return 0
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
