# Isolated Rust migration measurement preparation

Authority: `SPEC-RUST-ISOLATED-BENCHMARK`, attached to the original Rust migration
Work. These are **development measurement tools**, not a runtime dependency or a
completed benchmark. Import, preflight, and inventory modes do not launch Butler
or contact a provider. Final campaign execution requires the accepted complete
native artifact and separate authorization.

`process_metrics.py` reads only `ps` PID, parent PID, start time, cumulative CPU,
RSS and process state. The future campaign supplies exact root identities from
its own newly launched isolated legacy gateway/executor or native executable.
It must never choose roots by a product name or attach to the user's live Butler.
No command arguments, credentials, environment contents or executable paths are
recorded. This collector cannot signal, terminate or restart any process.

`TreeAccounting.sample` follows descendants through identity-bearing live parents,
retains observed descendants after reparenting, rejects changed start identities
when a PID is reused, and retains only CPU counters after an observed process
disappears. Sampling failures raise `SampleUnavailable`; the campaign must emit
an unavailable observation and preserve the gap, never synthesize zero usage.
Call `record_unavailable()` for each collection failure. The next successful
sample marks its CPU interval as a gap average, which must be excluded from
ordinary sampled peak comparisons or displayed separately.
Use nominal 100 ms cadence and retain the actual collection duration and interval.

The sum of RSS is a proxy, not unique physical memory. CPU sums include each
observed owned process's lifetime CPU, including execution before its first sample.
Thus delayed discovery can put earlier CPU into the discovery interval; short
children born and exited between samples can be missed. Exited processes' final
unobserved CPU is unavailable. The start identity from `ps` has one-second
precision, so same-second PID reuse is indistinguishable. CPU counter resolution
is inferred from the reported decimal precision and included in every sample;
coarse counter granularity can dominate sampled peaks. Percent CPU uses one core
as 100%, allowing values over 100% for parallel work. These limitations must appear
in the report; they do not establish exact kernel-accounted total CPU or peaks.

The runner measures authenticated gateway and executor readiness, public SSE
activity, durable terminal-message timing, completed tool-journal calls, the
owned process tree, CPU/RSS samples, footprint checkpoints, and the exact
post-work checkpoints at 1/30/120 seconds. It probes the isolated loopback
listener after owned shutdown and inventories launch executables plus bundled
and system Mach-O dylib dependencies. Windows collection is unavailable. The
file-writing cases 7–10 distinguish the parent Turn acknowledgement from the
exact relation-linked child result. Logical completion is observed through
authenticated session view polling every 150 ms plus HTTP response time; child
tool evidence and workspace effects are scored after that terminal result.
standalone accounting checks use synthetic snapshots and a short Python child
owned by the test, without starting Butler:

```sh
python3 -m unittest discover -s tests/benchmark/rust-agent -p 'test_*.py' -v
```

## Preparation modules (not a completed campaign)

`workload.json` freezes F1-F7 source text, IDs, timestamps, ten exact prompts,
workspace seed, output bytes and output hashes. `workload.py` validates its
cardinality and root-reviewed output digests. The setup-only
`seed_canonical_fixture.ts` writes each source through production
`AgentConversationStore.beginTurn`/`appendUserMessage`/`finalizeTurn`, including
the same classified public-ingress origin used for an admitted user turn, then
closes the writer. It requires fresh, separate data and workspace directories
under an already isolated scratch parent. It writes no derived memory index.
`installed_canonical_readiness.py` separately launches each frozen arm against
disposable DATA, drives one authenticated public Guided Turn with a loopback-only
synthetic model, and verifies F1-F7 from the installed tool journal. It keeps the
synthetic loopback model evidence separate from the campaign model and effort
read through authenticated public settings. The seeder is shared fixture setup;
neither arm's installed-read evidence comes from checkout TS handlers. A legacy
writer may seed both arm schemas only after schema compatibility is verified;
the timed native backend must not depend on Bun.

`app_protocol.py` implements authenticated loopback health/readiness, project
and session creation, session controls, SSE and public message/turn requests.
Open SSE and confirm its immediate heartbeat before POST. Create ten distinct
`workspace_mode=local` project sessions via the public API, measuring creation
outside each turn timer. A setup utility can issue the production
`createProjectFolderSelectionToken` for its own 0700 workspace and own secret;
submit the token to public `POST /projects` and never report it. No benchmark
code should upsert a session binding or edit App DB directly. Check that all
ten sessions resolve that same project workspace before the first turn.

`measurement.py` coordinates the existing process sampler and macOS
`phys_footprint` checkpoints across currently observed owned PIDs. Footprint
is a checkpoint, not a tree peak. Missing or departed identities yield
`unavailable`. `turn_observer.py` records public tool progress intervals by
opaque call identity without writing those IDs to evidence. `summary.py` retains
all three AB/BA/AB pair entries and computes only accuracy-valid paired
differences. The public App API has no provider first-content boundary or
provider owner registry, so provider intervals and the local residual stay
`unavailable`. Public tool-call activity is reported separately from owner
counts; provider/tool/Lance/fetch owner counts stay `unavailable` without a
public owner registry.

`run_campaign.py` ties those modules together. Its default mode is a read-only
preflight; `--inventory` calculates installation-tree SHA-256 manifests and
read-only executable/dylib closure inventories. It requires a private JSON
contract with `schema=butler.rust-benchmark.campaign.v1`,
`baseline_revision=b484052e5683109d0a2491566024a9110090fbb2`, and
`baseline_bun_executable_sha256` matching the canonical executable reached by
`/opt/homebrew/bin/bun` on the campaign host. `--inventory` emits this SHA.
The contract also requires `architecture=macos-arm64`, one `model`,
`reasoning_effort`, `locale`,
`timezone`, `scratch_parent`, and `readiness_receipt_file`. Each `legacy` and
`candidate` entry requires `installation_root`, `frozen_manifest_sha256`, and
explicit `commands` arrays. Provider input must use exactly one mode: the
existing `provider_env_file` field with the same private JSON environment map in
both arms, a top-level `provider_credential_file` selecting one Z.ai API-key
record, or a top-level `provider_codex_oauth_file` selecting one OpenAI Codex
OAuth profile. The selected record or profile is copied into each arm's isolated
DATA; the provider input modes are mutually exclusive and never fall back to
one another. No full production auth/config directory is copied. Legacy
requires two commands (gateway and executor); candidate
requires at least one. Executables must be absolute, and command arguments may contain
`{installation}`, `{data}`, or `{workspace}`. The private readiness receipt uses
`schema=butler.rust-benchmark.readiness.v3`. It binds the selected model and
reasoning effort, disabled/empty model fallback, exact fixture-procedure hash,
each installed artifact manifest hash, and a SHA-256 of each arm's explicit
launch-command template. For both arms it requires an installed public Guided
Turn that calls `query_memory`, forwards each returned `read_args` unchanged to
`read_conversation_session`, and reads all F1-F7 canonical IDs and exact text.
`installed_canonical_readiness.py` drives that turn with a synthetic
`openai/gpt-5.5` loopback model; this proves the installed tool path, not the
campaign model's answer quality. The same installed process separately reports
the campaign model, reasoning effort, and disabled fallback through authenticated
public settings. Journal readback binds each query result, forwarded read
arguments, returned canonical message ID, and returned-text hash to the
installation-manifest and launch-template hashes. The shared TS fixture seeder
only prepares synthetic canonical rows; checkout TS tool handlers are never
readiness evidence. The per-arm evidence digest and exact owner-condition object
are validated; older receipts and direct-handler observations fail closed. The
final run additionally requires both `--execute` and
`final_campaign_authorized=true`; no such authorization is claimed here.

Each arm's exact `embedding_owner_conditions` value is:

```json
{
  "active_generation": "absent",
  "exact_lookup_and_read_only": true,
  "recall_resolves_generation_before_embedding": true,
  "daily_session_sync": "suppressed_for_local_day",
  "daily_consolidation_cycle": "suppressed_for_local_day",
  "asset_downloads_observed": 0,
  "embedding_owner_invocations": "unavailable_no_public_owner_registry"
}
```

Each `canonical_read_evidence` is the installed Guided Turn and journal result
for that arm;
`canonical_read_evidence_sha256` hashes its canonical sorted-key JSON encoding.
Receipt model/reasoning/fallback values are repeated at top-level, per arm, and
the observed public settings projection. The synthetic loopback model and effort
remain separate fields inside the public tool-turn evidence.

Each attempted arm gets a fresh 0700 data/workspace/evidence root. The runner
seeds canonical sources, creates a deterministic scratch Git workspace, writes
synthetic config and private local auth, and writes only the selected provider credential
when credential-file mode is chosen. It checks
the loopback port, then starts explicit backend commands and captures root PID/start
identities. Authenticated `/health` plus `/runtime-readiness` with a live owned
executor are required. It creates a public existing-folder project and ten
distinct public local project sessions. Each turn opens SSE and observes its
heartbeat before POST. It records response/terminal timing, process samples,
footprint checkpoints and read-only tool-journal evidence. It retains all
failed cases, samples 1/30/120 seconds after the tenth case, signals only
identity-matched owned processes, and checks the installation manifest again.
After shutdown it records loopback listener residue. The arm result carries
executable counts, launch command binary hashes, and transitive bundled/system
dylib edges; unresolved or external dependencies remain unavailable. The report
does not include private absolute installation paths. Raw backend logs remain
private in the arm's evidence directory; reports contain safe codes/metrics/
hashes, not prompts, result text, tool arguments, credentials, or private paths.

The isolated config explicitly pins both model fields and
`user.modelFallback={enabled:false,models:[]}`. The runner checks the resolved
model, reasoning effort, and fallback through authenticated `GET /settings`
before turns. It does not use `memory.sleepCycle.enabled`; no product code reads
that key. In fresh DATA, the exact canonical read path avoids vector search and
recall requires an active generation before it can reach the vector owner. The
runner records the active-generation descriptor and the actual
`cache/models/Xenova/bge-m3` tree before and after each arm. It writes the
supported per-local-day `session-sync` and `consolidation-cycle` scheduler markers
into that arm's isolated DATA before launch, because native `session-sync` falls
back to legacy indexing when no generation exists. If the local-day suppression
expires or the embedding cache appears, the arm fails readiness. Butler exposes
no public embedding-owner invocation registry, so that count remains
`unavailable`; an absent cache proves no model assets were downloaded. The
installed Guided Turn journal proves the fixture's canonical reads completed;
source-path evidence shows these exact lookup/read calls do not request
embeddings.

The runner is **not ready for the final timed campaign** until the accepted
native package and exact launch commands exist, the native public API and
memory readiness receipt is established with this fixture, and root reviews
the integration. Provider first-content intervals, local orchestration
residual, and non-process owner counts remain explicitly `unavailable` because
the public path exposes no such timing boundary or owner registry. First public
assistant answer-token timing also remains `unavailable`; final answer timing
uses durable `/turns` and `/messages` responses. Listener residue and executable
and dylib closure are collected where host tools can prove them; failed
collection remains `unavailable`, never zero.
The read-only tool-journal observer expects the production
`agent-runtime/btcc.sqlite` table and must be checked against both final
artifacts. Execution remains gated by `--execute` and
`final_campaign_authorized=true`. The synthetic harness checks do not use a real
credential, model, or provider.
