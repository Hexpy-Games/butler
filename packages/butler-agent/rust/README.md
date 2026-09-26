# Butler Agent Rust workspace

This workspace contains the native agent library and standalone `butler-agent` service under
`agent/`, plus development quality tooling. The current executable connects the existing
durable App input queue to canonical conversation preparation, the native provider/tool loop,
and durable App reply/progress transcripts. It drains owned work and stores on shutdown and
reopens an activated native data root on restart.

The previous frozen macOS arm64 native build passed isolated service, tool, memory, App HTTP,
standalone and Desktop package paths, including bundled native readiness and owned shutdown.
The real-model GPT-6 Sol campaign completed all 30 native tasks; it produced no valid paired
performance comparisons because the Bun arm failed its accuracy conditions. This checkout's
newer changes still require a final build and existing-DATA rehearsal before replacing the
running Butler. Windows and Linux runtime releases and hosted CI have not been validated.
Electron and frontend code remain JavaScript.

Installation resources resolve from the actual executable directory (or the Desktop bundle's
native agent resource directory). `BUTLER_HOME`, the working directory, and the source checkout
are not installation authorities. Runtime writes belong in `BUTLER_DATA`; the installation
must remain unchanged. For local runs, use an **isolated** `BUTLER_DATA` and the existing
`butler.config.json` and provider environment. The service consumes the existing file queue
under `runtime/inbound-events`, rather than a new stdin protocol. Stop it with SIGINT/SIGTERM
or its existing `locks/butler-shutdown` flag. Existing installed processes are not replaced.

The build includes static ONNX Runtime and Lance dependencies. Follow the repository-owned
[static dependency recipe](scripts/STATIC_ORT.md); the existing Electron native producer
prepares that dependency cache and builds the packaged executable. Do not use an old ad hoc
ORT build directory as an undocumented prerequisite.

The executable has passed an isolated source-queue smoke through a local mock provider,
physical file read, canonical persistence, reply transcript, close, and restart. A further
13-round mock-provider run queried a previous conversation, reopened its exact source, and
created, reviewed, and completed Work through actual journaled tool calls. Another run used
ten foreground and two semantic mock-provider calls to prove completion registration, recall,
exact source reads, workspace list/read, and recall again after restart. This is not
a real-model comparison or a performance benchmark.

Use the narrow checks relevant to a change from this directory; do not rerun the full test
suite for every leaf. Style and structural checks are:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo run --locked -p butler-source-check -- .
```

Use `cargo test --locked -p butler-agent <affected behavior>` for a meaningful behavior check.
The final migration must pass the full required checks. This checkout passed strict Clippy on
macOS arm64 after the agent delta changes.

The source checker counts physical lines in every handwritten `.rs` file, including comments,
blank lines, and inline tests. Files from 400 through 500 lines require a responsibility review and
pass with a notice. Files over 500 lines fail. `.git` and `target` directories are excluded. Rust
source symlinks and directory symlinks are rejected so they cannot bypass the scan.

When the scan root contains `agent/src/lib.rs`, the checker also reads the production module tree
and enforces the reviewed domain dependency table, cross-domain facade access, and an acyclic
dependency graph. Test-only modules are excluded from that graph; their physical files still count
toward the size limit. Explicit crate/relative paths, grouped imports, and paths in macro tokens are
checked. Comments and string literals are not treated as imports. `include!` source fragments and
block-local module declarations fail because they obscure the declared module entry tree.

This syntax check complements compiler privacy and manual responsibility review. It does not
replace Rust name resolution, expand procedural macros, or resolve paths through every alias.
Module-file lookup follows the [Rust Reference](https://doc.rust-lang.org/reference/items/modules.html).
Update `tools/source-check/src/architecture/policy.rs` only after reviewing a domain or dependency
change. A passing checker does not establish runtime composition or performance acceptance.

The parser source notice is retained in [agent/THIRD_PARTY_NOTICES.md](agent/THIRD_PARTY_NOTICES.md). Final binary packaging must carry these notices; the current library checks do not prove distribution closure.
