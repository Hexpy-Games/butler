#!/usr/bin/env python3
"""Prepare the pinned static ONNX Runtime link cache and protoc for one native target."""

import argparse
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

import static_ort_host as host
import static_ort_prebuilt as prebuilt


SCRIPT = pathlib.Path(__file__).resolve()
RUST_ROOT = SCRIPT.parent.parent
LOCK = SCRIPT.with_name("static-ort.lock.json")
EXPECTED_ORT_LIBS = (
    "common", "flatbuffers", "framework", "graph", "lora", "mlas",
    "optimizer", "providers", "session", "util",
)
MIN_FREE_BYTES = 8 * 1024**3
MAX_BUILD_SECONDS = 60 * 60
MAX_DOWNLOAD_SECONDS = 20 * 60
MAX_ARCHIVE_BYTES = 512 * 1024**2

from static_ort_targets import TARGETS
from static_ort_host import command, fail, sha256


def archive_names(target):
    return {
        "onnxruntime": "onnxruntime.tar.gz", "onnx": "onnx.tar.gz",
        "eigen": "eigen.zip", "cmake": TARGETS[target]["cmake_archive"],
        "ninja": "ninja.zip", "protoc": "protoc.zip",
    }


def host_target():
    for name, spec in TARGETS.items():
        system, machines = spec["host"]
        if sys.platform == system and platform.machine() in machines:
            return name
    fail("Static ONNX Runtime preparation supports only macOS arm64, Linux x64/arm64 "
         "and Windows x64 hosts.")


def target_lock(lock, target):
    """The lock inputs of one target: shared sources plus that target's tools and build."""
    if lock.get("schema") != "butler.static-ort.v2":
        fail("Static ORT lock schema changed unexpectedly")
    entry = lock["targets"].get(target)
    if entry is None:
        fail(f"Static ORT lock has no target {target}")
    if set(lock["sources"]) & set(entry["tools"]):
        fail("Static ORT lock tool names collide with source names")
    return {
        "schema": lock["schema"],
        "target": target,
        "rust_target": entry["rust_target"],
        "ort_api": lock["ort_api"],
        "ort_sys": lock["ort_sys"],
        "sources": {**lock["sources"], **entry["tools"]},
        "build": entry["build"],
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


def lock_exclusive(stream):
    """A non-blocking exclusive lock held until the process exits."""
    if os.name == "nt":
        import msvcrt
        busy = OSError
    else:
        import fcntl
        busy = BlockingIOError
    try:
        if os.name == "nt":
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except busy:
        fail("Another process is preparing the same static ORT cache; retry after it finishes")


def terminate_group(process):
    """Stops a build started in its own process group (or, on Windows, its process tree)."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(process.pid)],
                       capture_output=True, check=False)
        process.wait()
        return
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def download(spec, destination, target):
    if destination.is_file() and sha256(destination) == spec["sha256"]:
        return
    if destination.exists():
        fail(f"Unverified download already exists: {destination}")
    if shutil.disk_usage(destination.parent).free <= MIN_FREE_BYTES + MAX_ARCHIVE_BYTES:
        fail("Insufficient free space to download pinned build source")
    temporary = destination.with_name(destination.name + ".part")
    try:
        curl = pathlib.Path(TARGETS[target]["curl"])
        if not curl.is_file():
            fail(f"System curl ({curl}) is required for pinned archive download")
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


def native_path(path):
    """The path for bulk file operations: on Windows its extended-length form,
    because archive members (ONNX test data) nest past MAX_PATH."""
    if os.name != "nt":
        return path
    return pathlib.Path("\\\\?\\" + str(path.resolve()))


def stage_name(kind, fingerprint):
    """A unique staging directory name; short on Windows to keep build paths under MAX_PATH."""
    if os.name == "nt":
        return f".{kind[0]}{uuid.uuid4().hex[:8]}.tmp"
    return f".{kind}{fingerprint}.{os.getpid()}.{uuid.uuid4().hex}.tmp"


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
            source.extractall(native_path(destination))
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
            source.extractall(native_path(destination))


def sole_directory(root):
    children = list(root.iterdir())
    if len(children) != 1 or not children[0].is_dir():
        fail(f"Expected one archive source directory under {root}")
    return children[0]


def verified_outputs(lib_path, target):
    spec = TARGETS[target]
    if lib_path.name != "Release" or not lib_path.is_dir():
        fail(f"ORT Release directory is missing: {lib_path}")
    build_root = lib_path.parent
    deps_link = build_root / "_deps"
    if not deps_link.is_symlink() or deps_link.resolve() != (lib_path / "_deps").resolve():
        fail("ort-sys _deps link does not point to Release/_deps")
    required = [lib_path / spec["static_lib"].format(f"onnxruntime_{name}") for name in EXPECTED_ORT_LIBS]
    required.extend(lib_path / dep for dep in spec["deps"])
    for path in required:
        if not path.is_file() or path.stat().st_size == 0:
            fail(f"Required ORT static library is missing: {path}")
    dynamic = sorted({path.name for path in lib_path.rglob(spec["dynamic_glob"])}
                     - set(spec["dynamic_allowed"]))
    if dynamic:
        fail(f"Unexpected ONNX Runtime dynamic library in static build: {', '.join(dynamic)}")
    settings = (lib_path / "CMakeCache.txt").read_text()
    for setting in (
        *spec["cmake_cache"],
        "onnxruntime_BUILD_UNIT_TESTS:BOOL=OFF",
        "onnxruntime_BUILD_SHARED_LIB:BOOL=OFF",
        "onnxruntime_MINIMAL_BUILD:BOOL=OFF",
    ):
        if setting not in settings:
            fail(f"ORT build configuration is missing {setting}")
    libraries = sorted(lib_path.rglob(spec["static_glob"]))
    if any(path.is_symlink() or not path.is_file() for path in libraries):
        fail("Static ORT build contains an unexpected library link")
    return {pathlib.PurePath(path.relative_to(build_root)).as_posix(): sha256(path) for path in libraries}


def run_build(stage, source, cmake, ninja, eigen, target, lock):
    spec = TARGETS[target]
    if target == "windows-x64" and not shutil.which("cl"):
        fail("The windows-x64 static ORT build must run in a Visual Studio x64 developer environment")
    parallel = str(lock["build"]["parallel_jobs"])
    build_root = stage / "build"
    log = stage / "static-ort-build.log"
    flags = [
        "onnxruntime_BUILD_UNIT_TESTS=OFF", "onnxruntime_BUILD_SHARED_LIB=OFF",
        "onnxruntime_MINIMAL_BUILD=OFF", *spec["cmake_defines"],
        f"Python_EXECUTABLE={sys.executable}", f"Python3_EXECUTABLE={sys.executable}",
        f"FETCHCONTENT_SOURCE_DIR_EIGEN={eigen}",
    ]
    args = [
        sys.executable, str(source / "tools/ci_build/build.py"),
        "--build_dir", str(build_root), "--config", "Release", "--update", "--build",
        "--skip_submodule_sync", "--skip_tests", "--parallel", parallel,
        *spec["build_args"],
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
                terminate_group(process)
            tail = log.read_text(errors="replace")[-3000:]
            fail(f"{error}; final build output:\n{tail}")
    with log.open("a") as output:
        re2 = subprocess.Popen(
            [str(cmake), "--build", str(build_root / "Release"), "--target", "re2", "--parallel", parallel],
            stdout=output, stderr=subprocess.STDOUT, start_new_session=True,
        )
        try:
            re2.wait(timeout=10 * 60)
        except subprocess.TimeoutExpired:
            terminate_group(re2)
            fail("Static ORT re2 dependency build timed out")
        if re2.returncode:
            fail(f"Static ORT re2 dependency build failed: {log.read_text(errors='replace')[-3000:]}")
    (build_root / "_deps").symlink_to("Release/_deps", target_is_directory=True)
    return build_root / "Release"


def prepare(stage, lock, target):
    spec = TARGETS[target]
    downloads = stage / "downloads"
    downloads.mkdir()
    names = archive_names(target)
    for name, filename in names.items():
        download(lock["sources"][name], downloads / filename, target)
    sources = stage / "sources"
    sources.mkdir()
    for name in ("onnxruntime", "onnx", "eigen", "cmake"):
        extract(downloads / names[name], sources / name)
    ort = sole_directory(sources / "onnxruntime")
    onnx = sole_directory(sources / "onnx")
    eigen = sole_directory(sources / "eigen")
    cmake = sole_directory(sources / "cmake") / spec["cmake"]
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
    ninja = tools / f"ninja/ninja{spec['exe']}"
    protoc = tools / f"protoc/bin/protoc{spec['exe']}"
    for executable in (cmake, ninja, protoc):
        if not executable.is_file():
            fail(f"Pinned build tool missing: {executable}")
        executable.chmod(executable.stat().st_mode | 0o111)
    command([str(cmake), "--version"])
    command([str(ninja), "--version"])
    command([str(protoc), "--version"])
    lib_path = run_build(stage, ort, cmake, ninja, eigen, target, lock)
    return lib_path, protoc


def prepare_protoc(cache_root, lock, target):
    """Download and verify only the pinned protoc; ORT itself is needed only to link."""
    spec = lock["sources"]["protoc"]
    executable = f"bin/protoc{TARGETS[target]['exe']}"
    complete = cache_root / f"protoc-{spec['sha256'][:24]}"
    protoc = complete / executable
    if protoc.is_file():
        return protoc
    stage = cache_root / stage_name("protoc", "")
    stage.mkdir()
    try:
        download(spec, stage / "protoc.zip", target)
        extract(stage / "protoc.zip", stage / "protoc")
        staged = stage / "protoc" / executable
        if not staged.is_file():
            fail(f"Pinned build tool missing: {staged}")
        staged.chmod(staged.stat().st_mode | 0o111)
        command([str(staged), "--version"])
        (stage / "protoc").rename(complete)
    finally:
        if stage.exists():
            shutil.rmtree(native_path(stage))
    return protoc


def adopt(complete, fingerprint, lock, target):
    """Verifies a completed cache before reuse; any difference fails closed."""
    marker = complete / "complete.json"
    if not marker.is_file():
        fail(f"Incomplete static ORT cache; refusing to adopt: {complete}")
    recorded = json.loads(marker.read_text())
    if recorded.get("lock_sha256") != hashlib.sha256(
            json.dumps(lock, sort_keys=True).encode()).hexdigest() or recorded.get("target") != target:
        fail("Static ORT cache pinned input mismatch")
    if recorded.get("fingerprint") != fingerprint:
        fail("Static ORT cache fingerprint mismatch")
    outputs = verified_outputs(complete / "build/Release", target)
    if outputs != recorded.get("libraries"):
        fail("Static ORT cache output digest mismatch")
    names = archive_names(target)
    for name, digest in recorded.get("archives", {}).items():
        if name not in lock["sources"] or digest != lock["sources"][name]["sha256"]:
            fail("Static ORT cache archive manifest mismatch")
        archive = complete / "downloads" / names[name]
        if not archive.is_file() or sha256(archive) != digest:
            fail(f"Static ORT cache archive digest mismatch: {name}")
    if set(recorded.get("archives", {})) != set(lock["sources"]):
        fail("Static ORT cache archive manifest is incomplete")
    protoc = complete / f"tools/protoc/bin/protoc{TARGETS[target]['exe']}"
    if not protoc.is_file() or sha256(protoc) != recorded.get("protoc_sha256"):
        fail("Static ORT cache protoc mismatch")


def prepare_cache(cache_root, fingerprint, lock, target, build_only, require_prebuilt):
    with (cache_root / f".ort-{fingerprint}.lock").open("a+b") as guard:
        lock_exclusive(guard)
        complete = cache_root / f"ort-{fingerprint}"
        if complete.exists():
            adopt(complete, fingerprint, lock, target)
        else:
            restored = False if build_only else prebuilt.restore(
                cache_root, fingerprint, lock, target, adopt)
            if restored:
                return complete
            if require_prebuilt:
                fail("Pinned native asset is absent; dispatch native-deps.yml before this CI job")
            identity = host.host_identity(target, lock["rust_target"])
            check_space(cache_root)
            stage = cache_root / stage_name("ort-", fingerprint)
            stage.mkdir()
            try:
                lib_path, protoc = prepare(stage, lock, target)
                outputs = verified_outputs(lib_path, target)
                record = {
                    "fingerprint": fingerprint, "host": identity, "target": target,
                    "lock_sha256": hashlib.sha256(json.dumps(lock, sort_keys=True).encode()).hexdigest(),
                    "libraries": outputs,
                    "archives": {name: spec["sha256"] for name, spec in lock["sources"].items()},
                    "protoc_sha256": sha256(protoc),
                }
                (stage / "complete.json").write_text(json.dumps(record, sort_keys=True, indent=2) + "\n")
                stage.rename(complete)
            finally:
                if stage.exists():
                    shutil.rmtree(native_path(stage))
        return complete


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=sorted(TARGETS),
                        help="native target to prepare (default: this host); must match the host")
    parser.add_argument("--verify-lib-path", type=pathlib.Path,
                        help="read-only inspection of an existing static ORT link directory")
    parser.add_argument("--fingerprint", action="store_true",
                        help="print the cache fingerprint without preparing anything")
    parser.add_argument("--build-only", action="store_true", help="producer: build without downloading")
    parser.add_argument("--require-prebuilt", action="store_true", help="fail if no published asset exists")
    parser.add_argument("--protoc-only", action="store_true",
                        help="prepare only the pinned protoc (enough for cargo check/clippy)")
    args = parser.parse_args()
    target = args.target or host_target()
    if target != host_target():
        fail(f"Static ORT preparation for {target} must run on a {target} host")
    if args.verify_lib_path:
        print(json.dumps({"libraries": verified_outputs(args.verify_lib_path.resolve(), target)},
                         sort_keys=True))
        return
    lock = target_lock(json.loads(LOCK.read_text()), target)
    fingerprint = prebuilt.key(SCRIPT, lock, target)
    if args.fingerprint:
        print(fingerprint)
        return
    host.rust_identity(lock["rust_target"])
    cache_root = root_for_target()
    cache_root.mkdir(parents=True, exist_ok=True)
    if args.protoc_only:
        print(json.dumps({"protoc": str(prepare_protoc(cache_root, lock, target))}, sort_keys=True))
        return
    complete = prepare_cache(cache_root, fingerprint, lock, target, args.build_only, args.require_prebuilt or (os.environ.get("GITHUB_ACTIONS") == "true" and not args.build_only))
    print(json.dumps({
        "ort_lib_path": str(complete / "build/Release"),
        "protoc": str(complete / f"tools/protoc/bin/protoc{TARGETS[target]['exe']}"),
        "fingerprint": fingerprint,
    }, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"static ORT preparation failed: {error}", file=sys.stderr)
        sys.exit(1)
