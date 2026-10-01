# Release disclosures

Butler is free, non-commercial software. The owner approved disclosure plus
upstream license links, including the six existing MPL-2.0 components and the
Electron/ONNX supplier collections. Our generated payload contains no full
license bodies or shared text store. Electron retains the license files supplied
in its original runtime; our packagers do not duplicate them.

`catalog.json` keeps reviewed license IDs, source evidence hashes, attribution
and links, without full texts. Generation validates locked input fingerprints,
production npm closure and vendored asset fingerprints. Every one of the 848 inventory components remains
disclosed with name, version, SPDX expression (or the supplier's explicit
LicenseRef), upstream link(s), and available copyright attribution lines.
Supplier collections remain collection entries; individual supplier versions and
SPDX metadata are not consistently available upstream. Attribution lines from
these collections are retained; their complete license conditions are linked.

Pinned repository license files are linked where the evidence resolves their
path. Cargo's VCS metadata supplies the commit and package subdirectory. Explicit
upstream evidence URLs retain their pinned identity. Otherwise the versioned
crates.io/npmjs.com package page or project homepage is used. The BGE-M3 model
card and license identity match the runtime's frozen revision
`4de13258303883538bd53b696b452bf8099f0858`; refresh reads that constant instead
of following the Hub's latest revision. Complete pre-existing local model caches
retain the runtime's existing byte-derived identity behavior.

## Validation and refresh

Run checks with temporary HOME/BUTLER_DATA and preserve Cargo caches:

```sh
export CARGO_HOME="$HOME/.cargo" RUSTUP_HOME="$HOME/.rustup"
export HOME=$(mktemp -d) BUTLER_DATA=$(mktemp -d)
bun install --frozen-lockfile --ignore-scripts
node deploy/licenses/generate.mjs --check
node deploy/licenses/check.mjs
python3 deploy/licenses/check-disclosure.py
node deploy/licenses/verify-packaging.mjs
npm --prefix packages/butler-app/client/ui run build
bun tests/smoke/open-source-licenses-smoke.ts
```

After dependency changes, install the locked packages (including Electron's
runtime for evidence collection), run `python3 deploy/licenses/refresh.py`, review
the updated inventory, then run `node deploy/licenses/generate.mjs`. Refresh
fetches upstream evidence; generation and checks are offline and deterministic.
Missing/unknown licenses, missing/invalid HTTPS links, stale inventory, and a
model revision mismatch fail CI. Existing SPDX allowlist and version-scoped MPL
exceptions remain enforced; the owner accepted those exceptions.

## Artifact layout

The renderer build emits `THIRD_PARTY_NOTICES.txt.gz`. Gzip is deterministic and
built-in `DecompressionStream` expands it only when the viewer is opened. Closing
the viewer releases its parsed disclosures. Startup and idle perform no reads
and hold no inventory data. The smoke asserts the complete 848-item list and
measures opening time and retained browser heap, plus responsive search/expand.

| Artifact | Single disclosure data file |
| --- | --- |
| macOS App | `Contents/Resources/bundled-agent/resources/app-client/dist/THIRD_PARTY_NOTICES.txt.gz` |
| Linux/Windows App | `resources/bundled-agent/resources/app-client/dist/THIRD_PARTY_NOTICES.txt.gz` |
| Agent archive | `resources/app-client/dist/THIRD_PARTY_NOTICES.txt.gz` |
| npm wrapper | `THIRD_PARTY_NOTICES.txt.gz` |
| Browser renderer | `THIRD_PARTY_NOTICES.txt.gz` beside `index.html` |

App resources, Agent archive root and npm root contain a short human-readable
`THIRD_PARTY_NOTICES.txt` pointer with a `gzip -dc` command. This exposes the full
plain-text disclosure offline without a second stored copy; the App/browser
viewer also reads it locally. The Electron app protocol maps the exact notice
URL to the bundled Agent's copy. The gateway reads that same renderer asset.

Previously the App copied the 14,658,099-byte document three times: App renderer,
bundled Agent bin, bundled Agent renderer (43,974,297 notice bytes). The reported
43,961,730-byte resource-layout delta also included a net -12,567 bytes in other
resources. The archive copied it twice. The finalizer removes the two redundant
App copies; Agent packaging adds only its readable pointer. Packaging smoke uses
the real App finalizer, Agent archive writer and npm pack with isolated fixture
payloads, validating byte-for-byte completeness and size budgets. It does not
build an entire Electron release or claim signing/notarization validation.
