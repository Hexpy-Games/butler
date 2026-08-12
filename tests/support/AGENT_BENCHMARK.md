# Butler, Hermes Agent, and OpenCode benchmark

Status: governing specification, revision 4
Comparison baseline: `origin/main` at `549463fbe074fc25042f9302cd330699948dab50`

## Canonical authority

`tests/support/agent-benchmark` is the sole benchmark orchestration and
evaluation domain. Both the frozen cross-agent comparison and M1 v2 Butler
campaign enter through `createBenchmarkPlan`, `runAgentBenchmark`,
`evaluateAdapterResult`, and the one report schema. The Butler adapter composes
the existing `tests/e2e/btcc-r3-electron-driver.ts` harness primitive; it does
not define an alternate product path.

The M1 v2 campaign mode owns the exact `direct-cold`, `direct-warm`,
`current-web-cold`, and `landing-cold` public fixtures, authoritative JSONL
provenance checks, frozen hashes, same-Session warm boundary, SC01 eligibility,
nullable provider usage, Butler Work/Ledger/memory cost, and code-grounded
landing rubric. It schedules Butler-only repetitions sequentially. Hermes and
OpenCode remain contract-covered comparison adapters and are not preflighted or
executed in M1 mode.

The historical compact 12-observation report remains immutable rejected,
unranked evidence. It is not reinterpreted as accepted and is not eligible for
M1 statistical acceptance. Capability-envelope differences remain mandatory
when later comparing Butler with Hermes or OpenCode.

## Intent lock

- Accepted intent: provide a reproducible, reviewable comparison of Butler,
  Hermes Agent, and OpenCode for a short conversation, current-information
  research, and a repository-to-landing-page task.
- Pilot correction accepted on 2026-08-09: execute the authenticated installed
  products instead of treating non-interactive PATH discovery as an external
  gate. The controlled pilot model is `openai/gpt-5.6-sol` with `medium`
  reasoning in every product's supported per-run control.
- Pilot-size correction accepted on 2026-08-09: the canonical pilot is a
  compact 12-arm controlled comparison, not a full track/cache factorial. It
  runs four cases per agent: direct conversation cold and paired warm,
  current-information web research cold, and Butler landing-page cold.
- Observable success: one benchmark CLI materializes a randomized plan, checks
  the three real adapters, runs available arms in isolated workspaces, evaluates
  captured evidence, and writes a machine-readable result plus a Markdown report.
- Canonical path: `bun run benchmark:agents -- <command>` -> benchmark workflow
  -> Butler/Hermes/OpenCode adapter -> typed observations -> evaluators -> report.
- Non-goals: deciding a universal winner, repairing products discovered by the
  benchmark, managing credentials, or generalizing the existing BTCC revision
  harness into a cross-agent framework.
- Forbidden substitutions: fabricated observations, test-only adapters, source
  string assertions as runtime proof, optional execution callbacks on the real
  CLI path, shared mutable workspaces, or treating an unavailable CLI as a score.

The existing BTCC benchmark may contribute metric vocabulary and Butler product
telemetry only. Its paired R2/R3 Electron lifecycle, revision-specific Ledger
rules, and 72-arm release decision do not govern this benchmark.

## Ownership and public surface

The benchmark workflow is the single authority for run order, isolation,
observation persistence, evaluation, and report generation. Each adapter owns
only translation between that workflow and one real product surface:

- Butler uses the repository's real Electron/App benchmark ingress and captures
  its provider, tool, timing, result, and artifact evidence.
- Hermes uses the official `hermes` CLI: `chat -Q -q` with exact session resume
  for the multi-turn fixture, and one-shot plus its usage-file contract for the
  single-turn fixtures. Direct-session aggregate telemetry reads only the
  documented local session store's safe counter/config columns by session ID;
  it never reads message, prompt, tool payload, or reasoning columns.
- OpenCode uses the official `opencode run` JSON-event/session surface.

The CLI composition root binds all three adapters. Adapters and evaluators are
not independently public product APIs. A missing executable, authentication,
or required measurement produces a typed gate or `null`, never a fallback arm.

Official external contracts reviewed for revision 3:

- Hermes install: <https://hermes-agent.nousresearch.com/docs/>
- Hermes CLI: <https://hermes-agent.nousresearch.com/docs/user-guide/cli>
- OpenCode install: <https://github.com/anomalyco/opencode#installation>
- OpenCode CLI: <https://opencode.ai/docs/ko/cli/>

The corrected pilot inspection on 2026-08-09 resolved Hermes Agent 0.20.0 at
its official per-user install location and OpenCode 1.18.15 at its per-user
install location. Both authentication probes succeeded, Hermes reported
`gpt-5.6-sol` as its configured default, and OpenCode enumerated
`openai/gpt-5.6-sol`. Every run must still recheck executable, authentication,
and effective-model evidence through the canonical workflow.

## Tracks

The benchmark defines both a controlled track and a recommended-default track.
Every executed arm records the effective executable version, model,
reasoning/variant, permissions, tool set, and relevant safe configuration. The
canonical compact pilot executes controlled arms only; the workflow preflights
the three agents for that controlled plan. The recommended-default definition
remains available for a later comparison run, but is not applied or verified in
this pilot.

### Controlled track

- The operator supplies one model identity supported by all three products.
- The controlled logical identity `openai/gpt-5.6-sol` maps to Hermes'
  authenticated `openai-codex` provider with provider-native model argument
  `gpt-5.6-sol`; observations normalize it back to the shared logical identity
  while retaining the provider field.
- The requested reasoning effort is applied through Butler's harness, Hermes'
  `--reasoning`, and OpenCode's `--variant` per-run controls. An unavailable or
  unverifiable applied value gates the controlled arm; it is never silently
  omitted. Full benchmark-workspace permissions and web access are required.
- Personal memory, skills, project rules, plugins, MCP servers, and unrelated
  user configuration are disabled where the product offers an official switch.
- Hermes enables only its official web and file toolsets under safe mode; its
  terminal tool is excluded because it would bypass the write-safe-root guard.
  OpenCode uses an explicit-deny inline permission policy: workspace file and
  web operations are allowed, while shell, subagent, skill, question, LSP, and
  external-directory operations are denied even under `--auto`. Controlled
  OpenCode additionally uses an arm-owned HOME, XDG config directory,
  OPENCODE_CONFIG_DIR, and cache, while XDG_DATA_HOME points at the existing
  normal auth data parent without copying credentials; an unverifiable parent
  gates the arm. Recommended-default retains the normal HOME/config/data
  surface.
- No adapter may silently substitute a different model or provider. An arm with
  an unverifiable effective model is gated.

### Recommended-default track

- Each product uses its documented recommended default after normal setup.
- The effective model, reasoning, permissions, tools, and enabled customization
  are recorded rather than normalized away.
- OpenCode keeps its normal configuration, plugin, instruction, data, and auth
  surfaces on this track; the harness isolates only the benchmark cache pair and
  output workspace instead of replacing the product default with controlled
  configuration.
- Credentials remain in each product's normal credential store or environment;
  the harness records only availability booleans and redacted provider names.

The two tracks answer different questions and are never pooled into one score.

## Corpus and fixtures

All agents receive byte-identical materialized prompts within a track. Fixtures
are versioned in the repository and hashed into the plan.

1. `direct_conversation`: four sequential turns in one session. It checks
   instruction retention, concise factual response, correction handling, and a
   final synthesis. Tools are not required.
2. `current_web_research`: one current-information question whose evaluation
   date and expected factual claims are frozen in the fixture. The result must
   cite primary or authoritative sources, distinguish publication date from
   event date, avoid unsupported claims, and expose source URLs for review.
3. `butler_landing_page`: read-only access to the pinned Butler repository and
   write access only to an isolated workspace that is otherwise empty apart
   from its reserved read-only input namespace. The result must
   create the required landing-page files, accurately introduce Butler from
   repository evidence, pass the fixture's build/tests, and render at desktop
   and mobile sizes without horizontal overflow.

Only the landing-page scenario receives repository evidence. The exact pinned
snapshot is materialized at the same relative `.benchmark-input/repository`
namespace for every product; direct conversation and web-research arms do not
receive that unrelated input. Agent-visible instructions contain no absolute
source, evidence, cache, or output paths.

Repository-task prompts prohibit modifying the source checkout. Benchmark-
discovered product fixes are recorded as later-work notes and are not applied by
this PR or by a benchmark arm.

## Planning, randomization, and cache states

- A run seed is mandatory and stored. Fisher-Yates shuffling derived from that
  seed randomizes agent order independently for each scenario. The canonical
  plan has exactly 12 arms: six direct-conversation arms (cold then warm for
  each agent), three current-web-research cold arms, and three landing-page
  cold arms. Each agent therefore has exactly four arms.
- Direct cold and warm arms for an agent are adjacent and share one
  `cachePairId`/cache root while keeping fresh sessions, evidence, data, and
  output roots. Web and landing arms are cold-only in the compact pilot.
- Cold means the first invocation in a pair with fresh benchmark-owned mutable
  data/config/output state. Warm immediately repeats the same fixture and config
  with a fresh session/output while its pair cache and any provider-side cache
  may carry. Opaque provider caches cannot be forcibly flushed, so cache-token
  fields report observed behavior rather than claiming a guaranteed cold miss.
  No cross-agent cache is shared.
- Arms run sequentially to avoid resource contention. Resume skips only terminal
  observations whose plan key and fixture hash match.
- The source checkout is an explicit read-only input outside the run root.
  Benchmark-owned config, cache, output, and evidence directories resolve under
  the declared run root. Paths escaping their declared authority fail closed.

## Typed result contract

The schema version is `butler.agent-benchmark.v1`. A run stores:

- immutable metadata: run ID, seed, baseline SHA, fixture hash, track,
  cold/warm state, agent, adapter/executable version, effective model/config;
- terminal state: `accepted`, `rejected`, `failed`, `timed_out`, or `gated`;
- gate code: `executable_missing`, `authentication_unavailable`,
  `configuration_unverifiable`, `measurement_unavailable`, or `none`;
- usage: input, cache-read, cache-write, output, and total tokens plus model
  request count;
- tools: calls, failed calls, and normalized call records without arguments,
  raw payloads, or transcript text;
- timing: submission, first useful output, terminal time, and total elapsed;
- operations: user interventions, retries, changed files, and test/build results;
- evaluation: acceptance, factual accuracy, source quality, visual/result quality,
  evaluator notes, evidence references, and optional typed human visual-review
  evidence containing a 1-5 score, safe reviewer label, and rubric version;
- privacy: redaction status and explicit booleans for prompt, credential, raw tool
  payload, private-path, and hidden-reasoning leakage.

Token fields are nullable because not every official product surface exposes all
usage classes. Each adapter stores provider-reported values without inventing a
cross-provider equation: `inputTokens` is all reported input, cache read/write
are overlapping detail fields when the provider defines them that way, and
`totalTokens` is the provider total or `inputTokens + outputTokens` only when
both are complete. Cache detail is never added to input a second time. Unknown
stays `null` and makes token-efficiency comparison ineligible.

`acceptedResultPerToken` is `1_000_000 / totalTokens` only when the arm is
accepted and total tokens are positive. Rejected, failed, timed-out, gated, or
incompletely measured arms report `null`, not zero.

## Evaluation

Evaluation is deterministic where possible and explicitly human where needed.

- Common acceptance requires a successful terminal state, no privacy/scope
  violation, and all scenario-specific required outcomes.
- Direct conversation uses fixture assertions and a 1-5 result-quality rubric.
- Web research checks claim keys, citation URLs, authoritative-source classes,
  date freshness, contradiction against the frozen answer key, and a 1-5 result
  rubric. Search-result snippets alone are not authoritative sources.
- Landing-page evaluation inventories changed files, runs the declared tests and
  build, checks required factual claims against pinned repository evidence, and
  captures desktop/mobile screenshots. Build, overflow, missing output, or source
  checkout mutation is rejection. A human records visual quality from 1-5 using
  hierarchy, readability, responsiveness, and product fit. The review is applied
  after the run through `--visual-review FILE`; it can target only landing arms
  with real desktop/mobile screenshot evidence and is persisted by the same
  workflow checkpoint authority before report generation.

The generated report shows per-arm raw metrics, medians by agent/scenario/cache,
accepted-result-per-token only for eligible arms, acceptance counts, and all
gates. It does not rank an agent when required observations are missing. Human
scores include reviewer identity label and rubric version, not credentials.

## Execution state and failure semantics

The workflow transitions `planned -> preflight -> running -> reported`. Its
required execution mode is either `preflight-only` or `execute`; both use the
same source-integrity, adapter-preflight, observation, persistence, and report
path. Preflight-only never invokes an adapter run and cannot bypass the pinned,
clean source check. An arm
transitions `pending -> running -> terminal`; terminal states are the five
schema states above. Evaluation is part of the arm's single terminalization
step. Persistence occurs after plan creation and after every terminal arm so
interruption can resume idempotently.

- SIGINT or operator cancellation stops launching new arms, terminates the active
  child process, persists a failure-safe checkpoint, and leaves pending arms.
- Timeouts terminate the child process group and record `timed_out`.
- Non-zero product exit, malformed events, output-root escape, or source mutation
  records `failed` or `rejected` with bounded diagnostics.
- Missing CLI/auth/config records `gated`; it does not block available arms or
  report comparative numbers for the missing agent.
- The harness does not automatically retry an arm. Product-observable retries
  are recorded when exposed; otherwise the metric is `null`. An operator retry
  uses a new run ID, while same-run resume skips only an identity-matched
  terminal observation and never re-labels it as a new attempt.

## Security and privacy

- Spawn commands use argument arrays with no shell interpolation.
- Only an explicit safe environment allowlist is inherited. Secrets are neither
  serialized nor printed. Authentication checks expose status only.
- Evidence and reports exclude raw prompts, transcripts, hidden reasoning, tool
  arguments/results, credentials, and private absolute paths.
- Hermes direct-conversation telemetry selects only model/provider and aggregate
  token, request, and tool counters from the exact sanitized session ID. The
  benchmark never exports or selects session message content.
- Generated landing build/test subprocesses receive only a minimal environment;
  HOME and cache directories are redirected under benchmark-owned roots. The
  runner does not claim an OS sandbox, so pilots must treat generated scripts as
  trusted benchmark output and record that residual risk.
- Source repository access is read-only for all agents. Only the benchmark-owned
  output root may be mutated. Baseline integrity is checked before and after each
  repository arm with Git status and the pinned SHA.
- Reports use relative artifact references and bounded stderr tails after
  redaction. Symlink/path escapes fail closed.

## Platform contract

Revision 3 supports macOS and Linux under Bun. Executable discovery uses PATH,
process-group termination uses the platform's POSIX semantics, and browser
rendering requires an explicitly discovered Chromium-family binary. Windows is
reported as `configuration_unverifiable` until its process-tree termination and
path-isolation behavior have a real smoke; the runner must not imply that the
POSIX contract applies there. External CLI installation is never performed by
the runner. Operators install only through the official links above and complete
authentication outside the benchmark process.

## Acceptance criteria and validation map

1. The baseline SHA, executed track(s), seed, cache state, fixtures, and runtime
   versions are present in a materialized plan. The supported track definitions
   live in this specification and the planning configuration. The compact
   pilot's plan has 12 controlled arms; recommended-default is defined and
   supported but is not executed or separately verified. Covered by plan/schema
   tests.
2. The single CLI preflights and invokes concrete Butler, Hermes, and OpenCode
   adapters. Covered by adapter contract tests and a real missing-CLI smoke.
3. All required metrics are parsed or explicitly `null`; derived token efficiency
   is never fabricated. Covered by schema and evaluator tests.
4. Randomization is deterministic for one seed and independently orders agents
   per scenario while preserving direct cold-to-warm adjacency. Covered by plan
   tests.
5. Workspace isolation, canonical/symlink containment, baseline integrity,
   redaction, timeout, resume, and external gates fail closed. Covered by
   workflow integration tests.
6. Web and landing evaluators reject weak sources, stale/incorrect claims, build
   failure, missing files, source mutation, overflow, and privacy leakage. Covered
   by evaluator fixtures and integration tests.
7. A pilot command uses the single workflow path and produces a baseline Markdown
   report from the installed authenticated Butler, Hermes, and OpenCode products
   using the 12 controlled `openai/gpt-5.6-sol`/`medium` arms. The
   recommended-default configuration is defined and supported for a later
   comparison, but is not executed or separately verified in this canonical
   pilot. Any genuinely unavailable product remains a typed gate rather than a
   fabricated result.
   Typed post-run visual review is accepted only for screenshot-backed landing
   observations. Covered by CLI and visual-review smoke tests.
8. Targeted tests, lint, typecheck, `git diff --check`, `bun run check`, the
   module-shape audit, and Project Ledger status/check/render pass before PR.

The pilot protocol in the report documentation is the operator runbook. The
reviewed, redacted pilot Markdown report belongs in this PR. Raw checkpoints,
transcripts, prompts, credentials, absolute paths, and unsanitized tool payloads
remain outside Git.
