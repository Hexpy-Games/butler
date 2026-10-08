"""Build-host provenance for the pinned native recipe."""
import hashlib
import subprocess
import os
import pathlib
import platform
import shutil
import sys

RUST_ROOT = pathlib.Path(__file__).resolve().parent.parent


def fail(message):
    raise RuntimeError(message)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def command(args, *, cwd=None):
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=False)
    if result.returncode:
        fail(f"{' '.join(map(str, args))} failed: {(result.stderr or result.stdout).strip()}")
    return result.stdout.strip()


def rust_identity(rust_target):
    rustc = command(["rustc", "--version", "--verbose"], cwd=RUST_ROOT)
    rustc_fields = dict(line.split(": ", 1) for line in rustc.splitlines() if ": " in line)
    if rustc_fields.get("release") != "1.99.0" or rustc_fields.get("host") != rust_target:
        fail("Static ORT preparation requires the pinned Rust 1.99.0 toolchain.")
    return rustc


def compiler_identity(variable, default):
    selected = os.environ.get(variable) or default
    resolved = shutil.which(selected)
    if not resolved:
        fail(f"C/C++ compiler {selected} ({variable}) is required for the static ORT build")
    return {"path": resolved, "version": command([resolved, "--version"])}


def os_release():
    fields = {}
    try:
        text = pathlib.Path("/etc/os-release").read_text()
    except OSError:
        return fields
    for line in text.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            if key in ("ID", "VERSION_ID"):
                fields[key] = value.strip().strip('"')
    return fields


def visual_studio_identity():
    """The installed MSVC toolset, read without a developer environment."""
    root = pathlib.Path(os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)"))
    vswhere = root / "Microsoft Visual Studio/Installer/vswhere.exe"
    if not vswhere.is_file():
        fail("Visual Studio (vswhere.exe) is required on a Windows host")
    query = [str(vswhere), "-latest", "-products", "*", "-requires",
             "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"]
    installation = pathlib.Path(command([*query, "-property", "installationPath"]))
    tools = installation / "VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt"
    return {
        "installation_version": command([*query, "-property", "installationVersion"]),
        "vc_tools_version": tools.read_text().strip() if tools.is_file() else "unknown",
    }


def host_identity(target, rust_target):
    if sys.version_info < (3, 9):
        fail("Static ONNX Runtime preparation requires Python 3.9 or newer.")
    if target == "macos-arm64":
        clang = command(["xcrun", "--find", "clang"])
        rustc = rust_identity(rust_target)
        return {
            "system": command(["sw_vers", "-productVersion"]),
            "sdk_path": command(["xcrun", "--show-sdk-path"]),
            "sdk_version": command(["xcrun", "--show-sdk-version"]),
            "clang_path": clang,
            "clang_version": command([clang, "--version"]),
            "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "rustc": rustc,
            "rust_toolchain": (RUST_ROOT / "rust-toolchain.toml").read_text(),
        }
    identity = {
        "target": target,
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "rustc": rust_identity(rust_target),
        "rust_toolchain": (RUST_ROOT / "rust-toolchain.toml").read_text(),
    }
    if target.startswith("linux-"):
        identity.update({
            "system": os_release(),
            "libc": "-".join(platform.libc_ver()),
            "cc": compiler_identity("CC", "cc"),
            "cxx": compiler_identity("CXX", "c++"),
        })
    else:
        identity.update({
            "system": platform.version(),
            "msvc": visual_studio_identity(),
        })
    return identity
