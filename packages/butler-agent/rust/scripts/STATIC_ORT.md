# macOS arm64 static ONNX Runtime producer

`packages/butler-app/client/electron/scripts/prepare-native-agent.mjs` is the native payload producer. On a macOS arm64 host it invokes `prepare-static-ort-macos-arm64.py`, then passes the returned `ORT_LIB_PATH` and `PROTOC` directly to `cargo build --release --locked -p butler-agent`. CMake, Ninja and protoc come from the pinned archives; they do not need a global installation. The host must provide Python 3.9+, macOS system `/usr/bin/curl`, Xcode command-line tools (`xcrun`/clang), Rust 1.91.0 and enough free space. The script rejects other hosts and caps downloads, archive expansion, build time, parallel jobs and disk use.

The input URLs, revisions, archive SHA-256 digests and digest provenance are in `static-ort-macos-arm64.lock.json`. The ORT and ONNX digests were measured from official GitHub commit tarballs; Ninja and protoc digests were measured from official release assets. Only the CMake digest was also matched to an upstream release API digest. ORT pins an Eigen archive SHA-1 whose current official GitLab archive bytes differ. The recipe verifies the currently observed official commit archive SHA-256 and passes its extracted source through `FETCHCONTENT_SOURCE_DIR_EIGEN`. This preserves the commit, but does not claim the archive bytes match ORT's pinned SHA-1.

The cache lives under `${CARGO_TARGET_DIR:-packages/butler-agent/rust/target}/native-deps/`, outside the packaged application. Its key includes the recipe, lock, Python/Rust toolchain, macOS SDK and clang identity. A cache is adopted only with a matching completion manifest, archive digests, all static-library digests, the configured arm64/static/nonminimal build, the `ort-sys` dependency layout and no ORT dylib. Incomplete or changed caches fail closed. The build stage is renamed after completion; its `_deps` link is relative, and Cargo consumes the final libraries and protoc path. The retained CMake cache is not reused for incremental rebuilding. The producer forces static linking and keeps its Mach-O dependency closure check before copying a payload; it never copies an ORT dylib.

Run the existing producer on a macOS arm64 build host:

```sh
node packages/butler-app/client/electron/scripts/prepare-native-agent.mjs darwin arm64 /path/to/output/bundled-agent
```

The previously isolated static ORT 1.21.0 build and API-21 link probe established the recipe inputs. A clean build through this repository-owned recipe and a full release package remain unverified until the combined release check.
