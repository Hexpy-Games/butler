"""Native target build flags and layouts shared by producers and consumers."""
import os
import pathlib

# Everything that differs between native targets. The pinned inputs live in
# the lock's `targets` entry of the same name. Builds are native only: the host
# must be the target and the pinned Rust toolchain's host triple its
# `rust_target`.
UNIX_DEPS = (
    "_deps/onnx-build/libonnx.a",
    "_deps/protobuf-build/libprotobuf-lite.a",
    "_deps/re2-build/libre2.a",
)
LINUX = {
    "curl": "/usr/bin/curl",
    "cmake": "bin/cmake",
    "cmake_archive": "cmake.tar.gz",
    "exe": "",
    "static_lib": "lib{}.a",
    "static_glob": "*.a",
    "dynamic_glob": "libonnxruntime*.so*",
    # ORT always builds this loader for shared execution providers off Apple;
    # the static CPU build neither links nor loads it.
    "dynamic_allowed": ("libonnxruntime_providers_shared.so",),
    "deps": UNIX_DEPS,
    # GCC 15's libstdc++ no longer includes <cstdint> transitively, which the
    # pinned ORT relies on; older compilers are unaffected.
    "cmake_defines": ("CMAKE_CXX_FLAGS=-include cstdint",),
    "cmake_cache": (),
    # The pinned ORT predates the host GCC; its new warnings must not fail the build.
    "build_args": ("--compile_no_warning_as_error",),
}
TARGETS = {
    "macos-arm64": {
        "host": ("darwin", ("arm64",)),
        "curl": "/usr/bin/curl",
        "cmake": "CMake.app/Contents/bin/cmake",
        "cmake_archive": "cmake.tar.gz",
        "exe": "",
        "static_lib": "lib{}.a",
        "static_glob": "*.a",
        "dynamic_glob": "libonnxruntime*.dylib",
        "dynamic_allowed": (),
        "deps": UNIX_DEPS,
        "cmake_defines": ("CMAKE_OSX_ARCHITECTURES=arm64",),
        "cmake_cache": ("CMAKE_OSX_ARCHITECTURES:STRING=arm64",),
        "build_args": (),
    },
    "linux-x64": {**LINUX, "host": ("linux", ("x86_64",))},
    "linux-arm64": {**LINUX, "host": ("linux", ("aarch64", "arm64"))},
    # The full build must run inside a Visual
    # Studio x64 developer environment (cl.exe on PATH) with symlink rights,
    # under a short CARGO_TARGET_DIR (MAX_PATH).
    "windows-x64": {
        "host": ("win32", ("AMD64", "x86_64")),
        "curl": str(pathlib.Path(os.environ.get("SystemRoot", "C:\\Windows")) / "System32" / "curl.exe"),
        "cmake": "bin/cmake.exe",
        "cmake_archive": "cmake.zip",
        "exe": ".exe",
        "static_lib": "{}.lib",
        "static_glob": "*.lib",
        "dynamic_glob": "onnxruntime*.dll",
        "dynamic_allowed": ("onnxruntime_providers_shared.dll",),
        "deps": (
            "_deps/onnx-build/onnx.lib",
            "_deps/protobuf-build/libprotobuf-lite.lib",
            "_deps/re2-build/re2.lib",
        ),
        "cmake_defines": (),
        "cmake_cache": (),
        "build_args": ("--compile_no_warning_as_error", "--enable_msvc_static_runtime"),
    },
}

