#!/usr/bin/env python3
"""Prepare the pinned macOS arm64 ORT static link cache for the native producer."""

import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import platform
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import uuid
import zipfile


SCRIPT = pathlib.Path(__file__).resolve()
RUST_ROOT = SCRIPT.parent.parent
LOCK = SCRIPT.with_name("static-ort-macos-arm64.lock.json")
EXPECTED_ORT_LIBS = (
    "common", "flatbuffers", "framework", "graph", "lora", "mlas",
    "optimizer", "providers", "session", "util",
)
MIN_FREE_BYTES = 8 * 1024**3
MAX_BUILD_SECONDS = 60 * 60
MAX_DOWNLOAD_SECONDS = 20 * 60
MAX_ARCHIVE_BYTES = 512 * 1024**2


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


def host_identity():
    if sys.platform != "darwin" or platform.machine() != "arm64":
        fail("Static ONNX Runtime preparation supports only a macOS arm64 host.")
    if sys.version_info < (3, 9):
        fail("Static ONNX Runtime preparation requires Python 3.9 or newer.")
    clang = command(["xcrun", "--find", "clang"])
    rustc = command(["rustc", "--version", "--verbose"], cwd=RUST_ROOT)
    rustc_fields = dict(line.split(": ", 1) for line in rustc.splitlines() if ": " in line)
    if (rustc_fields.get("release") != "1.91.0"
            or rustc_fields.get("host") != "aarch64-apple-darwin"):
        fail("Static ORT preparation requires the pinned Rust 1.91.0 toolchain.")
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


def root_for_target():
    selected = os.environ.get("CARGO_TARGET_DIR")
    target = pathlib.Path(selected) if selected else RUST_ROOT / "target"
    if not target.is_absolute():
        target = RUST_ROOT / target
    return target.resolve() / "native-deps"


def check_space(root):
    if shutil.disk_usage(root).free <= MIN_FREE_BYTES:
        fail("Static ORT build requires more than 8 GiB free in its target cache volume.")


def download(spec, destination):
    if destination.is_file() and sha256(destination) == spec["sha256"]:
        return
    if destination.exists():
        fail(f"Unverified download already exists: {destination}")
    if shutil.disk_usage(destination.parent).free <= MIN_FREE_BYTES + MAX_ARCHIVE_BYTES:
        fail("Insufficient free space to download pinned build source")
    temporary = destination.with_name(destination.name + ".part")
    try:
        curl = pathlib.Path("/usr/bin/curl")
        if not curl.is_file():
            fail("macOS system curl is required for pinned archive download")
        subprocess.run([
            str(curl), "--fail", "--location", "--silent", "--show-error",
            "--connect-timeout", "30", "--max-time", str(MAX_DOWNLOAD_SECONDS),
            "--max-filesize", str(MAX_ARCHIVE_BYTES), "--retry", "2",
            "--output", str(temporary), spec["url"],
        ], check=True, timeout=MAX_DOWNLOAD_SECONDS + 30)
        if sha256(temporary) != spec["sha256"]:
            fail(f"Archive digest mismatch: {spec['url']}")
        temporary.rename(destination)
    finally:
        temporary.unlink(missing_ok=True)


def archive_members_safe(names):
    for name in names:
        parts = pathlib.PurePosixPath(name).parts
        if name.startswith("/") or ".." in parts:
            fail(f"Unsafe archive member: {name}")


def extract(archive, destination):
    destination.mkdir(parents=True)
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as source:
            members = source.infolist()
            archive_members_safe(item.filename for item in members)
            expanded = sum(item.file_size for item in members)
            if expanded > 4 * 1024**3 or shutil.disk_usage(destination).free <= MIN_FREE_BYTES + expanded:
                fail("Archive expansion exceeds disk resource bound")
            for item in members:
                if (item.external_attr >> 16) & 0o170000 == 0o120000:
                    fail(f"Unexpected archive symlink: {item.filename}")
            source.extractall(destination)
    else:
        with tarfile.open(archive, "r:gz") as source:
            members = source.getmembers()
            archive_members_safe(item.name for item in members)
            expanded = sum(item.size for item in members)
            if expanded > 4 * 1024**3 or shutil.disk_usage(destination).free <= MIN_FREE_BYTES + expanded:
                fail("Archive expansion exceeds disk resource bound")
            for item in members:
                if item.issym() or item.islnk():
                    target = (destination / item.name).parent / item.linkname
                    if not target.resolve().is_relative_to(destination.resolve()):
                        fail(f"Archive link escapes extraction root: {item.name}")
            source.extractall(destination)


def sole_directory(root):
    children = list(root.iterdir())
    if len(children) != 1 or not children[0].is_dir():
        fail(f"Expected one archive source directory under {root}")
    return children[0]


def verified_outputs(lib_path):
    if lib_path.name != "Release" or not lib_path.is_dir():
        fail(f"ORT Release directory is missing: {lib_path}")
    build_root = lib_path.parent
    deps_link = build_root / "_deps"
    if not deps_link.is_symlink() or deps_link.resolve() != (lib_path / "_deps").resolve():
        fail("ort-sys _deps link does not point to Release/_deps")
    required = [lib_path / f"libonnxruntime_{name}.a" for name in EXPECTED_ORT_LIBS]
    required.extend([
        lib_path / "_deps/onnx-build/libonnx.a",
        lib_path / "_deps/protobuf-build/libprotobuf-lite.a",
        lib_path / "_deps/re2-build/libre2.a",
    ])
    for path in required:
        if not path.is_file() or path.stat().st_size == 0:
            fail(f"Required ORT static library is missing: {path}")
    if any(lib_path.rglob("libonnxruntime*.dylib")):
        fail("Unexpected ONNX Runtime dynamic library in static build")
    settings = (lib_path / "CMakeCache.txt").read_text()
    for setting in (
        "CMAKE_OSX_ARCHITECTURES:STRING=arm64",
        "onnxruntime_BUILD_UNIT_TESTS:BOOL=OFF",
        "onnxruntime_BUILD_SHARED_LIB:BOOL=OFF",
        "onnxruntime_MINIMAL_BUILD:BOOL=OFF",
    ):
        if setting not in settings:
            fail(f"ORT build configuration is missing {setting}")
    libraries = sorted(lib_path.rglob("*.a"))
    if any(path.is_symlink() or not path.is_file() for path in libraries):
        fail("Static ORT build contains an unexpected library link")
    return {str(path.relative_to(build_root)): sha256(path) for path in libraries}


def run_build(stage, source, cmake, ninja, eigen):
    build_root = stage / "build"
    log = stage / "static-ort-build.log"
    flags = [
        "onnxruntime_BUILD_UNIT_TESTS=OFF", "onnxruntime_BUILD_SHARED_LIB=OFF",
        "onnxruntime_MINIMAL_BUILD=OFF", "CMAKE_OSX_ARCHITECTURES=arm64",
        f"Python_EXECUTABLE={sys.executable}", f"Python3_EXECUTABLE={sys.executable}",
        f"FETCHCONTENT_SOURCE_DIR_EIGEN={eigen}",
    ]
    args = [
        sys.executable, str(source / "tools/ci_build/build.py"),
        "--build_dir", str(build_root), "--config", "Release", "--update", "--build",
        "--skip_submodule_sync", "--skip_tests", "--parallel", "2",
        "--cmake_generator", "Ninja", "--cmake_path", str(cmake),
        "--cmake_extra_defines", *flags,
    ]
    env = dict(os.environ)
    env["PATH"] = f"{ninja.parent}{os.pathsep}{cmake.parent}{os.pathsep}{env.get('PATH', '')}"
    env["PYTHONUNBUFFERED"] = "1"
    with log.open("w") as output:
        process = subprocess.Popen(
            args, cwd=source, env=env, stdout=output, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        started = time.monotonic()
        try:
            while process.poll() is None:
                time.sleep(5)
                check_space(stage)
                if time.monotonic() - started > MAX_BUILD_SECONDS:
                    fail("Static ORT build exceeded one hour")
            if process.returncode:
                fail(f"Static ORT build failed (exit {process.returncode})")
        except BaseException as error:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            tail = log.read_text(errors="replace")[-3000:]
            fail(f"{error}; final build output:\n{tail}")
    with log.open("a") as output:
        re2 = subprocess.Popen(
            [str(cmake), "--build", str(build_root / "Release"), "--target", "re2", "--parallel", "2"],
            stdout=output, stderr=subprocess.STDOUT, start_new_session=True,
        )
        try:
            re2.wait(timeout=10 * 60)
        except subprocess.TimeoutExpired:
            os.killpg(re2.pid, signal.SIGTERM)
            try:
                re2.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(re2.pid, signal.SIGKILL)
                re2.wait()
            fail("Static ORT re2 dependency build timed out")
        if re2.returncode:
            fail(f"Static ORT re2 dependency build failed: {log.read_text(errors='replace')[-3000:]}")
    (build_root / "_deps").symlink_to("Release/_deps", target_is_directory=True)
    return build_root / "Release"


def prepare(stage, lock):
    downloads = stage / "downloads"
    downloads.mkdir()
    names = {
        "onnxruntime": "onnxruntime.tar.gz", "onnx": "onnx.tar.gz",
        "eigen": "eigen.zip", "cmake": "cmake.tar.gz",
        "ninja": "ninja.zip", "protoc": "protoc.zip",
    }
    for name, filename in names.items():
        download(lock["sources"][name], downloads / filename)
    sources = stage / "sources"
    sources.mkdir()
    for name in ("onnxruntime", "onnx", "eigen", "cmake"):
        extract(downloads / names[name], sources / name)
    ort = sole_directory(sources / "onnxruntime")
    onnx = sole_directory(sources / "onnx")
    eigen = sole_directory(sources / "eigen")
    cmake = sole_directory(sources / "cmake") / "CMake.app/Contents/bin/cmake"
    onnx_target = ort / "cmake/external/onnx"
    if onnx_target.exists():
        if not onnx_target.is_dir() or any(onnx_target.iterdir()):
            fail("ORT source archive unexpectedly contains the ONNX submodule")
        onnx_target.rmdir()
    onnx.rename(onnx_target)
    tools = stage / "tools"
    tools.mkdir()
    extract(downloads / names["ninja"], tools / "ninja")
    extract(downloads / names["protoc"], tools / "protoc")
    ninja = tools / "ninja/ninja"
    protoc = tools / "protoc/bin/protoc"
    for executable in (cmake, ninja, protoc):
        if not executable.is_file():
            fail(f"Pinned build tool missing: {executable}")
        executable.chmod(executable.stat().st_mode | 0o111)
    command([str(cmake), "--version"])
    command([str(ninja), "--version"])
    command([str(protoc), "--version"])
    lib_path = run_build(stage, ort, cmake, ninja, eigen)
    return lib_path, protoc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-lib-path", type=pathlib.Path,
                        help="read-only inspection of an existing static ORT link directory")
    args = parser.parse_args()
    if args.verify_lib_path:
        print(json.dumps({"libraries": verified_outputs(args.verify_lib_path.resolve())}, sort_keys=True))
        return
    identity = host_identity()
    lock = json.loads(LOCK.read_text())
    if lock["target"] != "aarch64-apple-darwin":
        fail("Static ORT lock target changed unexpectedly")
    fingerprint = hashlib.sha256(json.dumps({
        "lock": lock, "script_sha256": sha256(SCRIPT), "host": identity,
    }, sort_keys=True).encode()).hexdigest()[:24]
    cache_root = root_for_target()
    cache_root.mkdir(parents=True, exist_ok=True)
    guard = (cache_root / f".ort-{fingerprint}.lock").open("a+b")
    try:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fail("Another process is preparing the same static ORT cache; retry after it finishes")
    complete = cache_root / f"ort-{fingerprint}"
    marker = complete / "complete.json"
    if complete.exists():
        if not marker.is_file():
            fail(f"Incomplete static ORT cache; refusing to adopt: {complete}")
        recorded = json.loads(marker.read_text())
        if recorded.get("fingerprint") != fingerprint:
            fail("Static ORT cache fingerprint mismatch")
        outputs = verified_outputs(complete / "build/Release")
        if outputs != recorded.get("libraries"):
            fail("Static ORT cache output digest mismatch")
        for name, digest in recorded.get("archives", {}).items():
            if name not in lock["sources"] or digest != lock["sources"][name]["sha256"]:
                fail("Static ORT cache archive manifest mismatch")
            archive = complete / "downloads" / {
                "onnxruntime": "onnxruntime.tar.gz", "onnx": "onnx.tar.gz",
                "eigen": "eigen.zip", "cmake": "cmake.tar.gz",
                "ninja": "ninja.zip", "protoc": "protoc.zip",
            }[name]
            if not archive.is_file() or sha256(archive) != digest:
                fail(f"Static ORT cache archive digest mismatch: {name}")
        if set(recorded.get("archives", {})) != set(lock["sources"]):
            fail("Static ORT cache archive manifest is incomplete")
        protoc = complete / "tools/protoc/bin/protoc"
        if not protoc.is_file() or sha256(protoc) != recorded.get("protoc_sha256"):
            fail("Static ORT cache protoc mismatch")
    else:
        check_space(cache_root)
        stage = cache_root / f".ort-{fingerprint}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        stage.mkdir()
        try:
            lib_path, protoc = prepare(stage, lock)
            outputs = verified_outputs(lib_path)
            record = {
                "fingerprint": fingerprint, "host": identity,
                "lock_sha256": sha256(LOCK), "libraries": outputs,
                "archives": {name: spec["sha256"] for name, spec in lock["sources"].items()},
                "protoc_sha256": sha256(protoc),
            }
            (stage / "complete.json").write_text(json.dumps(record, sort_keys=True, indent=2) + "\n")
            stage.rename(complete)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    print(json.dumps({
        "ort_lib_path": str(complete / "build/Release"),
        "protoc": str(complete / "tools/protoc/bin/protoc"),
        "fingerprint": fingerprint,
    }, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"static ORT preparation failed: {error}", file=sys.stderr)
        sys.exit(1)
