# Delivery identity audit

Audited against `a1eae9119` (`origin/codex/win-fixes-5`). Paths below are
relative to `crates/`; line numbers refer to that base commit. This covers
native result delivery, final-turn recovery, operation-result replay, App
projection, conversation receipts, and project Work result references.

| Former content gate (file:line) | What it protected | Replacement |
| --- | --- | --- |
| `butler-turn/src/btcc/storage/hydration.rs:150` | Recovery of normalized legacy final JSON required equal payload refs, a matching raw hash and canonically equal text. Other differences fell through to a blocking lifecycle assertion. | Bind by payload id and turn id; use the outbox's durable text, warn on text/hash differences. |
| `butler-turn/src/btcc/storage/hydration.rs:386` | A final payload had to equal its outbox before any turn could be loaded/resumed. | Payload id and turn id; preserve checkpoint and observed/delivered lifecycle assertions. |
| `butler-turn/src/btcc/storage/transitions.rs:226` | Reject committing a different final payload/outbox. | Turn id, payload id, pending status, exact revision/checkpoint/claim/fence CAS; warn on content/hash differences. |
| `butler-turn/src/btcc/storage/transitions/records.rs:60` | Prevent overwriting a stored final record with different bytes/hash. | Record id and kind; first stored record wins, mismatch warning. |
| `butler-turn/src/btcc/storage/canonical.rs:59` | Prevent inserting from a changed outbox snapshot. | Outbox id, turn id, committed revision, payload id, expected message id, valid delivery state; mismatch warning. |
| `butler-turn/src/btcc/storage/canonical.rs:89` | Prevent duplicate canonical messages after insertion but before observation; reject conflicting message bytes. | Expected message id plus session/turn/role/delivery-key ownership; keep the stored message and warn. |
| `butler-turn/src/btcc/storage/tool_journal/read.rs:128` | Reject modified result bodies during paged closeout. | Turn/call ownership and journal ordering; hash mismatch warning; JSON parsing remains required. |
| `butler-turn/src/btcc/storage/tool_journal/read.rs:231` | Reject modified result bodies before tool replay or restart-request recovery. | Turn/call ownership and durable status; hash mismatch warning. |
| `butler-turn/src/btcc/storage/tool_journal/write.rs:101` | Repeated tool completion had to reproduce result/files/error bytes. | Call id and terminal status; preserve the first result and warn. |
| `butler-turn/src/btcc/storage/tool_journal/delivery.rs:84` | Repeated model acknowledgement had to carry the same response hash. | Turn id, round id and acknowledged/reference-only state; warn on differing response hashes. |
| `butler-turn/src/btcc/storage/operation_results/query.rs:225` | Project result replay required matching local/canonical hashes. | Canonical authority verifies result ref, revision, Work/session/scope, tool call and originating turn. Hash differences warn. |
| `butler-turn/src/btcc/storage/operation_results/query.rs:335` | Exact result reads required stored body hash equality. | Resolve by result/call identity and turn ownership; warn and return the requested complete byte range. |
| `butler-turn/src/btcc/storage/operation_results/query.rs:338` | Exact result reads required the caller's hash to match the stored hash. | Work revision/session/scope checks remain; differing hashes warn. |
| `butler-turn/src/btcc/storage/project_work_runtime/result.rs:71` | Project result attachment required a matching committed body hash. | Completed tool call owned by the specified session and originating turn; warn. |
| `butler-turn/src/btcc/storage/project_work_runtime/result.rs:138` | Result references had to match committed evidence hashes. | Tool call, origin turn, session, tool name, result ref and projection ownership; warn. |
| `butler-turn/src/btcc/storage/project_work_runtime/legacy/observe.rs:157` | Legacy result-reference vector equality included hashes and content fields. | Ordered result identities and revisions; count/order retained. |
| `butler-turn/src/btcc/storage/project_work_runtime/legacy/observe.rs:173` | Legacy result references required matching evidence hashes. | Result ref, call/origin/session/tool ownership; warn. |
| `butler-ledger/src/project_ledger/result_authority.rs:96` | Project exact-result replay required the input's content hash. | Result ref, sequence/revision, Work, session, scope, ledger project, tool call and turn; warn. |
| `butler-ledger/src/project_ledger/work/legacy.rs:249` | Canonical/legacy result-reference vector equality included hashes. | Ordered identities and revisions. |
| `butler-ledger/src/project_ledger/work/legacy.rs:264` | Legacy result attachment required matching committed hashes. | Result ref and tool-call/origin/session/tool ownership; warn. |
| `butler-ledger/src/project_ledger/work/write.rs:193` | Replayed immutable result-reference records required byte-identical bodies. | Result record id, Work parent, schema, scope, session, call, tool, origin and sequence. First result record wins; other immutable record kinds retain their rules. |
| `butler-turn/src/btcc/storage/subsession_result.rs:9` | Only a byte-identical result summary could inherit the delivered final's outcome. | Payload turn id equals result child turn id; cancellation remains authoritative. |
| `butler-gateway/src/gateway/application/projection/staging.rs:65` | A resent transport action had to reproduce its payload before projection could proceed. | Action id, chat/session, kind, transport and queue claim epoch; keep first staged payload, warn. |
| `butler-gateway/src/gateway/application/projection/non_final/operations.rs:273` | Output chunk publication rejected a content-hash mismatch. | Turn/request/result/chunk identity, valid encoding and contiguous byte ranges; warn. |
| `butler-gateway/src/gateway/application/projection/non_final/operations.rs:282` | Chunk replay compared content bytes and result/chunk hashes in SQL. | Turn/request/result/chunk index and layout; first stored chunk wins, warn. |
| `butler-gateway/src/gateway/application/projection/non_final/runtime_values/operation_chunk.rs:44` | Child output publication rejected mismatching chunk digests. | Request/result/chunk identity and valid encoding/ranges; warn. |
| `butler-gateway/src/gateway/application/operation_output/chunk.rs:124` | Output assembly required identical chunk result hashes. | Request/result identity and ordered contiguous chunks; warn. |
| `butler-gateway/src/gateway/application/operation_output/chunk.rs:144` | Output assembly rejected individual chunk hash mismatches. | Valid encoding, byte ranges and complete chunk count; warn. |
| `butler-gateway/src/gateway/application/operation_output/chunk.rs:177` | Output assembly required aggregate hash equality and a content-derived result id. | Persisted result id, ordered chunk count and full byte length; warn on aggregate mismatch. |
| `butler-gateway/src/gateway/application/operation_output/chunk.rs:228` | Child chunk hydration rejected differing hashes. | Request/result/chunk identity, encoding and byte ranges; warn. |
| `butler-turn/src/conversation/turn_outcome.rs:61` | Writing the same outcome generation required equal content/reference hashes. | Turn/session/generation and request/assistant message ids; keep first receipt, warn. |
| `butler-turn/src/conversation/turn_outcome.rs:236` | A changed referenced message made the stored outcome unavailable. | Load the durable turn receipt; warn on hash differences. |
| `butler-turn/src/conversation/admission/state.rs:194` | A resumed source message required byte-identical text/content parts. | Source message, turn and role ownership; keep stored content, warn. |
| `butler-turn/src/btcc/turn/preparation/request.rs:44` | Run/resume replay required equal original text/content parts. | Turn/session/trigger/message ids and authorized wake scope; warn. |
| `butler-turn/src/btcc/storage/admission.rs:93` | Storage replay required equal original text/content parts. | Turn/session/trigger/message ids and authorized wake scope; warn. |
| `butler-turn/src/btcc/storage/admission/inbound.rs:27` | Replaying an inbox trigger required matching admission content hashes. | Inbox session/trigger and turn id; first command wins, warn. |
| `butler-turn/src/btcc/storage/admission/inbound.rs:96` | Existing canonical inbound/result message required equal text. | Message id and session/turn/user-role ownership; warn. |
| `butler-turn/src/btcc/storage/admission/inbound.rs:130` | Wake replay required equal continuation text. | Trigger id, session/turn/source-turn/authorization ownership; warn. |
| `butler-turn/src/btcc/storage/admission/inbound.rs:183` | Wake-fact replay included content equality. | Trigger/source-turn/authorization/result-scope identity; warn. |
| `butler-gateway/src/gateway/application/admission.rs:206` | Re-delivered internal delegated results went through the public message digest check. | Internal relation/result ids and chat/client queue key; original stored controls remain authoritative, warn. Public user admission keeps its immutable input checks. |
| `butler-gateway/src/gateway/application/queue.rs:339` | Recovery of a terminal claim required admission hash presence and equal queue/message text and content parts. | Queue/message/turn/session ids, dispatched user message, recovery event and claim epoch; warn on content differences. |
| `butler-gateway/src/gateway/application/retry/source.rs:139` | Explicit retry required equal queue and projected user message text. | Turn/session/user message and dispatched queue message ids and inactive claim; warn on content differences. |

Hash presence/format also previously excluded result replay at
`butler-turn/src/btcc/storage/tool_journal/delivery.rs:15`,
`butler-turn/src/btcc/storage/operation_results/query.rs:57`,
`butler-turn/src/btcc/agent_loop/operation_result_replay/runtime/delivery.rs:122`,
`butler-turn/src/btcc/agent_loop/operation_result_replay/reference.rs:13`, and
`butler-turn/src/btcc/agent_loop/operation_result_replay/arguments.rs:34`.
Those gates are removed; stored result bodies and ownership remain required.
Final payload validation at `butler-turn/src/btcc/storage/hydration.rs:296`
also no longer requires nonempty diagnostic hashes.

## Stable identities and durability

New canonical outbox ids hash an **identity tuple**,
`btcc-canonical-delivery.v2 + turn_id + committed_revision`, without payload
content. Existing outbox ids and message ids are used verbatim; no migration
or rewriting of prior receipt keys is needed. Payload hashes stay as diagnostic
metadata and legacy record identifiers, never as equality gates for delivery.
New operation output ids likewise use the stable tool call id, lifecycle phase,
and approval request id for an authority-pending output
(`btcc-guided-tool-result.v2 + call_id + phase + request_ref`), replacing the content-derived id minted
at `butler-turn/src/btcc/agent_loop/progress.rs:69`. Legacy output ids remain
readable and do not need migration.
An approval-pending response and its later completed result are distinct
outputs, while replay of either keeps the same output id.

Final/outbox commit is still one transaction under the exact turn claim/fence.
Canonical message insertion, its unique turn/outbox receipt and `inserted` state
are another transaction. Observation remains a separate transaction. Therefore
crashing before insertion inserts once; crashing after insertion reuses the
same message and receipt. Gateway projection receipts remain keyed by action
id; stale queue claims remain fenced. Worker/steward results remain keyed by
child session/turn and relation/result, with durable pending/delivered state.

The owner's interruption policy stays in force: active input interrupted by a
crash requires explicit retry/resume; queued follow-ups survive and drain in
order. Delivery recovery does not repeat model work or tool effects.

## Other hashes reviewed

Content checks for workspace-file compare-and-swap, effect/authority request
identity, attachment authorization, executable/model asset integrity, historical
origin evidence, and cached compaction source freshness are separate security
or source-version checks. They do not decide whether a durable result/outbox
identity has already been delivered. They remain intact. File byte offsets,
chunk lengths, JSON/base64 validity, and Work-head CAS remain structural/version
checks, not comparisons of delivered content. No content or response fields
are truncated, dropped, or served from a stale cache to satisfy a budget.

## Regression evidence

`tests/e2e/outbox_identity.rs` is one stub E2E with two crash windows. It writes
Korean NFD output, stops the process before insertion or after insertion before
observation, changes stored payload text to NFC and changes both stored hashes;
the latter window also changes the existing canonical text to NFC. It restarts,
with differing NFC/NFD text in the admission message and queue as well,
explicitly resumes, replays the admission and restarts again. Both windows assert
one canonical message, one delivery receipt, observed outbox state, one App
answer with full original NFD bytes, one turn and exactly one model request.
No cassette is recorded or changed on disk, and no unit test is added.
The isolation script now also allocates a fresh `TMPDIR` per run, preventing
PID-named fixture directories from colliding when Linux reuses a process id;
the entire run directory is removed on exit.

Final Linux verification (stub/replay only, isolated HOME/data/temp):

- Library tests: 110 turn, 45 gateway and 4 ledger tests passed; no new unit tests.
- E2Es: 42 passed in 284.980 s, covering outbox identity, steward delivery/resume,
  crash recovery, active-turn plus queued-follow-up shutdown, queue admission,
  projection backlog/settlement, tools/effects, projects and turn continuation.
- Unicode crash/replay/restart sequences: 1.768 s before canonical insertion,
  2.302 s after insertion; each asserted one complete App answer, one canonical
  message, one receipt and one model request.
- `cargo fmt --check`, clippy on all targets of the four touched crates with
  `-D warnings`, the agent build and source-check passed. Source-check reported
  zero function-length, architecture, test-policy and E2E-gate violations.
- An intermediate E2E failure exposed approval-pending/completed output-id
  collision. Adding the lifecycle phase and approval request id fixed it;
  the unchanged authority restart E2E passed in the final full run.
