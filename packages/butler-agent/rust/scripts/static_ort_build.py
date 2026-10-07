"""Byte-producing static ORT build recipe; placement and verification live separately."""
import os
import shutil
import signal
import subprocess
import sys
import time

from static_ort_host import fail
from static_ort_targets import TARGETS

MIN_FREE_BYTES = 8 * 1024**3
MAX_BUILD_SECONDS = 60 * 60


def check_space(root):
    if shutil.disk_usage(root).free <= MIN_FREE_BYTES:
        fail("Static ORT build requires more than 8 GiB free in its target cache volume.")


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
    return build_root / "Release"
