# Correct and forget explicitly remembered rules

Design for owner approval, 2026-10-02. No implementation is included.
Recommend a targeted revision of an existing rule through the remember tool,
plus a targeted forget tool and a settings list with Delete. Forget means
retained tombstone plus exclusion, not physical erasure.

## Evidence and present behavior

References below are relative to `packages/butler-agent/rust/crates/`, unless
prefixed with `repo:`. Current worktree baseline: `53fa0a313`. The supplied
audit was fetched read-only into `audit2-src`, verified as `842828ac2`.
Its report is `packages/butler-agent/rust/docs/memory-wiring-audit-2.md` on that
ref; its test is actually under `packages/butler-agent/rust/crates/butler-e2e/tests/memory_wiring_more.rs`.
The audit reports two active bindings and both values in the next Active Rules
prompt. Its correction test checks prompt/binding state, not recall exclusion.
Those are reported measurements, not tests rerun for this design.

| Path | What the code does today |
| --- | --- |
| `butler-runtime/src/capabilities/catalog/catalog.json:1` | Model-facing description: “Write an explicit durable rule memory with provenance. Use only for user corrections, explicit preferences, or durable instructions.” Schema is an object with `additionalProperties:false`; required `kind:"rule"`, `text:string` (“Explicit memory text.”), `source:string` (“Provenance summary, e.g. user correction message id.”). No target, replace or forget argument. Catalog calls it `turn_local`, concurrency unsafe, visible in transcript; the memory-write profile exposes it. |
| `butler-agent/src/host/guided/tools/memory_write.rs:33`, `:83`, `:120` | Access mode must allow MemorySave. Validates kind/text/source; actual provenance comes from the canonical authored user message, not the supplied source summary. Passes call ID as operation ID and server-bound project ID, but no record ID. Result at `:197` exposes record ID, revision, operation ID and replay status. |
| `butler-memory/src/cognition/sources/typed/write.rs:73`, `:85` | Library input already permits record ID (`:30`); absent ID becomes SHA-256 of `explicit-rule:<operation_id>`. Revision hashes record ID, content hash, project and conversation provenance (`:238`). Every distinct public save therefore creates a different record, including corrections. |
| `butler-memory/src/cognition/sources/typed/write.rs:106`, `:189` | Writes `<memory>/rules/<record_id>.md`, then `<record_id>.source.json`, with separate atomic private-file replacements. Binding contains active state, revision, operation ID, hash, project, authored session/message, observed time and operation history. These writes are not one multi-file transaction. This synchronous function does not itself acquire the consolidation lease. |
| `butler-memory/src/cognition/sources/typed/write.rs:224`, `:130` | Appends `- [<80-unit compact text>](<record_id>.md)` to INDEX.md, durably. An existing filename prevents label refresh. Publishes an ExplicitRule source notice for projection after the files/index; failure can follow successful file writes. Replay validates operation/revision (`:157`), but is not a complete correction transaction. |
| `butler-memory/src/cognition/paths.rs:40`, `:66`; `butler-agent/src/host/runtime/boundary.rs:150` | Default root is `<data>/cognition/memory/rules`, configurable through the resolved memory root; bindings stay in this flat directory even for project rules. |
| `butler-runtime/src/context/prompt/files.rs:37`; `butler-runtime/src/context/prompt/sections.rs:225` | Active Rules follows INDEX.md links and injects full file text as mandatory content. Each heading is `### <record_id>.md`: the model already sees IDs indirectly, although the tool cannot target them. Reader does not inspect source binding, lifecycle or project; there is no project filter here. A forgotten binding alone would not remove its indexed file from the prompt. |
| `butler-memory/src/cognition/sources/typed.rs:38`, `:245`, `:280` | Identity is record ID plus a binding to project and provenance; graph source key is `explicit_record:<record_id>`. Typed source reads require active binding and matching file hash. Lifecycle lookup requires an exact operation/revision in history: current active revision is Current; current forgotten operation is Forgotten; other revisions are Superseded. Merely deleting a file is not a supported lifecycle operation. |
| `butler-memory/src/cognition/completion/consumer/process/typed.rs:48` | For stale queued notices, reads authoritative lifecycle and calls the lifecycle consumer; for current notices, registers the source. Thus old notice publication matters even when its original notice was already acknowledged. There is no public forget producer. |
| `butler-memory/src/cognition/registration/typed_lifecycle.rs:93`, `:127` | Takes the consolidation lease with Background wait class, uses `spawn_blocking`, checks data authority, expected active generation and authoritative lifecycle, then consumes in the graph. Does not edit rule text, binding or INDEX.md. Cancellation/changed source refuses consumption. |
| `butler-memory/src/cognition/graph/typed_lifecycle.rs:28` | One SQL transaction marks all chunks for a forgotten source forgotten (and updates current revision); supersession marks only chunks still at the notice revision superseded. Resets inactive chunks' hot-cache projection stage to pending and records a lifecycle receipt. Does **not** delete or mark memory_nodes, edges, evidence, vector units or physical vectors. Shared nodes must not be erased just because one source is inactive. |
| `butler-memory/src/cognition/graph/cache_work.rs:8`; `butler-memory/src/cognition/completion/consumer/process/cache.rs:14` | Existing cache work selects pending jobs and calculates whether source revision/status is current; consumer advances the existing cache path. Lifecycle itself schedules reconciliation, not immediate physical cache removal. Existing reconciliation builds no windows for inactive jobs, validates retained entries and republishes the cache (`butler-memory/src/cognition/generation/cache.rs:194`). Prompt reads independently filter physical entries through readiness (`butler-memory/src/cognition/prompt/memory.rs:162`), which checks active source evidence (`butler-memory/src/cognition/graph/readiness/cache.rs:264`). No claim here that every physical entry disappears synchronously. |
| `butler-memory/src/cognition/graph/recall/scope.rs:13`; `butler-memory/src/cognition/sources/recall/hydrate.rs:91`, `:191` | Source-authoritative recall predicates require active chunks. Typed hydration additionally requires active binding and exact revision/hash. Superseded/forgotten typed sources therefore have exclusion gates, but this does not prove complete public recall behavior across all channels. |
| `butler-memory/src/cognition/graph/recall/vectors.rs:28`, `:201`; `butler-memory/src/cognition/memory_recall/selection.rs:76`; `butler-memory/src/cognition/memory_recall/continuation.rs:138` | Vector hits get current-unit/membership filtering; node membership uses source scope. Episode receipt SQL alone does not check active status. Subsequent source selection and hydration must enforce exclusion, including continuation pages. Physical vectors remain. End-to-end exclusion is still unverified. |
| `butler-agent/src/host/app/runtime_ports/personalization.rs:283` | Clear profile calls `clear_profiling_data`, not explicit-rule forget. |
| `repo:packages/butler-app/client/ui/src/components/settings/PersonalizationSettings.tsx:67`; `repo:packages/butler-app/client/ui/src/app/api.ts:368` | Existing personalization UI/API covers profile, response style and profiling controls; no explicit saved-rule list/delete adapter was found in the checked UI and host routes. |

The installed product text also needs alignment:
`repo:packages/butler-agent/resources/skills/save-instructions/SKILL.md:67` describes
old file editing. It must describe the public contract rather than teach the
model to bypass the owner with direct file writes.

## Three contract options, smallest first

All options below share the binding, durability, exclusion and recovery rules
in the next section. They differ in target selection and tool surface, not in
how thoroughly an inactive source is excluded.

### A. Targeted remember revision plus a separate forget tool (recommended)

Add optional `replaces` to the existing remember tool. Resolve it to the same
record ID, make a new revision, and supersede the old revision. Add a separate
forget tool. This reuses the library's record ID input without conflating an
empty text with deletion.

Terse schema/description proposal (object schemas forbid extra properties):

```text
update_explicit_memory
  "Remember an explicit rule. To correct a saved rule, supply its handle in replaces."
  {kind:"rule", text:string, source:string, replaces?:string}
  required: kind, text, source
forget_explicit_memory
  "Forget one saved rule by handle, only when the user asks. Chats are kept."
  {rule:string, source:string}
  required: rule, source
```

Active Rules becomes `### [R7K2M9] · This project` (or `All chats`), followed by
the full rule. Handles are persisted opaque unique values, never list positions
or truncated IDs assumed unique; allocate with collision checking, never reuse
a retired handle. A model copies the handle rather than guessing an internal
path. Text matching is not a write API. If the user's target is ambiguous, ask
which rule; if it is not present, open the same saved-rule list or ask the user
to select it. No new search/contradiction engine is required.

The server captures the handle's expected revision from the turn's rule
snapshot, so schemas need no model-authored revision or project ID. A handle
not in that authorized snapshot fails without mutation. Both tools return
`{ok:true, rule, operation_id, state:"active"|"forgotten", replayed}` only after
the source commit and exclusion are durable. Correction's semantic recall
projection may still be pending; report `recall_state:"pending"|"ready"`
accurately. Next-turn Active Rules immediately contains only the new text;
recall cannot return the old typed revision, and returns the new revision after
the existing projection completion barrier. Forget removes the rule from both.

Previous correction text and forgotten text are retained indefinitely until an
explicit future erase policy. MVP has no Undo tool or history UI: the user can
explicitly remember the text again as a new rule; exact archived restoration
is possible through a future recovery adapter, not advertised as available now.
Failure and cache behavior follow the common contract below.

### B. One explicit mutation tool instead of two tools

Keep remember for creation; add a dedicated mutation tool:

```text
change_explicit_memory
  "Correct or forget one saved rule by handle, only when the user asks."
  {action:"correct"|"forget", rule:string, text?:string, source:string}
  required: action, rule, source; text required only for correct, forbidden for forget
```

Model needs the same stable handle and authorized revision snapshot as A.
Correction writes a revision of the same record; forget tombstones it. Next
prompt, recall, indefinite archive retention, explicit re-remember recovery,
stale-target errors and mutation-only cache invalidation are identical to A.
This leaves remember's schema untouched but adds an action dispatch and a
second correction vocabulary despite existing remember/update machinery.

### C. Automatic contradiction selection before targeted mutation

```text
update_explicit_memory {kind:"rule", text:string, source:string}
forget_explicit_memory {rule:string, source:string}
```

Model need not supply a correction handle. During this explicit request only,
compare new text against the admitted rules and propose a matching handle;
show old/new text and binding for confirmation before any supersession. Forget
still needs a handle. No match creates a new rule; multiple matches or uncertain
match asks the user, without changing anything. A confirmed correction uses
the same revision/tombstone transaction as A, with identical disk/graph effects,
next prompt/recall exclusion, archive recovery and cache rules. Detection failure
does not silently create a conflicting rule when the user asked to correct one.
This costs request-time semantic work and a confirmation interaction, and can
misidentify compatible preferences. Do not ship it in the minimum contract;
never run contradiction detection in the background.

## Shared product and persistence contract

**Scope.** A rule has exactly one immutable binding: global or one project.
In a project chat, Active Rules shows globals plus that project's active rules;
outside projects, globals only. Correction/forget in chat may target only a
rule whose binding exactly equals the current canonical chat binding. Thus a
global rule seen in a project prompt cannot be mutated from that project chat;
use a general chat or the settings list. Similar text in another binding is
untouched. UI selection authorizes the exact displayed binding through the
authenticated App adapter, not a model-supplied arbitrary project ID. Correcting
does not move a rule to another project.

**Meaning of forget.** Exclude the selected explicit record and all its revisions
from mandatory rules, typed recall items/evidence and source-backed hot-cache
content, including old continuation pages. Do not erase shared graph entities,
unrelated evidence, chats, learned profile fields or independent saved rules.
The old statement may still be found as historical conversation evidence:
this is rule removal, not “erase every occurrence of this fact.” UI copy must
make that boundary clear. Broad fact suppression/transcript erasure is a
different owner decision and cannot be promised by this design.

**Writes.** Use the existing consolidation coordinator/lease, including the
source files, index and lifecycle invalidation in the authorized mutation path;
do not assume today's synchronous writer already provides that guarantee.
Run filesystem/SQL work on `spawn_blocking`. Access modes retain existing
authorization behavior; no widening of MemorySave/approval exemptions for the
new forget effect without review. Read-only requests fail before any writes.
Validate activated data authority and legacy refusal before creating journal,
lock, archive or queue files (`butler-agent/src/host/runtime/storage_bootstrap.rs:44`).

**Commit and exclusion.** Archive the exact previous text, binding and revision
under the rule owner before overwriting anything. Persist a small per-operation
intent/receipt for the targeted rule, expected revision, canonical user source
and idempotency key. Serialize mutations under the lease; compare expected
revision and immutable binding there. Correction appends revision history and
replaces the active text/binding, refreshes the existing index entry in place,
and explicitly publishes the prior operation/revision as stale as well as the
new current notice. Forget retains text in the archive, writes a forgotten
binding/operation recognized by the existing lifecycle reader, and removes its
active index entry. Do not depend on an already-acknowledged old notice being
delivered again.

Source state is authoritative. Publish the durable operation commit only after
the active source state and graph lifecycle exclusion agree; readers consult
the targeted pending/committed operation state to avoid exposing intermediate
file/index combinations. This needs a rule-owner commit protocol, not merely
three atomic file renames. The existing graph transaction retains nodes,
edges and vectors; use its chunk status/revision changes and current-source
gates. Any cache/recall output containing evidence solely from the inactive
revision must be excluded before success, including cursors created earlier.
Do not wait for semantic extraction, embeddings or physical cache cleanup to
acknowledge exclusion. Use existing current-source/cache readiness checks;
verify them rather than assuming they suffice. If a missing exclusion gate is
found, fix source eligibility in the owning read boundary as a prerequisite,
without changing ranking, expansion, alias postings or generation machinery.

**Failures and restart.** Invalid/unknown handle, stale snapshot, wrong binding,
refused data folder or denied access: no mutation and a specific error. A
concurrent correction wins only once; the stale request asks the user to review
the latest text. Identical operation retries replay the durable receipt;
different payload with the same operation ID conflicts. Repeating forget on an
already forgotten handle is an idempotent no-op; correcting it cannot revive it.
Lease contention waits only in the invoking tool/request, cancellably, not in
turn admission. Before durable intent, cancellation applies nothing. After
intent, retain the operation for recovery and return an explicit pending/error
receipt if completion cannot be confirmed; never say “forgotten” prematurely.
Recover targeted pending intents through the existing startup/request recovery
boundary under the lease, without an idle scanner or new worker. While recovery
is incomplete, exclude only the affected rule; other turns can be admitted.
Finalize or replay file/index/lifecycle/notice steps from the durable intent,
so a crash cannot resurrect old text or lose a queued update. Uncertain I/O
state must not be reported as “nothing changed.”

**Cache and owner scale.** Maintain an active-rule manifest keyed by binding and
handle at mutation time, with stable ordering. Prompt/list reads use that small
inventory and targeted files, never scan chats, the graph or all archived rules.
Revision/handle headings contain no current timestamp, turn ID or status churn.
Within the same binding, Active Rules bytes change only for rule mutations;
recall projection completion and physical cleanup do not change those bytes.
Project switching may select a different section. No new background work,
idle reads, polling or provider calls. Future performance checks must also
assert full content, count, order and latest state; no truncation for speed.

**Preexisting files.** On an explicit list/mutation request, recognize indexed
rules in supported activated data, including old rule markdown without a
typed binding. Give each an owner-managed handle and preserve its exact text;
where scope is absent, treat it as global and display that fact. Perform any
needed adoption only under the lease after authority validation; listing alone
should remain read-only by deriving a stable reference until first mutation.
Adoption and the requested mutation share the recoverable operation. Never
import, normalize or touch a refused pre-BTCC data folder. Do not infer the
owner's twelve rules' format or data-folder eligibility without permission to
inspect them; this task has none.

## Minimum App surface

Add **Remembered rules** within personalization settings: active text, binding
label (**All chats** or project name), and **Delete** per row. On opening,
read the active-rule manifest; refresh after mutations or existing change
events, not a timer. Load all rules through pagination if needed, without hiding
content. No editor, bulk delete, history browser or new dashboard. Correction
is available in chat. The list itself lets users select old rules without
requiring the model to recall them.

Proposed App adapter: `GET /memory/rules` returns text, handle, binding and
revision; `DELETE /memory/rules/<handle>` carries expected revision and a
client-generated operation ID and delegates to the same owner mutation.
The authenticated UI selection supplies authorization/provenance without
inventing a chat message. Show the exact row text and scope in a compact
confirmation: **Delete remembered rule?** / **Chats are kept.** Actions:
**Cancel**, **Delete**. Success: **Rule deleted**. Failure: **Couldn’t delete**;
retain the row and offer request-driven refresh for stale state. No optimistic
success. Implement later using `@/butler-ds` and its applicable UI skill.

## Separately shippable implementation tasks

1. **Rule owner foundation:** scoped active manifest/handles, revision archive,
   lease-bound mutation intent/receipt and targeted recovery. Cover crash points,
   operation replay, preexisting indexed files and legacy refusal. Keep public
   correction/forget disabled until exclusion is proven.
2. **Exclusion and projection:** wire old revision/forgotten notices, apply
   source lifecycle before acknowledging success, validate all recall outputs,
   old cursors and hot-cache readiness against inactive source state. Preserve
   shared nodes/evidence and existing ranking/storage/generation contracts.
3. **Chat correction:** add `replaces`, snapshot-bound authorization and scoped
   Active Rules handles; replace index labels deterministically. Update catalog,
   discovery/dispatch, effect authorization and save-instructions product text.
   Ship after tasks 1–2 pass the correction E2E.
4. **Chat forget:** add targeted forget schema/dispatch with the same owner and
   access checks. Ship after next-prompt/recall/restart forget tests pass.
5. **App list/delete:** add authenticated adapters and the settings rows above;
   use the same revision checks and receipts. A harness smoke/E2E proves user
   deletion without a provider or chat. No UI unit tests or recordings.

## Acceptance E2Es for implementation

Stub/replay only, fresh HOME/BUTLER_DATA, supported tool/API ingress. Observe
production completion receipts/barriers; do not seed lifecycle or patch graph
state to make scenarios pass. At most eight test threads; no live recording.

- **Correction:** remember old value, read its handle, explicitly correct in
  another chat of the same binding. Immediately after successful mutation, a
  new turn's Active Rules contains full corrected text once, no old text, one
  active record and preserved archive. After existing projection barrier,
  recall by old cue and paraphrase returns the new typed revision and no old
  typed item/evidence; continuation opened before correction cannot return it.
- **Forget:** remember and await usable recall, explicitly forget its handle;
  next turn has no rule, recall contains no revision of that typed record, and
  old continuation cannot expose it. Confirm text is archived and unrelated
  rules/shared graph evidence remain complete. Historical chat matches are
  tested separately and allowed, visibly identified as conversation sources.
- **Binding:** save similar rules globally and in projects A and B. Correct
  then forget A's rule from A; only A changes. B/global state, complete recall
  results and prompts remain unchanged. Wrong-project handle and project-chat
  attempt to mutate global rule fail without writes; prompt visibility follows
  globals plus current project only.
- **Restart/crash:** restart after success and at archive, intent, file/binding,
  index, graph exclusion, notice publication and receipt boundaries. Same
  operation settles exactly once; no old active rule reappears. Include an
  active turn and queued follow-up through shutdown/restart, not only one turn.
- **Failure:** stale concurrent revisions, unknown/path-shaped handles, denied
  access, lease contention/cancellation and I/O failure give truthful results.
  Other turns still admit while a mutation waits. Refused legacy folder is
  byte-for-byte unchanged, including absent locks/queue/archive creation.
- **App/old rules/cache:** list and delete supported old indexed markdown;
  preserve full content and binding. Repeated no-change turns produce identical
  Active Rules bytes/order. Idle instrumentation records zero added reads,
  writes or jobs; mutation is the only invalidation trigger.

Also run existing affected tests: `butler-e2e/tests/memory.rs` (MEM-01/MEM-02,
read argument intent, bootstrap and vector recall), `memory_hot_cache.rs`,
`memory_idle.rs`, `migration.rs` (MIG-01), `cli_surface.rs`, and relevant
personalization/config durability E2Es when adding the App adapter. Port the
audit's failing correction scenario to the approved schema; retain its original
failure as evidence, not as a workaround that invents implicit targeting.

## Owner decisions

1. **Targeted handles (A) or automatic contradiction matching (C)?** Recommend
   A: user intent plus an exact target; no semantic guess or extra confirmation.
2. **Retain tombstones indefinitely or implement explicit physical erase now?**
   Recommend retention, no expiry/purge job, and no MVP Undo surface. Archived
   data remains recoverable until a separately approved erase policy.
3. **Forget the saved rule only or suppress the fact from chat/profile recall
   too?** Recommend rule-only, with “Chats are kept.” Broad suppression needs a
   separate design; do not approve this while expecting all-occurrence erasure.
4. **Require exact chat binding or let project chats mutate visible global
   rules?** Recommend exact binding; settings can delete the selected global row.
5. **Include settings list/delete in the first release or ship chat-only first?**
   Recommend the list/delete as task 5 in the same release so old rules are
   manageable without model assistance; earlier tasks can land independently.

## Validation and limits of this design

Read-only audit fetch and source inspection completed; no builds, tests, model
calls or owner-data access. No new latency/throughput measurements. Supplied
audit measured **2 active bindings** and both **5317/8642** in Active Rules;
that is external evidence, not a new measurement. Static source gates support
the proposed direction but cannot establish public recall/vector/continuation
exclusion, physical hot-cache convergence, crash consistency, turn-admission
latency, owner-scale performance or cross-platform behavior. These remain
implementation acceptance work above. Owner data format/legacy eligibility
and whether the owner expects rule removal or fact erasure remain unknown.
