# M1 Context Efficiency — corrected v2 Task 1 report

Date: 2026-08-11
Task: `T-M1-V2-SEGMENT-ATTRIBUTION`
Governing Spec: `SPEC-M1-CONTEXT-EFFICIENCY` revision 2

## Status

**PARTIAL / FIRST CAMPAIGN PRESERVED, ATTRIBUTION REPAIR PENDING RE-CAMPAIGN.**
The exact-source authenticated campaign completed all 12 fixed observations:
`9 accepted`, `3 rejected`, `0 gated`. Direct-cold, direct-warm, and
current-web-cold each supplied three accepted repetitions. All three
landing-cold repetitions were honestly rejected because
`other_typed_context` was 22.846–24.698%, above the Spec's 2% ceiling. No result
was replaced or rerun.

The rejection exposed an observation defect, not a product-quality failure:
Codex stateless continuation omitted exact manifests for provider-generated
function-call `name` and `arguments` paths. The bounded repair now classifies
those provider-authored action-history bytes as dynamic `phase_continuity`; an
authenticated landing smoke subsequently passed at 0.118% other. The first
campaign remains immutable evidence. A new phase-commit SHA and full fixed 4x3
campaign are still required, so this Task is not complete and no later M1 v2
Task may start.

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
The restored fixtures/runner and first campaign source were phase-committed as
`93ee0079c6f80891ccbb71d559fd2d5a39dd8769`.

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

The first campaign used:

```sh
bun run benchmark:m1-v2-segment-attribution -- \
  --output-root /tmp/butler-m1-v2-campaign.Pkteqw/output \
  --source-data "$HOME/.butler" --repetitions 3 \
  --source-revision 93ee0079c6f80891ccbb71d559fd2d5a39dd8769
```

Its manifest is `/tmp/butler-m1-v2-campaign.Pkteqw/output/manifest.json`, the
privacy-safe aggregate is the adjacent `campaign.json`, and all 12 isolated raw
run directories remain beneath that output root. The aggregate privacy flags
are all false for raw prompt, raw final, raw tool payload, URL/query, private
path, credential, and generated-content hash storage.

Across those 12 isolated metric files there were 105 envelopes, 939 segment
rows, and 105 usage rows. A digest-grouped audit found zero exact byte-sum
mismatches, duplicate envelopes, or duplicate usage rows.

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
nonzero web and landing coverage was subsequently exercised by the canonical
campaign described below.

Completed provider usage was prompt `6,693 + 79 + 194 = 6,966`, cache-read 0,
cache-write 0, and total `6,769 + 89 + 291 = 7,149` tokens. Provider output and
reasoning token fields were unavailable and remained `null`, not zero. There
were no provider retries in this smoke. It is post-implementation smoke evidence,
not a corrected pre-change baseline repetition.

### Landing attribution defect and repair smoke

The immutable first campaign made the missing ownership visible. Landing
Agent round 0 contained only 163 other bytes (0.386%). As the Codex stateless
carrier accumulated provider-generated function calls, rep 1 other grew to
33,576 bytes at round 7 and 45,646 bytes at round 22; rep 2 ended at 37,992
bytes and rep 3 at 40,967 bytes. The exact source path was:

`provider response.output function_call -> functionCallContinuationItems ->
Codex statelessInput -> next request input[index].name|arguments`.

The request bodies retained those provider-generated items, but the saved
continuation manifest retained only the preceding input/result paths. Therefore
the serializer correctly fell back to `other_typed_context` for the unmanifested
`name` and `arguments` strings. `type` and `call_id` remained structural carrier
overhead. The repair appends exact manifests at the provider-response boundary.
The two semantic fields are dynamic `phase_continuity`: they are prior
provider-authored assistant actions required to pair subsequent tool outputs,
not current prompt, tool schema, Butler tool result, source reference, or
provider JSON punctuation.

A failing real BTCC -> OpenAI three-fetch regression first reproduced the gap
with a 5 KB function-call argument. After the repair, phase continuity exceeded
5 KB and bounded other stayed below 1 KB. The authenticated canonical landing
smoke used a fresh isolated root and the same ordinary Sol-medium product path:

```sh
BUTLER_M1_V2_SEGMENT_ATTRIBUTION=1 \
BUTLER_M1_SOURCE_REVISION=working-tree-phase-continuity-smoke \
BUTLER_MODEL_API_RETRY_ATTEMPTS=3 \
bun run tests/e2e/btcc-r3-electron-driver.ts \
  --scenario tests/support/m1-v2-baseline/fixtures/landing-cold.json \
  --run-root /tmp/butler-m1-v2-landing-fix-smoke.RdBrF1/run \
  --source-data "$HOME/.butler" \
  --model openai/gpt-5.6-sol --reasoning medium \
  --access-mode full_access --keep-logs
```

The driver exited 0. The bounded assessment accepted the smoke with 27 Agent
attempts/rounds, all eligible, no retry bytes, exact total 3,410,224 provider
bytes, and 4,023 other bytes (0.118%). Phase continuity was 707,086 bytes;
latest result delivery 990,011; older replay 497,365; carrier overhead 367,098.
Across the Agent plus one title request there were 28 envelopes, 322 segment
rows, and 28 usage rows, with zero byte mismatches or duplicate envelope/usage
cardinality. Build, desktop/mobile render and
screenshots, changed starter files, Butler grounding, 11 feature blocks, usage
scene, CTA, responsive CSS, Work completion/reviews/validation, and SQLite
quick-check all passed. This is post-repair smoke evidence, not a replacement
for any first-campaign repetition or the required second fixed campaign.

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
| direct-cold | 3 | 0 | 0 | 3 | accepted |
| direct-warm | 3 | 0 | 0 | 3 | accepted |
| current-web-cold | 3 | 0 | 0 | 3 | accepted |
| landing-cold | 0 | 3 | 0 | 3 | rejected: attribution coverage defect |

Accepted-arm aggregate values are medians with `[min, max]` ranges:

| arm | provider bytes | reducible share | rounds | tools | elapsed ms | first useful ms | other share reps |
| --- | --- | --- | --- | --- | --- | --- | --- |
| direct-cold | 37,560 `[37,560, 37,560]` | 77.212% `[77.212, 77.212]` | 1 `[1,1]` | 0 | 3,810 `[3,412,6,890]` | 114 `[90,148]` | 0.871%, 0.871%, 0.871% |
| direct-warm | 38,199 `[38,198,38,202]` | 77.539% `[77.538,77.540]` | 1 `[1,1]` | 0 | 4,415 `[3,823,5,810]` | 78 `[64,90]` | 0.856%, 0.856%, 0.856% |
| current-web-cold | 168,785 `[129,562,186,257]` | 72.148% `[71.843,73.572]` | 4 `[3,4]` | 4 `[3,4]` | 24,378 `[23,956,31,922]` | 107 `[88,116]` | 1.652%, 1.424%, 1.643% |

Provider usage remained nullable. Prompt/cache-read/cache-write/output/reasoning/
total token aggregates were respectively:

| arm | prompt | cache read | cache write | output | reasoning | total |
| --- | --- | --- | --- | --- | --- | --- |
| direct-cold | 7,186 `[7,186,7,186]` | 0 `[0,6,656]` | 0 | unavailable 3/3 | unavailable 3/3 | 7,211 `[7,210,7,216]` |
| direct-warm | 7,399 `[7,394,7,401]` | 0 `[0,6,656]`; reps `0, 6,656, 0` | 0 | unavailable 3/3 | unavailable 3/3 | 7,426 `[7,422,7,429]` |
| current-web-cold | 33,218 `[25,707,38,810]` | 13,312 `[6,656,13,312]` | 0 | unavailable 3/3 | unavailable 3/3 | 33,859 `[26,391,39,643]` |

All 17 accepted-arm Agent physical attempts were eligible. Retry-contaminated
attempts, retry rate, and retry bytes were all zero. Cache-read variance is
shown rather than hidden: cold and warm observations both contained a provider
cache-read outlier despite matched benchmark boundary evidence, so later causal
comparison must stratify actual cache usage as well as typed eligibility.

Unarmed physical overhead was retained separately from Agent acceptance:

| arm | auxiliary attempts/bytes | title attempts/bytes | tool-provider attempts/bytes |
| --- | ---: | ---: | ---: |
| direct-cold | 3 / 3,011 | 3 / 1,830 | 0 / 0 |
| direct-warm | 3 / 3,014 | 3 / 1,893 | 0 / 0 |
| current-web-cold | 3 / 4,886 | 3 / 2,124 | 0 / 0 |
| landing-cold | 1 / 1,886 | 3 / 2,592 | 0 / 0 |

Representative accepted segment medians `[min,max]` were:

| kind | direct-cold | direct-warm | current-web-cold |
| --- | --- | --- | --- |
| stable BTCC protocol | 9,699 `[9,699,9,699]` | 9,699 `[9,699,9,699]` | 38,796 `[29,097,38,796]` |
| memory recall | 10,434 `[10,434,10,434]` | 11,052 `[11,051,11,055]` | 41,776 `[31,332,41,776]` |
| tool schema | 8,491 `[8,491,8,491]` | 8,491 `[8,491,8,491]` | 33,964 `[25,473,33,964]` |
| older result projection | 0 | 0 | 6,654 `[5,295,16,425]` |
| source reference | 0 | 0 | 9,086 `[8,607,16,792]` |
| carrier overhead | 8,412 `[8,412,8,412]` | 8,412 `[8,412,8,412]` | 34,692 `[26,280,35,040]` |
| bounded other | 327 `[327,327]` | 327 `[327,327]` | 2,652 `[2,129,2,788]` |

Across first-campaign Agent attempts, 12 kinds were nonzero: stable safety/role,
stable BTCC, current request, corrections/obligations, Work/Ledger, memory,
tool schema, latest result, older replay, source reference, carrier, and other.
`phase_continuity` was incorrectly zero there and is the repaired coverage gap;
it was nonzero in the authenticated repair smoke. `exact_result_view` and
`work_recovery_receipt` remained zero because no canonical scenario invoked
those source types; their exact-path nonzero behavior remains covered by the
real BTCC/OpenAI multi-round regression rather than invented campaign bytes.

The three rejected landing observations were still preserved in full and were
not used to fabricate accepted medians:

| rep | Agent attempts/rounds | provider bytes | other share | reducible share | tools | elapsed ms | first useful ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 23 / 23 | 2,622,777 | 24.698% | 87.960% | 27 | 344,205 | 178 |
| 2 | 17 / 17 | 1,453,388 | 24.583% | 84.982% | 18 | 279,419 | 207 |
| 3 | 25 / 25 | 2,624,015 | 22.846% | 87.115% | 26 | 328,374 | 155 |

All 65 landing Agent attempts were eligible with zero retry bytes and exact byte
sums. Every landing quality, Work/review/validation, and DB quick-check rubric
passed. The sole rejection reason was the now-diagnosed `other` ceiling. Landing
prompt totals were 497,346 / 290,234 / 490,933; cache reads 186,880 / 163,840 /
283,648; totals 512,152 / 302,497 / 504,167. Cache write was zero and provider
output/reasoning usage remained unavailable, not zero.

The 30% byte, 45-to-38–40 request, and 18–30% elapsed figures remain hypotheses.
The accepted arms now suggest a 72.1–77.5% reducible byte share, while substantial
landing Work showed 17–25 completed semantic rounds and 84.98–87.96% apparent
reducible share before the manifest repair. These are attribution inputs, not
permission to freeze or relax targets: landing still lacks three accepted
phase-committed repetitions, and cache variance must be controlled in the final
comparison. The Spec is not relaxed.

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
  and every prompt/landing byte comparison. The fixed first campaign completed
  12/12 observations at exact source `93ee0079`; its result was 9/3/0.
- Post-campaign attribution repair gate: 131/131 related tests passed with 765
  assertions. Full typecheck, BTCC shape (`4 domains / 205 files`), changed-file
  lint, and `git diff --check` passed. Full lint had zero errors; only existing
  warnings remained after the three new comma-style warnings were removed.
- Authenticated canonical landing repair smoke: driver exit 0 and bounded
  assessment accepted; 27/27 eligible attempts, exact byte sum, 0.118% other,
  all landing quality/Work/DB checks passed.
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

1. Phase-commit the exact-path phase-continuity repair, then execute a second
   fixed 4x3 sequential isolated campaign at that exact SHA. Preserve the first
   9/3/0 campaign and every second-campaign status without replacement.
2. Require three accepted landing repetitions and recompute the all-arm
   medians/ranges, retry/cache strata, completed rounds, and reducible shares.
3. Complete independent review and the parent whole-task review on the repaired
   source plus accepted all-arm evidence. The earlier implementation-only
   Sol-high approval predates this bounded repair.

Until those gates close, `T-M1-V2-SEGMENT-ATTRIBUTION`, the Work, and the Plan
remain open. No default-on or subsequent M1 implementation is authorized.
