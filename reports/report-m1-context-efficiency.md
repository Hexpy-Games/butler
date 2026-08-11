# M1 Context Efficiency — corrected v2 Task 1 report

Date: 2026-08-11
Task: `T-M1-V2-SEGMENT-ATTRIBUTION`
Governing Spec: `SPEC-M1-CONTEXT-EFFICIENCY` revision 2

## Status

**PARTIAL / CAMPAIGN PENDING.** The observation slice is implemented on the
production provider path, one authenticated direct smoke passed, and the four
canonical scenarios plus bounded real-product campaign runner are now restored.
The new corrected campaign has not run yet: `0 accepted`, `0 rejected`,
`0 gated`, and `12 scheduled`. Therefore this Task is not complete and no later
M1 v2 Task may start.

The former scenario-availability blocker is closed. The remaining gate is the
authenticated sequential four-arm campaign on the exact phase-commit SHA and
its independent review. No missing repetition is pre-labelled as gated.

## Source and fixture provenance repair

The old local/remote feature tip was `5e15095750288ac660b30f85f1076a4160294ad6`
with attribution commit `5b39d859ece425d27188f66e96951d54c97cd387`.
It incorrectly inherited 18 unrelated local-main commits after `dd19567b`.
Before repair, that exact state was preserved as
`recovery/m1-v2-pre-rebase-5e150957`. The two Task commits were then replayed
onto authoritative `origin/main` `65494154f6e9ddbfb20458bc67250c7d15b5d13d`
(which includes #141 and #143) as `2a299af7` and `7b109476`. Conflicts retained
current-main Session/workspace contracts and manually reintroduced only the
attribution fields; the unrelated 213-file source delta was not revived.

The authoritative source for the benchmark bodies is
`rollout-2026-08-10T14-23-27-019fea20-37ab-7780-a38b-ca33c846ef9e.jsonl`, not
the `/tmp` auxiliary copy. The tracked verifier JSON-decodes each exact
`response_item.payload.input`, checks its UTF-8 byte length and SHA-256, recovers
the added JSON body, and compares every prompt and landing starter byte with the
checked-in public benchmark fixtures:

| arm | authoritative timestamp | payload bytes | payload SHA-256 | target prompt SHA-256 |
| --- | --- | ---: | --- | --- |
| direct-cold | 2026-08-10T05:37:26.195Z | 628 | `8d2f5511825835c10cb1d5bd63cf41ac2071eb7b111d1d475f9abef568ccdb8d` | `3235f8b0c1704899168c9da7ed0cf466b052873f74fb0fe7e40cd95138a9c827` |
| direct-warm | 2026-08-10T05:39:42.966Z | 814 | `98598a14029c9fd810ef8576af50ad3504bcba08b56fa09ee84b12b308f4d17e` | `1c77b5e04e4e0539ee73078e5594ddbdec2a4feecac5889aaffc977c5ef1684b` |
| current-web-cold | 2026-08-10T05:41:31.789Z | 734 | `696617468e0277e614d5b72287fcf1cc520e580001f93da497bf210e9430f95e` | `1a005e359be608b217f2f7b9d11831fc96357be514a1b29b5f66441b4d293f2b` |
| landing-cold | 2026-08-10T05:43:23.720Z | 1,903 | `661cf5d91129b974382266d3174c891756688d1e83af0987a224654d4a29efdb` | `13abcbe43bb495137e2f01c9c2e824211dae7b189361fa3b2141b64781a054ff` |

The direct-warm public warmup prompt hash is
`3235f8b0c1704899168c9da7ed0cf466b052873f74fb0fe7e40cd95138a9c827`.
Landing starter hashes are package
`95ecbc5ceb44f1aef70447a3f32a53875f6ac518b3b6cc47d173cb6be7b15acc`,
index `a63afd07e728a2055133510f0cc1ad65140dd25ec495d342d6cce2e55d157dc1`,
and styles `f5fcb45b67a99855be1a908025d8bbdd3685c788f1ee391e741c9d988629dcd1`.
The source scenarios' `low` setting is provenance only. The canonical fixtures
preserve prompt/starter bytes but version the execution metadata to ordinary,
non-fast `openai/gpt-5.6-sol` reasoning `medium`.

The runner calls `runBtccR3ElectronHarness` directly. It schedules exactly
four arms by three repetitions, sequentially, with fresh Butler data, Electron
profile, Session, workspace, and SQLite state. Direct-warm keeps warmup and
target in one Session with matched expected/observed cache revision. Before the
first run it writes `manifest.json` with source SHA, fixture hashes, product
path, provider and route maximum attempts fixed at 3, no retry acceptance, and
no replacement runs. Raw evidence remains per-run; privacy-safe `campaign.json`
contains nullable usage ranges, segment medians/ranges, retry rate/bytes,
unarmed title/aux/tool-provider count/bytes, Work/DB/quality evidence, elapsed,
and first-useful timing without raw content or private paths.

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
nonzero web/landing coverage is pending the restored canonical campaign.

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

| arm | accepted | rejected | gated | scheduled | state |
| --- | ---: | ---: | ---: | ---: | --- |
| direct-cold | 0 | 0 | 0 | 3 | not run |
| direct-warm | 0 | 0 | 0 | 3 | not run |
| current-web-cold | 0 | 0 | 0 | 3 | not run |
| landing-cold | 0 | 0 | 0 | 3 | not run |

Accordingly no corrected campaign median/range, reducible share, completed
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
- The historical pre-rebase typecheck and lint passed; that full lint reported
  24 existing warnings and no errors.
- Rebased current-main runner/attribution gate: 72/72 tests passed with 428
  assertions, including 11 campaign tests, current-main Guided arm/cache
  propagation, exact carrier paths, typed failure classification, six nullable
  usage aggregates, retry bytes/rate, unarmed overhead bytes, and bounded
  Work/DB/quality evidence. Full typecheck, full lint (20 existing warnings,
  zero errors), changed-file lint, BTCC shape (`4 domains / 205 files`), and
  `git diff --check` passed.
- Authoritative JSONL verifier passed all four payload input byte/hash checks
  and every prompt/landing byte comparison. Campaign execution remains pending.
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

1. Phase-commit the restored runner and execute exactly three sequential,
   isolated observations per arm at that new exact SHA; preserve every
   accepted/rejected/gated outcome without replacement.
2. Separate retry/cache-ineligible observations and finalize arm medians/ranges,
   completed semantic rounds, reducible segment share, and variance.
3. Complete the parent whole-task review after the corrected baseline evidence
   exists; the implementation-only Sol-high re-review is approved.

Until those gates close, `T-M1-V2-SEGMENT-ATTRIBUTION`, the Work, and the Plan
remain open. No default-on or subsequent M1 implementation is authorized.
