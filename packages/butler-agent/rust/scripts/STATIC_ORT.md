# Static ONNX Runtime and protoc recipe

`prepare-static-ort.py` prepares the pinned static ONNX Runtime (ORT) link cache and the pinned `protoc` for one native target. The build is always native: `--target` defaults to the host and must match it.

| Target | Rust host triple | Host requirements | CI coverage |
| --- | --- | --- | --- |
| `macos-arm64` | `aarch64-apple-darwin` | macOS system `/usr/bin/curl`, Xcode command-line tools (`xcrun`/clang) | official prebuilt ORT for CI; custom static build for releases |
| `linux-x64` | `x86_64-unknown-linux-gnu` | `/usr/bin/curl`, a C/C++ compiler (`CC`/`CXX`, default `cc`/`c++`) | official prebuilt ORT for CI; custom static build for packages |
| `linux-arm64` | `aarch64-unknown-linux-gnu` | as `linux-x64` | official prebuilt ORT for nightly CI; custom static build for packages |
| `windows-x64` | `x86_64-pc-windows-msvc` | `%SystemRoot%\System32\curl.exe`, Visual Studio with the x64 C++ tools; the full build runs in an x64 developer environment (`cl.exe` on `PATH`) with symlink rights and a short `CARGO_TARGET_DIR` | official prebuilt ORT for the compile check; no Windows release package |

The custom static recipe needs Python 3.9+, Rust 1.91.0 and more than 8 GiB free. CMake, Ninja and protoc come from pinned archives; they do not need a global installation. The script rejects other hosts and caps downloads, archive expansion, build time, parallel jobs and disk use. The `ort` crate's official prebuilt binaries cover all four CI targets; its Windows archive includes DirectML, and that job only type-checks without linking or running the agent.

`packages/butler-app/client/electron/scripts/prepare-native-agent.mjs` is the native payload producer for macOS arm64 and Linux x64/arm64. It invokes the recipe with the matching `--target` (`macos-arm64`, `linux-x64`, `linux-arm64`), then passes the returned `ORT_LIB_PATH` and `PROTOC` to a release build that selects `--no-default-features --features static-ort`. Linux package builds use that mode on release tags and use prebuilt ORT for PR smoke checks. CI/dev builds select the default `prebuilt-ort` feature; downloaded artifacts are cached through `ORT_CACHE_DIR` in the Rust cache. Setup still uses `--protoc-only` where Lance build scripts need it and never compiles ORT from source.

## Pinned inputs

`static-ort.lock.json` holds every input URL, revision, archive SHA-256 digest and digest provenance. `sources` (ORT, ONNX, Eigen) are shared by all targets; each `targets` entry pins that target's CMake, Ninja and protoc archives and its build settings (Linux and Windows build with 4 parallel jobs, macOS with 2). The ORT and ONNX digests were measured from official GitHub commit tarballs. CMake digests match Kitware's published `cmake-3.31.10-SHA-256.txt` and release API digests. The Linux and Windows protoc digests match the protobuf release API digests; the macOS protoc and all Ninja digests were measured from official release assets. ORT pins an Eigen archive SHA-1 whose current official GitLab archive bytes differ. The recipe verifies the currently observed official commit archive SHA-256 and passes its extracted source through `FETCHCONTENT_SOURCE_DIR_EIGEN`. This preserves the commit, but does not claim the archive bytes match ORT's pinned SHA-1.

Linux and Windows builds pass `--compile_no_warning_as_error`: the pinned ORT predates the runners' compilers, whose new warnings would otherwise fail the build. Linux builds also compile C++ with `-include cstdint`, because GCC 15's libstdc++ no longer includes `<cstdint>` transitively and the pinned ORT relies on it (GCC 13 on the CI runners is unaffected). Off Apple, ORT always builds its loader for shared execution providers (`libonnxruntime_providers_shared.so`, `onnxruntime_providers_shared.dll`); the static CPU build neither links nor loads it, so it is the one dynamic library the output check allows. Windows sources nest past `MAX_PATH`: the recipe extracts through extended-length paths and uses short staging names, and the cache root (`CARGO_TARGET_DIR`) must be short (the CI runner's `D:\a\_temp\ort-cache` is). The macOS build arguments are unchanged.

## Cache

The custom static cache lives under `${CARGO_TARGET_DIR:-packages/butler-agent/rust/target}/native-deps/`, outside the packaged application. Its key (`--fingerprint`) covers the recipe, the target's projection of the lock (shared sources plus that target's tools and build settings, so pinning another target's tool does not invalidate it), the Python/Rust toolchain and the host build identity: macOS SDK and clang; Linux distribution, libc and C/C++ compiler; Windows version and MSVC toolset. A cache is adopted only with a matching completion manifest, archive digests, all static-library digests, the configured static/nonminimal build (and arm64 on macOS), the `ort-sys` dependency layout and no ORT dynamic library. Incomplete or changed caches fail closed. The build stage is renamed after completion; its `_deps` link is relative, and Cargo consumes the final libraries and protoc path. The retained CMake cache is not reused for incremental rebuilding. The producer forces static linking and checks the dependency closure before copying a payload: Mach-O on macOS, ELF `NEEDED` entries on Linux (glibc, libgcc and libstdc++ only). It never copies an ORT shared library. `packages/butler-app/scripts/release/package-linux-app.ts` bundles the Linux payload into the DEB and Arch App packages (`.github/workflows/linux-packages.yml`).

`--fingerprint` prints the static cache key without preparing anything, so a release cache keyed by it is reused exactly when the script would reuse the cache. `--protoc-only` prepares just the pinned protoc under the same root; CI/dev builds use that mode and let `ort` download its official prebuilt binary rather than running the custom ORT build.

Run the existing producer on a macOS arm64 build host:

```sh
node packages/butler-app/client/electron/scripts/prepare-native-agent.mjs darwin arm64 /path/to/output/bundled-agent
```

Prepare a Linux or Windows cache directly (prints `ort_lib_path`, `protoc` and `fingerprint` as JSON):

```sh
python3 packages/butler-agent/rust/scripts/prepare-static-ort.py              # host target, full build
python3 packages/butler-agent/rust/scripts/prepare-static-ort.py --protoc-only
```

The previously isolated static ORT 1.21.0 build and API-21 link probe established the recipe inputs. A clean build through this repository-owned recipe and a full release package remain unverified until the combined release check.
