# M1 Context Efficiency — corrected v2 Task 1 report

Date: 2026-08-11
Task: `T-M1-V2-SEGMENT-ATTRIBUTION`
Governing Spec: `SPEC-M1-CONTEXT-EFFICIENCY` revision 2

## Status

**SEGMENT TASK DONE; WORK AND PLAN REMAIN ACTIVE; FINAL BENCHMARK IS TODO.**
The governing acceptance boundary separates SC01 production
instrumentation from statistical campaign acceptance. This Task owns the real
Session Actor -> BTCC -> provider serialization/fetch -> operational metrics
path, physical-attempt cardinality, exact additive bytes, typed coverage,
nullable usage, privacy/non-interference, arm-tagged authenticated smoke, gates,
and independent Sol-high implementation approval. It does not require a 4x3
campaign or a statistical reduction result.

The exact accepted implementation source is
`049b24d0edd988cf058c81fd49661d44963e2e20`. The final independent ordinary
non-fast `gpt-5.6-sol` high rereview found no actionable P0-P3 findings and
returned **APPROVE** for this implementation boundary. The governing Work and
Plan stay active, `T-M1-V2-FINAL-BENCHMARK` stays `todo`, and the Segment Task
is accepted as `done`.

The exact-source authenticated historical campaign completed 12 fixed
observations: `9 accepted`, `3 rejected`, `0 gated`. Direct-cold, direct-warm,
and current-web-cold each supplied three runner-accepted repetitions. All three
landing-cold repetitions were honestly rejected because
`other_typed_context` was 22.846–24.698%. No result was replaced or rerun. A
later review found the historical runner's quality/safety rubric incomplete, so
these labels are provenance only and do not satisfy final M1 acceptance.

The rejection exposed an attribution observation defect:
Codex stateless continuation omitted exact manifests for provider-generated
function-call `name` and `arguments` paths. The bounded repair now classifies
those provider-authored action-history bytes as dynamic `phase_continuity`; an
authenticated landing smoke subsequently measured 0.118% other. That smoke
passed the then-implemented build/visual/basic Work checks, but did not prove
the frozen Butler grounding or all-arms duplicate-effect, lost-correction,
required-anchor, workspace-authority, and stall contract. The first
campaign remains immutable evidence. The repair was phase-committed at
`07aea5f1019764e0509e5a0de9db725fe6521c8d`, but its second fixed campaign
stopped after `3 accepted / 0 rejected / 1 gated`: direct-warm rep 1 hit an
Electron-managed Agent archive-extraction infrastructure timeout before any
renderer observation. The remaining eight repetitions are unscheduled, not
fabricated as gated. This evidence and the archive repeatability issue are owned
by `T-M1-V2-FINAL-BENCHMARK`; they do not negate SC01 implementation acceptance
or block the next implementation Task.

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
first run it atomically creates a previously absent output root and writes
`manifest.json` with a campaign identity, exact 40-character source SHA,
fixture hashes, product
path, provider and route maximum attempts fixed at 3, no retry acceptance, and
no replacement runs. Every run root receives an exclusive reservation, and its
evidence must bind to the manifest run/scenario/session, target prompt hash,
source revision, exact run root, fresh timestamp, model, and reasoning mode;
preflight failures cannot reuse an old success file. Raw evidence remains
per-run; privacy-safe `campaign.json`
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

The phase-committed second campaign used the same bounded runner and policy:

```sh
bun run benchmark:m1-v2-segment-attribution -- \
  --output-root /tmp/butler-m1-v2-campaign-2.aPski3/output \
  --source-data "$HOME/.butler" --repetitions 3 \
  --source-revision 07aea5f1019764e0509e5a0de9db725fe6521c8d
```

Its stable manifest and aggregate references are
`/tmp/butler-m1-v2-campaign-2.aPski3/output/manifest.json` and the adjacent
`campaign.json`.

It preserved three accepted direct-cold repetitions, then stopped at the first
true infrastructure gate as required. The privacy-safe aggregate reports
`3 accepted / 0 rejected / 1 gated`, `complete=false`, and four observations;
the other eight scheduled observations were never run. Direct-cold provider
bytes were 37,564 `[37,564,37,564]`, reducible share 77.215%, one round and zero
tools each, elapsed 4,679 `[3,199,6,318]` ms, first useful 82 `[78,86]` ms, and
other 0.876% each. Prompt tokens were 7,192 each, cache-read was `0, 0, 6,656`,
cache-write zero, total 7,220 `[7,216,7,222]`, while output/reasoning remained
unavailable. All three Agent attempts were eligible with zero retry bytes.
Their unarmed overhead was auxiliary 3 / 3,017 bytes and title 3 / 1,830 bytes.
Across the three completed run metrics there were 9 envelopes, 42 segments, and
9 usage rows with zero byte-sum mismatches. All aggregate privacy flags remained
false for prohibited raw/private content.

Direct-warm rep 1 was recorded as `gated` with reason
`electron_or_setup_gate`; it had zero Agent attempts, so eligibility, cache,
quality, Work, and DB evidence are unavailable rather than zero. Its raw product
evidence error was `Electron exited before its renderer was ready: 0`. Read-only
diagnosis showed fresh debug/server ports and profile, a created
`DevToolsActivePort`, no surviving prior-rep/output-root process or listener,
and the previous Electron/executor PIDs already stopped. App-owned progress had
passed single-instance acquisition and Electron ready, then stopped at
`runtime_archive_extraction_starting`. The privacy-safe failure receipt recorded
`gateway_unavailable`; the runtime receipt rolled back with
`bundled Agent archive extraction timed out` at the fixed 60-second worker
timeout. The three preceding extractions activated in 12–13 seconds. Immediate
post-failure diagnosis measured the data volume at 99% utilized with 15 GiB
available and system load at 7.45 / 9.63 / 9.65 with unrelated high-CPU
processes. This supports a transient
host I/O/resource gate, not a demonstrated deterministic single-instance or
runner cleanup race. No rerun or speculative harness fix was made.

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

The final acceptance smoke ran once at exact source
`049b24d0edd988cf058c81fd49661d44963e2e20` with the existing Electron driver,
fresh isolated Butler data, Electron profile, workspace, App database, ordinary
non-fast `openai/gpt-5.6-sol`, reasoning `medium`, `read_only`, and the real
configured auth route. It was delivered in `5,305 ms`; renderer final text
matched after reload. The evidence records Electron renderer, preload bridge,
App gateway, native BTCC runtime, real provider, renderer-visible final, ordered
activity projection, and App database lifecycle in the actual product path.

It was invoked from the repository root with this fresh-root pattern (the driver
refuses an already-created run root):

```sh
smoke_parent="$(mktemp -d /tmp/butler-m1-v2-acceptance-smoke.XXXXXX)"
BUTLER_M1_V2_SEGMENT_ATTRIBUTION=1 \
BUTLER_M1_SOURCE_REVISION=049b24d0edd988cf058c81fd49661d44963e2e20 \
bun run tests/e2e/btcc-r3-electron-driver.ts \
  --scenario tests/support/m1-v2-segment-attribution-smoke.json \
  --run-root "$smoke_parent/run" --source-data "$HOME/.butler" \
  --model openai/gpt-5.6-sol --reasoning medium --access-mode read_only --keep-logs
```

The one authorized run exited 0 with `evidence.ok=true`. Its evidence is retained
at `run/evidence.json` beneath the fresh smoke root. The driver observed one
semantic Agent request and two unarmed product requests. All three physical
provider attempts completed with HTTP 200:

| request | provider-send bytes | segment sum | response usage rows |
| --- | ---: | ---: | ---: |
| Agent | 34,099 | 34,099 | 1 |
| title | 624 | 624 | 1 |
| auxiliary | 1,166 | 1,166 | 1 |
| total | 35,889 | 35,889 | 3 |

There were 3 envelopes, 14 segment rows, and 3 usage rows. Aggregate segment
bytes were: carrier overhead 7,230; other typed context 1,467; stable safety/role
374; stable BTCC protocol 9,697; memory context 10,435; tool schema 6,577;
accepted corrections/unresolved obligations 50; current request 59.

The Agent attempt alone carried `armId=direct-smoke` and matched the explicit
Session benchmark cache boundary `m1-smoke-v2`. Its other share was
`339 / 34,099 = 0.994%`, below the 2% SC01 smoke ceiling. Title and auxiliary
attempts were still observed as
physical attempts, but had `armId=null`: their product-owned inputs do not carry
the Session/BTCC arm metadata and no typed source manifest was invented for them.
Accordingly their unknown payload bytes are honestly `other_typed_context`.
Across all three attempts, including those two unarmed requests, other was
`1,467 / 35,889 = 4.088%`, above 2%. The Spec arm gate applies only to attempts
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

Completed provider usage was prompt `6,555 + 79 + 200 = 6,834`, cache-read 0,
cache-write 0, and total `6,635 + 89 + 280 = 7,004` tokens. Provider output and
reasoning token fields were unavailable and remained `null`, not zero. There
were no provider retries; all three envelopes were eligible and carried the exact
source revision. Digest-grouped analysis found zero byte-sum mismatches, duplicate
envelopes, or duplicate usage rows.

All 20 M1 rows had `rawTextStored=false`. Exact-needle scans of the M1 metrics
found zero raw prompt, raw final, raw Turn ID, private run path, URL/query, or
credential markers. The current default-off regression separately passed three
focused tests: absent flag preserves exact JSON and returns no observation, the
disabled provider request emits no private attempt header, and enabled partition
stores no raw content while covering every UTF-8 byte exactly once. This is
post-implementation SC01 smoke evidence, not a baseline or campaign repetition.

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

The driver exited 0. The then-current bounded assessment accepted the smoke with 27 Agent
attempts/rounds, all eligible, no retry bytes, exact total 3,410,224 provider
bytes, and 4,023 other bytes (0.118%). Phase continuity was 707,086 bytes;
latest result delivery 990,011; older replay 497,365; carrier overhead 367,098.
Across the Agent plus one title request there were 28 envelopes, 322 segment
rows, and 28 usage rows, with zero byte mismatches or duplicate envelope/usage
cardinality. Build, desktop/mobile render and
screenshots, changed starter files, Butler grounding, 11 feature blocks, usage
scene, CTA, responsive CSS, basic Work completion/reviews/validation, and SQLite
quick-check all passed. The later frozen-rubric review means this is attribution
and product-path evidence, not final landing quality acceptance. This is
post-repair smoke evidence, not a replacement for any preserved campaign
observation or final benchmark repetition.

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

## Historical campaigns and hypotheses

Both campaigns below are immutable provenance-only observations. They are not
the final M1 before/after 4x3 and are not Segment Task acceptance evidence.
`T-M1-V2-FINAL-BENCHMARK` owns frozen fixture/rubric authority, archive
extraction repeatability, missing-arm evidence, and the single final comparison.

First campaign at `93ee0079`:

| arm | accepted | rejected | gated | scheduled | state |
| --- | ---: | ---: | ---: | ---: | --- |
| direct-cold | 3 | 0 | 0 | 3 | accepted |
| direct-warm | 3 | 0 | 0 | 3 | accepted |
| current-web-cold | 3 | 0 | 0 | 3 | accepted |
| landing-cold | 0 | 3 | 0 | 3 | rejected: attribution coverage defect |

Second campaign at `07aea5f`:

| arm | accepted | rejected | gated | scheduled | state |
| --- | ---: | ---: | ---: | ---: | --- |
| direct-cold | 3 | 0 | 0 | 3 | accepted |
| direct-warm | 0 | 0 | 1 | 3 | stopped at rep 1 infrastructure gate |
| current-web-cold | 0 | 0 | 0 | 3 | unscheduled after gate |
| landing-cold | 0 | 0 | 0 | 3 | unscheduled after gate |

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
sums. The historical runner's build, visual, basic Work/review/validation, and
DB quick-check fields passed; it did not measure the Spec-level content grounding
or all-arms duplicate-effect/lost-correction/required-anchor/workspace-authority
contract. Therefore the recorded `other` ceiling was the sole reason emitted by
that historical runner, but it is not evidence that product quality had no other
governing gap. Landing
prompt totals were 497,346 / 290,234 / 490,933; cache reads 186,880 / 163,840 /
283,648; totals 512,152 / 302,497 / 504,167. Cache write was zero and provider
output/reasoning usage remained unavailable, not zero.

The 30% byte, 45-to-38–40 request, and 18–30% elapsed figures remain Work-level
hypotheses owned for final decision by `T-M1-V2-FINAL-BENCHMARK`.
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
- Authenticated canonical landing repair smoke: driver exit 0; 27/27 eligible
  attempts, exact byte sum, and 0.118% other. Its historical assessment passed
  the then-current build/visual/basic Work/DB checks, not the later frozen
  grounding and all-arms safety rubric.
- Phase-committed second campaign at exact `07aea5f`: 3 direct-cold accepted,
  then one direct-warm infrastructure-gated before renderer/Agent attempt; eight
  later observations remained unscheduled. No replacement run was attempted.
- Final post-gate validation repeated the 131 related tests (765 assertions),
  full typecheck, full lint (zero errors / 19 existing warnings), BTCC shape,
  authoritative JSONL provenance verifier, and `git diff --check`; all passed.
- The final repository-wide `bun run check` completed without timeout in
  282.90 seconds: 2,544 tests passed and one existing CLI-reference registry
  drift test failed (`butler-cli-docs.test.ts`). This Task changes neither the
  CLI registry nor its reference document, so the failure remains a disclosed
  whole-repository gate rather than being treated as a pass.
- A prior independent ordinary `gpt-5.6-sol` high review approved the narrower
  attribution implementation slice after passing 77 core and 30 additional
  related tests. The full-diff review then found stale evidence reuse risk, an
  incomplete governing quality/safety rubric, and positional unarmed-overhead
  accounting. The review-fix cycles below closed those findings and their
  follow-up false-accept cases. The final independent Sol-high rereview reports
  no actionable P0-P3 findings and **APPROVE** for the implementation. The Task
  is `done`; a canonical 4x3 is not part of Segment acceptance.
- Historical failed Attempts remain lifecycle provenance and are not current
  acceptance evidence. The authority reconciliation supersedes their campaign
  blocker as a Segment criterion without deleting or rewriting those records.
  The Segment Task is `done`; the governing Work and Plan remain active and the
  benchmark Task remains `todo`.

Current review-fix validation (no campaign run):

- baseline runner/quality/attribution regressions: 30/30 passed (133 assertions), including
  existing-output refusal, manifest-bound stale-success rejection, frozen
  landing/safety unavailable rejection, DB-backed correction/effect/anchor
  counts, and Agent/tool-provider interleaving;
- full typecheck passed;
- full lint passed with zero errors and 19 unrelated existing warnings;
- BTCC source shape passed (`4 domains / 205 files`);
- module boundary/provider architecture audit passed 18/18 tests (3,594
  assertions);
- `git diff --check` passed.

A second Sol-high review kept the verdict at **CHANGES_REQUIRED** because the
first fix still used global keyword co-occurrence, inferred correction/anchor
absence, and correlated physical rows by bytes/time. The follow-up fix replaces
those with five versioned approved Butler capability claim IDs whose required
elements must occur in one semantic page element and whose negation or known
misrepresentation fails. Accepted Work corrections are compared in-process
against their bound final plan/result/effect receipt carrier, and initial
governing-reference identities are compared with the final plan; only bounded
missing counts enter `campaign.json`, never correction, plan, result, or receipt
content. OpenAI official/Codex fetches now carry the installation-keyed
`attemptDigest` to the product observation proxy, which records it and strips
the private correlation header before upstream forwarding. Physical overhead
joins require that exact digest plus ordinal, serialized bytes, and terminal
time; ambiguous or missing identity fails closed. Equal-byte, equal-time
interleaving is covered. These changes were independently rereviewed. No
campaign was executed during any review-fix phase.
The final follow-up targeted gate passed 45/45 tests (201 assertions), including
observer-off header absence, observer-on retry header/envelope identity, proxy
upstream stripping, equal-byte/equal-time physical joins, approved-claim
negation/misrepresentation, and accepted-correction/governing-anchor omission.
Full typecheck passed; full lint again had zero errors and 19 unrelated existing
warnings; BTCC shape remained `4 domains / 205 files`; the module/provider audit
passed 18/18 tests (3,594 assertions); and `git diff --check` passed.

The subsequent final rereview reproduced two remaining quality false-accepts,
so the verdict remains **CHANGES_REQUIRED** pending another review. An accepted
plan correction now requires `bound_plan_revision_id` to equal the actual final
plan revision ID exactly; nonexistent or mismatched bindings fail even when the
final plan happens to contain the same bounded correction text. English scoped
negation and misrepresentation are rejected alongside Korean forms, and claim
elements split across nested semantic elements cannot satisfy one approved
claim. Focused regressions cover mismatched plan identity, English durable-Work
negation, unlimited-memory misrepresentation, and nested-section co-occurrence.
No campaign was run for this correction.

The next rereview found two further identity/boundary false-accepts, so the
verdict remains **CHANGES_REQUIRED**. Result-review corrections now require the
bound result sequence to equal the actual final result sequence. Completion
corrections additionally require exact final plan/result identities, the actual
latest result-review ID, a structurally equal final checkpoint action snapshot,
and valid applied-effect receipt ID/identity pairs before preservation is
considered. Bogus sequence `999` and bogus completion bindings fail even when
carrier content coincidentally matches. The production DOM extractor now admits
only explicit claim cards or leaf semantic elements; a parent section can no
longer combine split descendant paragraphs into a passing claim. English
automatic-completion-without-review, same-provider routing, and guaranteed
`100%` recovery claims are explicitly rejected. No campaign or commit was
performed for this correction.

The final independent ordinary non-fast `gpt-5.6-sol` high rereview found no
actionable P0-P3 findings. It independently confirmed the fresh-only runner,
manifest/source/run identity, exact digest/ordinal/bytes/time join, observer-off
header absence, observer-on proxy capture and upstream stripping, versioned
capability claims, production leaf/card DOM boundaries, and exact final
plan/result/review/action/effect-receipt preservation checks. Its implementation
verdict is **APPROVE** for the governing Segment implementation boundary. The
final targeted gate is 45/45 tests with 201 assertions, with typecheck, lint,
BTCC shape, module audit, and `git diff --check` passing.

The final authority reconciliation closes the Segment Task as `done`, keeps the
governing Work and Plan active, keeps `T-M1-V2-FINAL-BENCHMARK` `todo`, and
removes the historical campaign/archive gate from Segment acceptance. No
benchmark, archive diagnosis, Hermes/OpenCode run, merge, default-on change, or
Windows run is part of this closeout. Report commit and push follow in the
delivery step.

## Remaining Work ownership

- Segment attribution: implementation evidence and independent Sol-high
  approval are present at exact source
  `049b24d0edd988cf058c81fd49661d44963e2e20`; this Task is `done`.
- Final benchmark: `T-M1-V2-FINAL-BENCHMARK` owns the external archive-extraction
  repeatability gate, frozen fixtures/rubric, missing direct-warm/web/landing arm
  evidence, each optimization's preregistered affected-arm paired evidence, and
  one final before/after 4x3 with three accepted repetitions per arm. The
  preserved `9/3/0`, repair smoke, and `3/0/1 + 8 unscheduled` evidence cannot be
  substituted for that final decision.
- Work/Plan: remain active until SC01-SC08, the final quantitative/quality gates,
  and whole-goal review pass. No default-on or merge is authorized by this Task.
