# Release notices

`node deploy/licenses/generate.mjs` generates the single offline distribution
notice document from locked, reviewed evidence in `catalog.json`. No timestamps,
host paths, network requests, or package-manager installs enter generation.
Full texts are indexed by SHA-256 and included once in the appendix; every
component retains its own attribution, upstream file labels and references.

## Inventory

848 top-level components: 609 Rust packages, 228 npm packages, five native
components, four vendored components, one model, and one Electron supplier
collection. The latter preserves all 746 supplier credits from each of three
runtime distributions (2,238 entries, with shared full texts deduplicated).
The union is intentionally conservative: Cargo normal edges include proc-macro
packages; the renderer production closure includes modules removed by tree
shaking. Build-only Cargo edges, test dependencies, Vite/TypeScript tooling,
Electron downloader/packager dependencies, and the website are excluded.

- Rust: `cargo metadata --locked` plus the normal dependency closure for
  `butler-agent --no-default-features --features static-ort` on macOS arm64,
  Linux x64 and Linux arm64, as recorded per component in the catalog.
- Renderer: production dependencies and required peers resolved from `bun.lock`,
  including nested and scoped resolutions. `verify-renderer.mjs` verifies the
  installed graph during the Vite build. Release workflows use Bun's lockfile;
  legacy npm lockfiles currently select different versions and must not override it.
- Electron main/preload and the npm installer use Node/Electron built-ins and
  local modules. Electron embeds Node; the npm wrapper requires the user's Node
  and does not bundle it. Electron 41.10.4's complete Linux x64, Linux arm64 and
  macOS arm64 `LICENSES.chromium.html` credits are collected from official ZIPs,
  verified against the installed Electron package's release checksums. Original
  `LICENSE` and `LICENSES.chromium.html` also remain in the packaged runtime.
  This collection covers Chromium, Node and separately bundled native libraries.
- Native Agent: static ONNX Runtime and its complete upstream ThirdPartyNotices,
  pinned ONNX and Eigen sources from `static-ort.lock.json`; SQLite 3.50.2 via
  `libsqlite3-sys` (including its public-domain blessing); Rust 1.91.0 standard
  library. Existing native payload gates reject non-system dynamic libraries.
- Fonts/icons/vendored: Pretendard 1.3.9, IBM Plex Mono 2.5.0 (OFL), Hugeicons
  free icons (MIT), LobeHub provider logos (MIT plus trademark notice), adapted
  JavaScriptCore/V8 Date.parse (BSD-2-Clause), ICU 78.1 / TZ 2026c data (Unicode).
- Model: Xenova/bge-m3, based on BAAI/bge-m3, MIT. Weights are not in the
  artifacts; the runtime reads its model cache. The inventory preserves the
  model card at revision `4de13258303883538bd53b696b452bf8099f0858` and the
  upstream FlagEmbedding MIT license. User-selected local models are not shipped.

## License policy and owner review

General allowlist: MIT, MIT-0, Apache-2.0, Apache-2.0 WITH LLVM-exception,
BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense, CC0-1.0, Unicode-3.0,
Unicode-DFS-2016, Zlib, zlib-acknowledgement, BSL-1.0, OFL-1.1, blessing.
SPDX AND requires every operand; OR permits an allowed alternative.
Legacy Cargo slash-separated alternatives are normalized to SPDX OR.
Missing/unknown licenses and new licenses outside this list fail generation/CI.

**Review before stable:** six explicit, version-scoped MPL-2.0 exceptions:
cssparser 0.37.0, cssparser-macros 0.7.1, dtoa-short 0.3.5, selectors 0.38.0,
option-ext 0.2.0 and Eigen at 1d8b82b0740839c0de7f1242a3585e3390ff5f33.
These exceptions disclose existing components; they do not constitute legal
approval. Assess source-availability obligations and distribution of modifications.
New MPL/GPL/LGPL/AGPL dependencies fail unless a permissive OR alternative exists.

Electron's known, version-pinned supplier collection uses the explicit
`LicenseRef-Electron-ThirdParty` exception; it contains custom grants and MPL /
LGPL / GPL references. ONNX Runtime's broad upstream notices also include optional
backends. Supplier credits are reproduced in full, not individually reclassified
or silently covered by the general allowlist. Review which copyleft portions are
actually linked and their source obligations before stable. Supplier credits do
not consistently expose individual dependency versions/SPDX metadata.

Some published packages omit notice files. The catalog preserves repository
licenses from sibling packages (same project), or pinned upstream source files,
and labels those sources explicitly. `random_word` excludes word-list licenses:
we include its English ENABLE public-domain dedication and upstream MIT declaration
with the complete SPDX MIT text (upstream supplies no copyright line).
`htmlescape` omits full texts: we elect its declared Apache-2.0 alternative and
include the complete license and original package declaration. Hugeicons' official
repository explicitly licenses free icons under MIT; its published README's
“All rights reserved” footer is not used as a license grant. These evidence gaps
and the unpinned runtime model cache require owner review.

## Refresh and validation

Use Python 3.11+, Node and the existing pinned Cargo toolchain. No additional
license tool is installed. After a dependency, feature, model identity, vendored
notice or static-ORT recipe change:

```sh
export CARGO_HOME="$HOME/.cargo" RUSTUP_HOME="$HOME/.rustup"
export HOME=$(mktemp -d) BUTLER_DATA=$(mktemp -d)
bun install --frozen-lockfile --ignore-scripts
# Install Electron's runtime for source inspection if scripts were ignored.
node packages/butler-app/client/electron/node_modules/electron/install.js
python3 deploy/licenses/refresh.py
node deploy/licenses/generate.mjs
node deploy/licenses/check.mjs
```

Review every evidence/license change. `refresh.py` uses the network only to obtain
missing upstream license texts and checksum-verified runtime credit lists.
`BUTLER_LICENSE_CACHE` optionally sets the ZIP cache (default: temp directory).
Generation checks recorded lockfiles/manifests and evidence hashes; a changed
input fails closed until the catalog is reviewed/refreshed. npm's publication
version stamp is excluded from its manifest fingerprint; dependencies are guarded.
CI runs `generate.mjs --check` and the deterministic/unknown-license fixtures.
UI smoke: `bun tests/smoke/open-source-licenses-smoke.ts` against a renderer build.

## Artifact locations

| Artifact | Notices file |
| --- | --- |
| macOS App | `Contents/Resources/app-client/THIRD_PARTY_NOTICES.txt`, `Contents/Resources/bundled-agent/bin/THIRD_PARTY_NOTICES.txt`, and `bundled-agent/resources/app-client/dist/THIRD_PARTY_NOTICES.txt` |
| Linux DEB/Arch App | `/opt/butler/Butler-linux-{x64,arm64}/resources/app-client/THIRD_PARTY_NOTICES.txt`, `resources/bundled-agent/bin/THIRD_PARTY_NOTICES.txt` and `resources/bundled-agent/resources/app-client/dist/THIRD_PARTY_NOTICES.txt` |
| Agent archive | `THIRD_PARTY_NOTICES.txt` next to `butler-agent` / `butler`, also `resources/app-client/dist/THIRD_PARTY_NOTICES.txt` |
| npm installer package | `THIRD_PARTY_NOTICES.txt` at package root; downloaded Agent archive retains the file next to its binary |
| Browser/remote App | same-origin `THIRD_PARTY_NOTICES.txt` next to the renderer's `index.html` |

The UI opens Settings → About → Open source licenses (설정 → 정보 → 오픈소스
라이선스), reads only that local static file on demand, searches component names,
and supplier labels, and expands complete license texts on demand. No new CLI command or version text.

## Counts by declared SPDX expression

The Electron supplier collection is one entry; its individual grants are preserved
in full rather than counted as inferred SPDX IDs.

| License expression | Components |
| --- | ---: |
| (Apache-2.0 OR MIT) AND BSD-3-Clause | 1 |
| (MIT OR Apache-2.0) AND Apache-2.0 | 1 |
| (MIT OR Apache-2.0) AND Unicode-3.0 | 1 |
| 0BSD | 2 |
| 0BSD OR MIT OR Apache-2.0 | 1 |
| Apache-2.0 | 83 |
| Apache-2.0 AND ISC | 1 |
| Apache-2.0 OR BSL-1.0 | 2 |
| Apache-2.0 OR ISC OR MIT | 3 |
| Apache-2.0 OR MIT | 38 |
| Apache-2.0 OR MIT OR Zlib | 2 |
| Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | 4 |
| BSD-2-Clause | 2 |
| BSD-2-Clause OR Apache-2.0 OR MIT | 2 |
| BSD-3-Clause | 8 |
| BSD-3-Clause AND MIT | 1 |
| BSD-3-Clause OR Apache-2.0 | 2 |
| BSD-3-Clause OR MIT | 1 |
| BSL-1.0 | 1 |
| CC0-1.0 | 1 |
| CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception | 1 |
| CC0-1.0 OR MIT-0 OR Apache-2.0 | 2 |
| ISC | 16 |
| LicenseRef-Electron-ThirdParty | 1 |
| MIT | 332 |
| MIT AND BSD-3-Clause | 1 |
| MIT AND ISC | 1 |
| MIT OR Apache-2.0 | 266 |
| MIT OR Apache-2.0 OR Zlib | 2 |
| MIT OR BSD-3-Clause | 1 |
| MIT OR Zlib OR Apache-2.0 | 2 |
| MPL-2.0 | 6 |
| OFL-1.1 | 2 |
| Unicode-3.0 | 38 |
| Unlicense OR MIT | 13 |
| Zlib | 3 |
| Zlib OR Apache-2.0 OR MIT | 2 |
| blessing | 1 |
| zlib-acknowledgement OR MIT | 1 |
