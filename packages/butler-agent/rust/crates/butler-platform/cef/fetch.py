"""Fetch the pinned CEF distribution for dev builds and CI.
cef-rs (cef-dll-sys =156.2.0) downloads CEF in its build script, but its
CDN index reader has a 10 MB response limit and the index is larger.
Builds instead set CEF_PATH to this script's pinned, size- and SHA-256-checked
archive layout. Never trust the network for what to run.
"""

import argparse
import hashlib
import json
import os
import pathlib
import platform
import shutil
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request

VERSION = "156.0.14"
BASE = "https://cef-builds.spotifycdn.com/"
# sha1 is the CDN index's own; cef-rs requires it in archive.json. sha256 is ours, from one verified download.
PINS = {
    ("Windows", "AMD64"): {
        "dir": "cef_windows_x86_64",
        "archive": "cef_binary_156.0.14+g4fa4ab5+chromium-156.0.8078.48_windows64_minimal.tar.bz2",
        "size": 175051364,
        "sha256": "99f8a6dffd47417e0caee7845a98c549b41f1d4246cd715dec843ca4b699ee57",
        "sha1": "72dc1dd1636acc2391609fa6f410aa09f09168d4",
    },
    ("Darwin", "arm64"): {
        "dir": "cef_macos_aarch64",
        "archive": "cef_binary_156.0.14+g4fa4ab5+chromium-156.0.8078.48_macosarm64_minimal.tar.bz2",
        "size": 134887274,
        "sha256": "ed994b907ad596ca609a0542a1e2b22aa97e93e98b8141fed4c24aef39b9ccf6",
        "sha1": "7359a9d293dd5c480bec3f18b762731b483b0e13",
    },
    ("Darwin", "x86_64"): {
        "dir": "cef_macos_x86_64",
        "archive": "cef_binary_156.0.14+g4fa4ab5+chromium-156.0.8078.48_macosx64_minimal.tar.bz2",
        "size": 141687370,
        "sha256": "e584ade521802f8c2779d24996b32ddc183e8502743e5e3910b7247bb08f24f1",
        "sha1": "bc46c83878741fa2b23486940dacebabb294bf39",
    },
    ("Linux", "x86_64"): {
        "dir": "cef_linux_x86_64",
        "archive": "cef_binary_156.0.14+g4fa4ab5+chromium-156.0.8078.48_linux64_minimal.tar.bz2",
        "size": 331729249,
        "sha256": "4191ac920a91a052eba04afb6ed830d47aed46a3e246c434a2f062c23588dc8a",
        "sha1": "d091c82a8655113a34616c08cb340bf92310298d",
    },
    ("Linux", "aarch64"): {
        "dir": "cef_linux_aarch64",
        "archive": "cef_binary_156.0.14+g4fa4ab5+chromium-156.0.8078.48_linuxarm64_minimal.tar.bz2",
        "size": 431248679,
        "sha256": "cdfcd5cafaa126bb7e103e3b6fbdef94a39bb791395eb21fe665ebecd008d995",
        "sha1": "7907f1d0319a8d920be9b3ba54c0c60e2d22a7fb",
    },
}


def download(path, pin):
    print(f"Downloading {pin['archive']}", file=sys.stderr)
    digest = hashlib.sha256()
    size = 0
    url = BASE + urllib.parse.quote(pin["archive"])
    with urllib.request.urlopen(url) as response, path.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > pin["size"]:
                raise ValueError(f"Archive exceeds pinned size {pin['size']}")
            digest.update(chunk)
            output.write(chunk)
    if size != pin["size"]:
        raise ValueError(f"Archive size mismatch: expected {pin['size']}, got {size}")
    if digest.hexdigest() != pin["sha256"]:
        raise ValueError("Archive SHA-256 mismatch")


def extract(path, target, pin, system):
    print(f"Extracting {pin['archive']}", file=sys.stderr)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent) as tmpdir:
        with tarfile.open(path, "r:bz2") as archive:
            archive.extractall(tmpdir, filter="data")
        source = pathlib.Path(tmpdir) / pin["archive"].removesuffix(".tar.bz2")
        if target.exists():
            shutil.rmtree(target)
        shutil.move(str(source / "Release"), str(target))
        if system in ("Windows", "Linux"):
            for entry in (source / "Resources").iterdir():
                shutil.move(str(entry), str(target / entry.name))
        for name in ("CMakeLists.txt", "cmake", "include", "libcef_dll", "CREDITS.html"):
            shutil.move(str(source / name), str(target / name))
    metadata = {"type": "minimal", "name": pin["archive"], "sha1": pin["sha1"], "sha256": pin["sha256"]}
    (target / "archive.json").write_text(json.dumps(metadata) + "\n", encoding="utf-8")


def fetch(dest, pin, system):
    target = dest / VERSION / pin["dir"]
    marker = target / "archive.json"
    if marker.exists():
        try:
            if json.loads(marker.read_text(encoding="utf-8")).get("sha256") == pin["sha256"]:
                return
        except (OSError, ValueError, AttributeError):
            pass
    dest.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=dest, delete=False) as temporary:
        path = pathlib.Path(temporary.name)
    try:
        download(path, pin)
        extract(path, target, pin, system)
    finally:
        path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", default=os.environ.get("CEF_PATH"))
    args = parser.parse_args()
    system, machine = platform.system(), platform.machine()
    aliases = {("Windows", "x86_64"): "AMD64", ("Linux", "arm64"): "aarch64"}
    pin = PINS.get((system, aliases.get((system, machine), machine)))
    if pin is None:
        print(f"Unsupported platform: {system} {machine}", file=sys.stderr)
        return 2
    dest = pathlib.Path(args.dest).expanduser() if args.dest else pathlib.Path.home() / ".cache" / "butler-cef"
    try:
        fetch(dest, pin, system)
    except (OSError, ValueError, tarfile.TarError, shutil.Error) as error:
        print(f"CEF fetch failed: {error}", file=sys.stderr)
        return 1
    print(dest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
