# M1 Context Efficiency — corrected v2 Task 1 report

Date: 2026-08-11
Task: `T-M1-V2-SEGMENT-ATTRIBUTION`
Governing Spec: `SPEC-M1-CONTEXT-EFFICIENCY` revision 2

## Status

**PARTIAL / HARD STOP.** The observation slice is implemented on the production
provider path and one authenticated direct smoke passed. The corrected
pre-change baseline has `0 accepted`, `0 rejected`, and `12 gated` required
repetitions. Therefore this Task is not complete and no later M1 v2 Task may
start.

The gate is evidence availability, not a provider failure: the current branch
did not contain the historical four-arm runner/report, the historical accepted
run roots were deleted, and the historical report does not retain the exact
scenario files, commands, direct-warm cache/session composition, or dated web
rubric needed to reproduce all four arms without inventing inputs. The existing
Electron scenario driver can drive the real product path, but a runner without
the frozen authoritative scenarios would not satisfy the Spec.

## Implemented production path

The real path is:

`Session Actor -> guided Turn prompt attribution -> runBtccAgentLoop ->
createModelRoutePort -> runOpenAIModelRound -> createOpenAIResponse ->
withModelApiRetry -> createOpenAIResponseOnce -> official Responses or Codex
request-body conversion -> exact final JSON serialization -> fetch -> response
usage observation`.

The default-off `BUTLER_M1_V2_SEGMENT_ATTRIBUTION` flag is read only at the
final observation boundary. Disabled or failed observation returns the same
serialized request and cannot veto, retry, reroute, or alter a Turn. Route-owned
transport attempts and provider-client retries retain separate typed zero-based
ordinals through the provider adapter. The persisted retry coordinate combines
both without treating a route retry's first provider send as eligible, and each
actual dispatch adds a fresh nonce, so later redispatches at the same coordinates
do not collapse into one digest. Terminal rejection takes precedence over retry
contamination; successful route or provider retries are retry-contaminated.

Each dispatch prepares segments before fetch but writes its single final
`butler.m1-request-envelope.v2` only after terminal transport, usage, and typed
cache evidence are known. Failed attempts retain that envelope and their mutually
exclusive `butler.m1-request-segment.v2` rows; a completed attempt has at most one
`butler.m1-response-usage.v2`. Provider usage remains nullable. Exact additive
bytes are computed from the same JSON representation sent to `fetch`. Official
Responses `requestItems` and Codex cumulative stateless input receive separate
manifests bound to exact JSON paths and UTF-16 spans as each carrier is assembled;
there is no occurrence wildcard or string-search attribution. Token
estimates are not summed as if tokenizer boundaries were additive.

The bounded taxonomy can distinguish stable safety/role, stable BTCC protocol,
current request, later corrections/obligations, Work/Ledger authority, memory,
phase continuity, tool schemas, latest result delivery, older replay, exact
views, Work recovery, source references, carrier overhead, and bounded other
typed context. No optimization, replay change, Work recovery change, context
bounding, or batching behavior was added.

## Authenticated real smoke

One direct scenario used the existing Electron driver with fresh isolated
Butler data, Electron profile, workspace, and App database. It used ordinary
`openai/gpt-5.6-sol`, reasoning `medium`, and the real configured auth route.
The final corrected implementation rerun was delivered in `4,206 ms`; renderer
text matched after reload. It was invoked from the repository root with this
fresh-root pattern (the driver refuses an already-created run root):

```sh
smoke_parent="$(mktemp -d /tmp/butler-m1-v2-final-smoke.XXXXXX)"
BUTLER_M1_V2_SEGMENT_ATTRIBUTION=1 bun run tests/e2e/btcc-r3-electron-driver.ts \
  --scenario tests/support/m1-v2-segment-attribution-smoke.json \
  --run-root "$smoke_parent/run" --source-data "$HOME/.butler" \
  --model openai/gpt-5.6-sol --reasoning medium --access-mode read_only --keep-logs
```

The driver observed one semantic Agent request and two auxiliary product
requests. All three physical provider attempts completed with HTTP 200:

| request | provider-send bytes | segment sum | response usage rows |
| --- | ---: | ---: | ---: |
| Agent | 35,447 | 35,447 | 1 |
| title | 624 | 624 | 1 |
| auxiliary | 1,123 | 1,123 | 1 |
| total | 37,194 | 37,194 | 3 |

There were 3 envelopes, 14 segment rows, and 3 usage rows. Aggregate segment
bytes were: carrier overhead 7,278; other typed context 1,419; stable safety/role
374; stable BTCC protocol 10,096; memory context 10,429; tool schema 7,489;
accepted corrections/unresolved obligations 50; current request 59.

The Agent attempt alone carried `armId=direct-smoke` and matched the explicit
Session benchmark cache boundary `m1-smoke-v2`. Its other share was
`334 / 35,447 = 0.942%`. Title and auxiliary attempts were still observed as
physical attempts, but had `armId=null`: their product-owned inputs do not carry
the Session/BTCC arm metadata and no typed source manifest was invented for them.
Accordingly their unknown payload bytes are honestly `other_typed_context`.
Across all three attempts, including those two unarmed requests, other was
`1,419 / 37,194 = 3.815%`, above 2%. The Spec arm gate applies only to attempts
explicitly bound to that arm; unarmed title/auxiliary attempts remain in path and
privacy coverage but are not mixed into corrected arm acceptance.

The former 958-byte corrections figure was an attribution error. Exact carrier
paths leave only 50 bytes in corrections/obligations for the Agent's dynamic
response-language directive; untyped title/auxiliary inputs now contribute to
bounded other instead.

Work/Ledger authority, phase continuity, latest/older tool results, exact views,
Work recovery receipts, and source references were each zero in this direct
no-tool smoke. Zero means the typed source was absent from this physical carrier,
not merged into memory, instructions, or `other_typed_context`. Their nonzero
classification is covered by an actual BTCC agent-loop -> OpenAI adapter ->
three-fetch Codex cumulative regression, plus an official Responses continuation
regression. Assistant messages do not shift provider input paths. Real
nonzero web/landing coverage remains gated with the missing baseline scenarios.

Completed provider usage was prompt `6,693 + 79 + 194 = 6,966`, cache-read 0,
cache-write 0, and total `6,769 + 89 + 291 = 7,149` tokens. Provider output and
reasoning token fields were unavailable and remained `null`, not zero. There
were no provider retries in this smoke. It is post-implementation smoke evidence,
not a corrected pre-change baseline repetition.

## Privacy and rollback evidence

Digests use an installation-local random HMAC key stored with mode 0600; the key
is never emitted. First creation writes, fsyncs, closes, and validates a private
temporary key before atomic no-replace publication. A concurrent loser reads the
complete winner; invalid or crash-stale final files fail closed without a weak
key. Metrics contain only bounded identifiers, keyed digests,
enums, and finite non-negative counters. A scan of the smoke metric file found
zero occurrences of the known raw prompt, raw Turn id, private run path,
credential marker, or URL. Tests also verify that raw tool names and Unicode
request content do not appear in persisted rows.

Flag-off returns exact `JSON.stringify(body)` with no v2 observation. The code
does not store raw prompts, transcripts, tool payloads/results, URLs/queries,
private paths, credentials, or unkeyed low-entropy hashes.

## Corrected baseline and hypotheses

| arm | accepted | rejected | gated | blocker |
| --- | ---: | ---: | ---: | --- |
| direct-cold | 0 | 0 | 3 | frozen pre-change scenario/run recipe not fully retained |
| direct-warm | 0 | 0 | 3 | exact warmup/session/cache composition not retained |
| current-web-cold | 0 | 0 | 3 | authoritative dated scenario and source rubric not retained |
| landing-cold | 0 | 0 | 3 | exact runner recipe absent; historical run also encountered a DB lock |

Accordingly no corrected baseline median/range, reducible share, completed
semantic-round distribution, retry rate, or cache variance is claimed. The
historical ordinary-medium v1 evidence remains descriptive only: 30 completed
semantic requests across the selected post target arms, four failed requests,
188,083 retry bytes (8.057% of attempted bytes), and materially different
cache-read totals between pre and post. Those historical figures justify
keeping retry and cache eligibility separate; they do not satisfy v2 baseline
acceptance.

The 30% byte, 45-to-38–40 request, and 18–30% elapsed figures remain hypotheses.
They cannot be frozen into corrected hard slice targets until the required
three accepted repetitions per arm provide segment medians/ranges, completed
semantic rounds, retries, and cache-matched eligibility. The Spec is not
relaxed.

## Validation

- New v2 attribution tests: 14 passed, including exact UTF-8 sum, default-off,
  privacy, terminal eligibility, nonce identity, duplicate exact paths,
  surrogate/JSON edge cases, eight-process atomic key publication, nullable
  usage, combined route/provider retry hierarchy, product-carried cache evidence,
  official requestItems paths, and cumulative older/current typed deliveries
  through the real BTCC/OpenAI fetch path.
- Guided real-ingress manifest coverage plus related Guided tests: 63 passed.
- Related provider admission/progress tests: 20 passed.
- The pre-review combined targeted run passed 98 tests; after review fixes the
  final combined targeted gate passed 107/107 tests (599 assertions).
- Authenticated Electron direct smoke: passed, real provider and reload verified.
- Windows CI was not run.
- Typecheck and lint passed. Full lint reported 24 existing warnings and no
  errors; targeted changed-file lint was clean.
- BTCC source shape passed (`4 domains / 210 files`); `git diff --check` passed.
- The repository-wide `bun run check` wrapper reached its 301-second process
  limit and terminated the still-passing test run with SIGTERM. This is recorded
  as a timeout gate, not as a passing whole-repository check or a test failure.
- Final independent ordinary `gpt-5.6-sol` high re-review: **APPROVE** for the
  attribution implementation slice, with no actionable P0-P3 findings. The
  reviewer independently passed 77 core and 30 additional related tests and
  confirmed the stored smoke arithmetic, row cardinality, privacy scan, and
  installation-key mode. This approval does not satisfy the missing baseline.
- Project Ledger index plus dashboard, handoff, and roadmap renders completed;
  final status was non-stale and `check --verbose` passed with zero issues.

## Remaining hard blockers

1. Restore or re-authorize the exact frozen four scenarios and direct-warm/cache
   recipe, then run at least three accepted isolated repetitions per arm at the
   pre-change revision.
2. Separate retry/cache-ineligible observations and compute arm medians/ranges,
   completed semantic rounds, reducible segment share, and variance.
3. Complete the parent whole-task review after the corrected baseline evidence
   exists; the implementation-only Sol-high re-review is approved.

Until those gates close, `T-M1-V2-SEGMENT-ATTRIBUTION`, the Work, and the Plan
remain open. No default-on or subsequent M1 implementation is authorized.
