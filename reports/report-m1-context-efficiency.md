# M1 context efficiency — SC01 attribution authority

Date: 2026-08-12
Task: `T-M1-V2-SEGMENT-ATTRIBUTION`
Governing spec: `SPEC-M1-CONTEXT-EFFICIENCY` revision 2

## Status and authority boundary

PR #146 owns only production SC01 provider-request attribution, focused product
tests, and the smallest authenticated Electron smoke wiring. The accepted
implementation source before benchmark-domain cleanup is
`049b24d0edd988cf058c81fd49661d44963e2e20`.

PR #142 at `b2fa611be89a2f5b2c9c39c364995d7d8a6c51e8` and
`tests/support/agent-benchmark` are the sole fixture, provenance, campaign
planning, orchestration, eligibility, evaluation, and report authority. This
branch no longer contains an executable M1 baseline runner, fixture authority,
provenance command, aggregate schema, or wrapper alias.

The Segment Task remains done. The governing Work and Plan remain active and
`T-M1-V2-FINAL-BENCHMARK` remains todo. No final 4x3, Hermes/OpenCode run,
provider-token rerun, default-on change, merge, or optimization Task is part of
this cleanup.

## Retained production path

The real path is:

`Session Actor -> guided Turn prompt attribution -> runBtccAgentLoop ->
createModelRoutePort -> runOpenAIModelRound -> createOpenAIResponse ->
withModelApiRetry -> createOpenAIResponseOnce -> official Responses or Codex
request-body conversion -> exact final JSON serialization -> fetch -> response
usage observation`.

The default-off `BUTLER_M1_V2_SEGMENT_ATTRIBUTION` flag is read only at the
final observation boundary. Disabled or failed observation returns the same
serialized request and cannot veto, retry, reroute, or alter a Turn. Route
transport and provider retry ordinals remain separate and typed. Successful
retry or route fallback is recorded as contamination rather than eligibility.

Each physical dispatch records at most one terminal
`butler.m1-request-envelope.v2`, mutually exclusive
`butler.m1-request-segment.v2` rows whose UTF-8 bytes sum to the exact serialized
request, and at most one nullable `butler.m1-response-usage.v2`. Failed physical
attempts retain their terminal envelope. Exact carrier paths and UTF-16 spans
are bound while official Responses or Codex cumulative input is assembled; the
implementation does not infer attribution by substring search.

The typed taxonomy preserves stable role/safety, stable BTCC protocol, current
request, corrections/obligations, Work/Ledger authority, memory, phase
continuity, tool schema, latest result delivery, older replay, exact views,
Work recovery, source references, carrier overhead, and bounded other context.
No optimization, prompt replay, Work recovery, context bounding, or batching
policy is implemented by SC01.

## Retained smoke authority

`tests/support/m1-v2-segment-attribution-smoke.json` is the only #146 smoke
fixture. It composes the existing
`tests/e2e/btcc-r3-electron-driver.ts` product primitive and carries the
`direct-smoke` arm plus exact `m1-smoke-v2` cache-boundary identity. It is not a
campaign runner or benchmark fixture authority.

The accepted authenticated smoke ran once at source
`049b24d0edd988cf058c81fd49661d44963e2e20` with fresh isolated Butler data,
Electron profile, workspace and App database, ordinary non-fast
`openai/gpt-5.6-sol` reasoning `medium`, `read_only`, and the configured auth
route. It exited 0, delivered in 5,305 ms, and matched the renderer final after
reload.

The observation contained three HTTP-200 physical attempts:

| request | provider-send bytes | segment sum | usage rows |
| --- | ---: | ---: | ---: |
| Agent | 34,099 | 34,099 | 1 |
| title | 624 | 624 | 1 |
| auxiliary | 1,166 | 1,166 | 1 |
| total | 35,889 | 35,889 | 3 |

There were 3 envelopes, 14 segment rows, and 3 usage rows with zero byte-sum,
duplicate-envelope, or duplicate-usage mismatch. The Agent attempt matched the
explicit arm and cache boundary. Its bounded other share was
`339 / 34,099 = 0.994%`. Title and auxiliary attempts remained observed but
unarmed and were not mixed into arm acceptance.

Provider usage was prompt 6,834, cache-read 0, cache-write 0, and total 7,004.
Provider output and reasoning fields were unavailable and remained `null`, not
zero. All 20 M1 rows had `rawTextStored=false`; exact-needle scans found no raw
prompt, final, Turn ID, private run path, URL/query, or credential marker.

The dedicated smoke may be reproduced only when explicitly authorized, using
the existing Electron driver and this one smoke JSON. It must not be treated as
a baseline repetition or statistical acceptance result.

## Product attribution repair evidence

The immutable first landing observations exposed missing ownership for
provider-generated function-call `name` and `arguments` in Codex stateless
continuations. The repair binds those exact carrier paths as dynamic
`phase_continuity`; structural fields remain carrier overhead.

A focused BTCC-to-OpenAI three-fetch regression reproduces a 5 KB continuation
and verifies that phase continuity receives those bytes while bounded other
stays below 1 KB. A historical authenticated landing repair smoke then observed
27 eligible Agent attempts, 3,410,224 exact provider bytes, and 4,023 other
bytes (0.118%), with zero byte/cardinality mismatch. This is production-path
attribution evidence only. Its then-current build/visual/basic Work assessment
does not satisfy the later frozen quality/safety rubric owned by PR #142.

## Privacy and non-interference

Attempt digests use an installation-local random HMAC key stored with mode
0600. The key and raw input are never emitted. Observer-off tests verify that
the exact JSON is preserved and the private physical-attempt header is absent.
Observer-on tests verify capture at the product proxy and removal before
upstream forwarding. Persisted metrics contain bounded identities, keyed
digests, enums, and finite counters only—never raw prompts, transcripts, tool
payloads/results, URLs/queries, credentials, hidden reasoning, or private
paths.

Observation cannot change provider routing, retry policy, cache behavior,
request bytes, terminal state, or product completion policy. Invalid identity,
byte partition, usage, or carrier evidence fails closed for measurement without
becoming product control flow.

## Immutable historical evidence

All prior campaigns and smokes remain provenance only:

- First Butler M1 campaign: 12 observations, historical runner labels
  `9 accepted / 3 rejected / 0 gated`. The later frozen rubric makes every
  label ineligible for final acceptance; no result is reclassified here.
- Landing repair smoke: attribution and product-path evidence only, not a
  replacement campaign repetition.
- Second campaign: `3 accepted / 0 rejected / 1 gated`, followed by 8
  unscheduled observations after an archive-extraction infrastructure timeout.
  The unscheduled observations are not fabricated as gated or failed.
- PR #142 compact cross-agent campaign: all 12 observations remain rejected and
  unranked. No winner or accepted-result-per-token comparison is inferred.

The deleted #146 runner, fixtures, provenance metadata, local commands, and
aggregate implementation are recoverable from
`recovery/m1-v2-segment-attribution-pre-unification-20260812` at
`2b22e90f51274744ef0f4d9d99cc0762a52024b4`. They are not current executable
authority. Canonical fixture hashes, JSONL provenance verification, eligibility,
quality rubric, campaign manifest, and reporting now live only in PR #142.

## Validation history and cleanup gates

The accepted SC01 implementation previously passed:

- focused exact-byte, nullable usage, retry/cache/route and privacy tests;
- authenticated real Electron/App/BTCC/provider smoke;
- typecheck and lint with zero errors;
- BTCC shape and module/provider boundary audits;
- independent ordinary non-fast Sol-high review with no actionable P0-P3
  findings for the Segment implementation boundary.

Cleanup validation on the final source tree:

- affected exact-byte/privacy/nullable usage, proxy, real-driver composition,
  Guided Turn, and authority tests: 79/79 passed with 442 assertions;
- BTCC/provider module-direction tests: 26/26 passed with 3,622 assertions;
- full typecheck passed;
- full lint passed with zero errors and 19 unrelated existing warnings;
- BTCC source shape passed (`4 domains / 205 files`);
- `git diff --check`, absent duplicate tree/import/script, retained product diff,
  and report authority checks passed;
- the architecture audit script scanned 162 existing product source files and
  reported 31 size/index/generic-bucket review triggers. This cleanup changes
  none of those product files; executable module-direction tests passed;
- bounded repository-wide `bun run check` reached its 301.01-second wrapper
  timeout and was terminated with SIGTERM. No changed attribution, smoke, or
  cleanup failure appeared in the captured tail, so this is not reported as a
  pass.

A fresh independent ordinary non-fast Sol-high review of the final #142 and
#146 ownership boundary remains required before PR #146 returns to ready.

## Remaining ownership

- PR #146: production SC01 attribution, privacy/non-interference, exact-byte and
  nullable-usage tests, and one bounded real smoke composition.
- PR #142: sole benchmark harness and `T-M1-V2-FINAL-BENCHMARK` authority.
- PR #147: stacked audit record; unchanged by this cleanup.
- Next optimization Tasks: depend on PR #142 preregistered affected-arm pairs
  and must not run the full 4x3 before the Final Benchmark Task.
