# Memory management from App settings

Status: proposed product contract for owner approval, 2026-10-02. Design only;
no existing reset, erase, recovery or latency guarantee is implied. The App is
the management surface; do not restore maintenance commands to the public CLI.
No recall ranking/expansion or alias-postings changes are proposed or required.

## Recommendation and vocabulary

Use Settings → **기억 / Memory**, linked from existing personalization settings.
Five cards: **고정 기억 / Pinned memories**, **자동 기억 / Automatic memory**,
**프로필 / Profile**, **프로젝트 기억 / Project memory**, and
**추가 저장 데이터 / Additional stored data**. The last card expands into
independent kinds, never one bulk reset. Project selection belongs in its card.
Keep consent, names and response style in personalization; link to Profile here.
Use **초기화 / Reset** for removing active content and **정리 / Clean up** for
non-destructive hygiene. Keep the approved pinned per-row **삭제 / Delete**.
No user-visible copy uses the internal names “rule” or “Steward”. Internal code
and prompt-section names below are implementation evidence, not App copy.

Recommend immediate logical reset, no Undo or fixed retention period for learned
memory. Delete retired reset data after readers drain, asynchronously; until
then show bytes awaiting removal. This is not secure SSD erasure. Pinned reset
is the approved forget operation applied to a captured set: keep tombstones
and archived text indefinitely, with no advertised Undo. These distinct
retention policies must appear in the confirmation. Chats always remain.
Clean up is an explicit button, scheduled once when safe, not an automatic
periodic worker. No “Rebuild from my chats” in this release.

## Verified inventory and existing capabilities

References below are relative to `packages/butler-agent/rust/crates/` unless
prefixed `repo:`. Data paths are relative to the selected data folder, with
normal default bindings; `CognitionPathEnvironment` overrides must be resolved
and containment checked (`butler-memory/src/cognition/paths.rs:33`,
`butler-memory/src/cognition/mutable_paths.rs:14`). Sizes are growth mechanisms,
not measured maxima. The example numbers come from the owner request; no real
owner data folder was inspected. “API” means production library capability,
not necessarily an authenticated App endpoint.

| Kind / contents and growth | Data location | Reads / writes | User access today; count/list/clear/rebuild API evidence |
| --- | --- | --- | --- |
| Pinned memories: explicit text, bindings, revision operations and index. Grows with saves/revisions; approved archives have indefinite growth. | `cognition/memory/rules/` incl. `INDEX.md` and bindings | Every turn's Active Rules; typed source recall. Remember tool writes text/binding/index and publishes notice. | Chat remember exists; approved handle/list/Delete work is on another branch. `butler-memory/src/cognition/sources/typed/write.rs:73` update; `sources/typed.rs:120` typed read; `butler-runtime/src/context/prompt/sections.rs:228` prompt. Health counts files, not active handles (`butler-memory/src/cognition/memory_health/sources.rs:117`). No current bulk reset API. |
| Automatic memory: conversation episodes, nodes, edges, aliases, evidence, extraction/vector jobs and hot projection. Shared graph also holds non-conversation typed sources; it is not exclusively automatic memory. Unbounded with sources/index growth. | `cognition/memory/generations/<id>/{graph.sqlite,butler.lance,hot/cache.md}`; `active-generation.json`; shared `queue/` | Recall tool and Hot Cache prompt; completion consumer, registration/extraction, graph consolidation, vector/cache writers. | No App list/reset. `butler-memory/src/cognition/memory_recall/service.rs:71` recall; `completion/consumer.rs:127` poll, `:175` catchup; `memory_health.rs:119` health (expensive); `graph.rs:128` interrupted semantic recovery; `generation/initialize.rs:27` fresh empty initialization; `generation/rebuild.rs:78` candidate rebuild; `generation/cutover/descriptor.rs:81` private descriptor CAS. No supported per-kind reset. |
| Profile: candidates, stable learned entries, runtime projection, consent and coverage. Grows with extracted source spans/candidates, even though prompt projection is short. | `cognition/profile/profile.sqlite` | Runtime profile prompt; reflective summary; consent-gated extraction/consolidation. | Existing profile clear, consent and summary. `butler-memory/src/profile/service.rs:190` clear; `:242` projection; `:259` reflective summary; `:270` consolidation; `service/extraction.rs:9` capture. `storage.rs:217` clear counts/removes candidates, stable entries, projection, coverage, scan offset; leaves consent/other metadata. It deletes in place and is not this design's swap protocol. App adapter `butler-agent/src/host/app/runtime_ports/personalization.rs:282`. |
| Project memory: rendered capsule and refresh/failure metadata; size follows projects and selected evidence/tasks. | `cognition/memory/projects/<sanitized-id>.md`, `.refresh-failures.jsonl`, capsule locks | Project Memory prompt; capsule refresh reads config, tasks, pinned project evidence, legacy graph. | No App capsule manager. `butler-memory/src/cognition/project_capsule.rs:51` inspect, `:142` refresh registered; `project_capsule/source.rs:169` path; `source/graph.rs:22` legacy graph read; `prompt/memory.rs:55` prompt read. No clear API. |
| Recent feedback (**최근 피드백 / Recent feedback**): scoped correction buffer, targets/status and quality operations; grows with feedback/log history. | `cognition/feedback/{feedback.md,quality-operations.jsonl}` | Active Feedback Buffer prompt, scoped by user/session/project; quality/revision cycle. Library operator add/resolve writes. | No supported App add/list/reset found; do not infer promotion exists. `butler-memory/src/cognition/feedback_buffer.rs:111` counts (reads buffer); `feedback_buffer/operator.rs:24` list, `:58` add, `:95` resolve, `:121` clear resolved; `prompt.rs:65` scoped read; `butler-runtime/src/context/prompt/sections.rs:254` prompt. |
| Know-how (**노하우 / Know-how**): entries, source-quality history, derived SQLite index; grows with entries/logs. | `cognition/know-how/` (`entries`, quality/index owned by service) | Aggregation/revision cycle; no supported prompt/tool retrieval entry found in inspected host paths. | No App create/list/reset found. `butler-memory/src/cognition/knowhow_store.rs:75` aggregate/rebuild, `:88` count (file scan), `:94` revise; `knowhow_store/entries.rs:24` internal list. Maintenance is wired, which does not prove a public creation/retrieval path. |
| Stored items (**저장 항목 / Stored items**, internal Box): content/manifests, index and retention metadata; arbitrary content can dominate size. | `cognition/box/items/`, Box index | Box index/retention and legacy metadata-reference checks; no supported public content ingress/retrieval found. | No App manager. `butler-memory/src/cognition/box_store.rs:48` rebuild index, `:54` retention, `:62` count indexed; `box_store/paths.rs:33` items root. Existing retention may delete content: do not expose it wholesale as non-destructive clean up. |
| Session notes (**대화 메모 / Session notes**): continuity markdown and recovery manifests; grows per session/recovery. | `cognition/memory/sessions/<session-hash>.md`, `recovery/manifests/`; recovery can write project hot-cache material | Session Continuity prompt; library recovery plan/apply/rollback. No supported public recovery entry found. | No App view/reset. `butler-memory/src/cognition/prompt/memory.rs:34` continuity read; `continuity_recovery.rs:112` plan, `:132` inspect, `:189` apply, `:198` rollback; `continuity_recovery/manifest.rs:172` manifest path. |
| Task results (**작업 결과 / Task results**): canonical Work Records plus graph-derived task-report projection; grows with completed work. Not disposable caches. | `tasks/<id>/` planned Work Records (distinct from authoritative BTCC Work); `cognition/memory/tasks/` projection markdown; task-report sources in serving graph | Typed recall; project capsule reads legacy task evidence and canonical task material. Task outcome ingestion publishes projection. | Existing task/project surfaces, no memory erase API. `butler-memory/src/cognition/sources/typed.rs:120` read dispatch, `:17` WorkRecordReader; `sources/typed/write/task.rs:16` ingestion; `project_capsule/source/evidence.rs:26` old tasks. Preserve canonical records. |
| Briefings (**대화 제안 / Chat suggestions**): generated suggestions and provenance; grows with dates/projects/locales. | `cognition/consolidation/briefings/<date>/…json` | New-chat tool/App result; model-backed scheduled generation from profile/project facts | Briefing display/settings exist, no memory reset. `butler-memory/src/cognition/briefing.rs:26` read; `briefing/generation/artifact.rs:25` stored format; `butler-agent/src/host/memory_jobs/briefing.rs:104` App settings read. |
| Storage artefacts, not a memory kind: retired generations, source snapshots, qualification evidence, dead letters, legacy `db`, `hot`, `conversations` | Generations' `source-snapshot/runtime/conversation-store.sqlite` and typed copies; qualification acceptance evidence root supplied by caller; `queue/dead-letter.jsonl`; legacy directories | Active descriptor/legacy compatibility, candidate source hydration, qualification/recovery diagnostics; snapshots created by old rebuild flow. Some legacy paths still have readers. | No App cleanup. `butler-memory/src/cognition/generation/read.rs:33` resolution (`:77` legacy root, `:81` active sources use live data); `generation/rebuild.rs:250` snapshot path, `:325` VACUUM INTO helper; `generation/qualification_service.rs:113` evidence root; `completion/consumer/process.rs:315` dead-letter append. Not blanket deletion candidates. |

Additional evidence: the generic scheduled cycle still constructs Box/Know-how
owners and calls their maintenance (`butler-agent/src/host/memory_jobs/daily.rs:84`,
`:172`; `consolidation_phase.rs:48`, `:68`, `:81`, `:131`). Therefore “no supported
entry point” means no supported owner-facing ingress/retrieval was found, not
that these stores are never touched. The configured cycle refreshes capsules
and reads health (`maintain_phase.rs:87`). Rebuild/cutover code present here is
being removed elsewhere; this design reuses only the retained empty-directory,
VACUUM snapshot and descriptor-CAS primitives, not qualification, rebuild or
rollback orchestration. The initializer currently requires fresh data: it
cannot simply be invoked on an existing folder to implement reset.

Pinned design reviewed read-only at
`/home/yeonw/workspace/wt/codex-memory-correct-design/packages/butler-agent/rust/docs/memory-correct-forget-design.md`.
Keep its scoped handles, current-source exclusion, idempotent receipts and
indefinite tombstones. Its older proposed App label must follow the owner’s
Pinned memories naming here.

## What settings shows, and how it stays cheap

All numbers below are **new management metadata**, not a claim that current
health APIs are cheap. One small versioned management summary, loaded into the
service after authority validation, holds per-kind content revision, inventory
revision, counts, allocated bytes, content-updated time, measured-at time and
health. A page-open request reads this in-memory snapshot, O(number of kinds),
plus the selected page of a small index. It opens no graph, Lance, profile DB,
metrics log or chat store and walks no directory. Do not run `MemoryHealthService`
on page open: its helpers scan files/JSONL and COUNT tables
(`memory_health/sources/files.rs:5`, `:56`, `:114`) and serving health queries jobs.

| Kind | Display and source of each number / cost outside page open |
| --- | --- |
| Pinned | Active handle count; full text/scope list with per-row Delete; disk bytes incl. archives; content-updated time. Approved active manifest supplies count/order/revision; mutation records bytes/time and targeted file metadata. List pages read only selected active records; archive is not walked. |
| Automatic | “N conversation episodes” (not nodes called memories), graph/vector/cache/queue disk bytes, content-updated time; pending/failed jobs and “N memories without vectors”. Count current eligible conversation episodes with at least one required vector unit incomplete, once per episode; report mismatch separately, never infer by subtracting row counts. Maintain counters at transactional job/episode transitions and vector receipts, keyed by generation. Per-file stat at commit plus Lance fragment/version manifest accounting. |
| Profile | Stable entry and pending candidate counts, stored bytes, learned-content time, consent state; “not collected” when off. Transactional counters/projection metadata; file allocation stats after writes. Detail opens the existing full reflective summary on explicit request, not automatically. Consent and names are not learned content counts. |
| Project | Project selector, capsule count and selected full capsule, stored bytes/content time; missing/refresh-failed state. Registered project index plus capsule commit manifest supplies counts, source revision and timestamp; targeted preview reads only selected capsule. No source scan on opening selector. |
| Additional | Each row independently shows record count, bytes, content time and “not in use” only when supported ingress/retrieval is absent; maintenance status separately. Indexed active feedback/entries/items/session notes/task projections/briefings with explicit detail pagination. A missing index gives “Not measured”, never zero. Preview supported text; manifest metadata for stored items, not bulk content loading. Task row labels count as “indexed task results”. Storage artefacts show separate reclaimable/blocked bytes and last analysis time, with no Reset. |

Summary commits accompany owner mutations; uncertain external changes invalidate
the corresponding measurement. Show **측정 필요 / Not measured** or **확인 중 /
Checking** with the measurement timestamp, never stale numbers labelled current.
An explicit **확인 / Check** action builds missing inventory on a cancellable
worker: file metadata enumeration O(files), graph aggregates O(rows/indexes),
JSONL O(bytes), Lance manifests O(fragments/versions). This is the only initial
adoption scan, not startup/page-open/idle work. Reconcile crash-dirty counters
for the changed owner before declaring them current; retain unknown meanwhile.
Content-updated time changes only with content, not cleanup, view, health or
maintenance. Allocated size uses a portable platform API; do not silently call
logical file length “space on disk”. Deduplicate shared paths; display shared
graph storage once under Automatic with “includes search copies of other kinds”,
and zero duplicate bytes on their cards. Reclaim estimates carry as-of revision.

## Per-kind Reset and Clean up contract

Every reset selects one kind (and one selected project for Project); it never
changes chats, consent/settings, canonical work records or another kind's
logical content, eligibility, prompt projection or usable search copies. All
reset adapters use the crash protocol below. No reset is secretly a rebuild.

| Kind | Reset: removed / kept, learning afterwards, recovery | Clean up: permitted hygiene / protected data |
| --- | --- | --- |
| Pinned | Forget every active handle in the displayed captured scope, with exact revision checks. Explicit “All scopes” selection is required for global plus projects. Remove active index/prompt/typed recall eligibility; retain handles, text/history and tombstones indefinitely. Never regenerate from chats. No MVP Undo, future archive recovery possible indefinitely. Per-row Delete remains available. | Remove only proven orphan temporary writes and compact derived index without changing handles/order/content. Never erase archives, tombstones or archived revisions. Often no space to reclaim; disable with “Nothing to clean up”. |
| Automatic | Remove all pre-reset conversation-derived episodes/evidence/aliases/edges/vector units and hot entries, and their pending/failed jobs. Keep unrelated typed evidence and projections (pinned/task etc.), pinned files, profile, capsules, session notes and chats. Only new turns admitted after reset commit may be extracted; no historical catchup/replay. No Undo; physical old directory removed after drain. | Delete unreferenced dormant artefacts, compact graph/Lance and acknowledged queue history as below. Preserve all current eligible sources, evidence, vectors and hot-cache bytes. No extraction or re-embedding and no missing-vector repair hidden in this action. |
| Profile | Remove candidates, stable entries, runtime projection and pre-reset extraction work/coverage; replace scan history with a durable reset floor rather than removing the floor. Keep consent, names, persona/response style, onboarding preferences and extractor selection. If consent is on, learn only from future admitted turns; off remains off. No Undo; old directory removed after drain. | VACUUM INTO equivalent preserved-content copy and pointer swap; discard detached completed-job temp files only. Keep consent/coverage/reset floor, candidates and stable entries. Do not call clear as cleanup. |
| Project | Remove selected project's capsule and its refresh jobs/failure detail. Keep project registration, files, tasks, chat history and pinned project memories, all other projects. Persist suppression until that project's source revision changes after reset; no immediate rebuild from unchanged old inputs. Future refresh may include old task/source facts alongside new ones: this resets a derived summary, not its underlying project knowledge. No Undo. | Remove detached temp capsules and settled duplicate failure logs after compact receipt; preserve selected/current capsules byte-for-byte and source fingerprints. Never delete project directories or old task evidence merely because capsule exists. |
| Recent feedback | Clear active buffer and pending feedback work for selected scopes; keep a minimal applied/cancelled receipt preventing replay. Preserve already-promoted independent pinned/profile/know-how content; do not reverse prior learning. Future feedback only; no Undo. | Compact resolved payloads only after every target application/exclusion is durably settled; keep active/unresolved feedback and quality provenance still referenced by other owners. Existing clear-resolved needs these gates before App use. |
| Know-how | Remove entries and own derived index; preserve external source-quality provenance referenced by other owners, chats and feedback. No regeneration from old logs; floor all aggregation/revision paths. Dormant until a supported writer creates new entries; no Undo. | Compact derived index/settled journal; never delete low-quality/demoted entries as “hygiene”. Preserve source-quality evidence needed by active entries or other owners. |
| Stored items | Remove owned content/manifests/index only when no other kind references them. Referenced items cause Reset to fail with “In use”, no partial deletion; do not cascade. No automatic recreation; no Undo. | Orphan staging files and index compaction only. No expiry-based content deletion, original external files, referenced items or active manifests; existing retention must not define the App contract. |
| Session notes | Remove notes for the selected session or explicitly all sessions, and exclude their recovery outputs from prompt injection. Keep chats, project capsules and unrelated hot entries. Suppress replay of pre-reset recovery manifests; future explicit supported note writes only. No Undo. | Detached temp files and terminal recovery evidence only if no live recovery/rollback/reference needs it. Never remove current notes. |
| Task results | Reset **search copies only**, including graph/vector/hot task-report projections, with replay floor for existing Work Record revisions. Preserve canonical Work Records, task files, capsules and project state. Future task revisions/outcomes can be indexed. No Undo for search copies; not task deletion. | Compact search copies; remove only orphan projection temp data. Preserve all canonical records and legacy task evidence; no destructive task-retention policy here. |
| Chat suggestions | Remove stored suggestions and pending generation work for selected scope; preserve names/profile/project/chat data and briefing settings. Suppress immediate regeneration until next scheduled generation after commit; future scheduled generation can reuse retained profile/project facts and make model calls. No Undo. | Remove superseded, unselected suggestion artefacts only after readers drain; keep displayed/current suggestions and their provenance. No regeneration/model calls during cleanup. |

Additional rows appear when inventory exists (and remain explainable if empty).
Do not ship an enabled reset for an unsupported kind until its owner adapter,
references and replay floor are implemented. An API's absence is an implementation
task, not permission for raw recursive deletion. No “Reset all memory” shortcut.

### Automatic reset: shared storage and replay are hard prerequisites

A blank whole generation would also lose typed-source recall. Stage an empty
directory, then populate **only** the exact surviving non-conversation projection:
current typed source rows, required graph entities/edges/aliases/evidence and
jobs, their vectors and independent hot entries. Preserve IDs, embedding bytes,
quality and all surviving provenance. Remove mixed conversation support from
shared entities without removing typed support. No model calls; never re-extract
pinned/task text as a substitute. Validate logical survivor equality before CAS.
If projection ownership cannot be separated losslessly, block this reset until
the owner boundary is supplied; do not promise independence with a blank swap.
Shared source-backed hot entries must be representable independently before
reset ships. The fresh initializer provides a starting shape, not this filter.

The new manifest binds a reset epoch and durable canonical admission floor
(source identity plus monotonic admission/revision boundary, not wall clock).
Apply it at all registration, queue, catchup, recovered standalone-message,
rescan/wrap and interrupted-job paths. Current catchup can start sweeps from
zero (`completion/consumer/catchup.rs:145`, `:260`), so merely saving tail cursors
is insufficient. An existing turn that completes after reset remains pre-reset
if admitted before the floor; a queued follow-up admitted after commit is future
work. A future turn may restate an old fact; that is new learning and allowed.
No read of retained chats is prevented, so transcript/search tools and the
current chat history can still show old text; the automatic recall channel must
return no old automatic evidence. On a fresh folder with no typed memories its
recall result is empty after reset. Typed pinned/task results remain on mixed data.

The shared root queue (`completion/queue.rs:23`, `:129`) includes typed notices.
Never delete it wholesale. Use an epoch-bearing durable queue view/floor:
pre-reset conversation notices are acknowledged as reset-suppressed, typed
notices preserved, future notices retained. Queue publishers and staged swap
share the serialization boundary; stale workers cannot write into the new
owner. Preserve the floor after physical cleanup and across unclean restart.
Profile likewise needs an admission floor across extractor rescan and coverage
recovery: today's clear removes scan offset and can permit historical learning.

## Confirmation and result copy

Each confirmation shows the selected kind, exact scope/project and captured
count. Buttons: **취소 / Cancel**, **초기화 / Reset** or **정리 / Clean up**.
Do not describe a reset as deletion of every occurrence of a fact. The common
last line for Reset is **진행 중인 응답에는 이전 기억이 남을 수 있습니다. /
A running response may still contain old memory.** Keep it inside the compact
confirmation, not a banner. The following body follows the title
**{kind} 초기화? / Reset {kind}?**:

| Selected kind | Korean body | English body |
| --- | --- | --- |
| Pinned | 선택한 고정 기억을 잊습니다. 기록은 보관됩니다. 대화·프로필·다른 기억은 유지됩니다. | Forget selected pinned memories. Archives remain. Chats, profile and other memory are kept. |
| Automatic | 자동 기억을 지웁니다. 대화·고정 기억·프로필·다른 기억은 유지됩니다. 새 대화부터 기억합니다. 되돌릴 수 없습니다. | Clear automatic memory. Chats, pinned memories, profile and other memory are kept. Learning starts with new turns. Cannot undo. |
| Profile | 학습한 프로필을 지웁니다. 대화·고정 기억·다른 기억·이름·설정·동의는 유지됩니다. 동의한 경우 새 대화부터 학습합니다. 되돌릴 수 없습니다. | Clear learned profile. Chats, pinned memories, other memory, names, settings and consent are kept. Learning resumes from new turns if enabled. Cannot undo. |
| Project | 이 프로젝트의 요약을 지웁니다. 대화·파일·작업·고정 기억·다른 기억은 유지됩니다. 다음 변경 후 기존 자료로 다시 요약할 수 있습니다. 되돌릴 수 없습니다. | Clear this project's summary. Chats, files, tasks, pinned memories and other memory are kept. A future change may regenerate it from retained sources. Cannot undo. |
| Recent feedback | 선택한 최근 피드백을 지웁니다. 대화·이미 학습한 내용·다른 기억은 유지됩니다. 되돌릴 수 없습니다. | Clear selected recent feedback. Chats, previously learned content and other memory are kept. Cannot undo. |
| Know-how | 노하우 항목을 지웁니다. 대화·피드백·다른 기억은 유지됩니다. 되돌릴 수 없습니다. | Clear know-how entries. Chats, feedback and other memory are kept. Cannot undo. |
| Stored items | 선택한 저장 항목을 지웁니다. 대화·외부 파일·다른 기억은 유지됩니다. 사용 중인 항목은 초기화할 수 없습니다. 되돌릴 수 없습니다. | Clear selected stored items. Chats, external files and other memory are kept. Items in use block reset. Cannot undo. |
| Session notes | 선택한 대화 메모를 지웁니다. 대화 기록·프로젝트 기억·다른 기억은 유지됩니다. 되돌릴 수 없습니다. | Clear selected session notes. Chat history, project memory and other memory are kept. Cannot undo. |
| Task results | 작업 결과의 검색 사본을 지웁니다. 작업 원본·대화·프로젝트 기억·다른 기억은 유지됩니다. 되돌릴 수 없습니다. | Clear task-result search copies. Original tasks, chats, project memory and other memory are kept. Cannot undo. |
| Chat suggestions | 선택한 대화 제안을 지웁니다. 대화·프로필·프로젝트·다른 기억·설정은 유지됩니다. 다음 예약 실행부터 다시 만듭니다. 되돌릴 수 없습니다. | Clear selected chat suggestions. Chats, profile, projects, other memory and settings are kept. Regeneration starts at the next scheduled run. Cannot undo. |

For Clean up every kind uses **{kind} 정리? / Clean up {kind}?** with
**불필요한 파일만 정리합니다. 대화·현재 기억·다른 기억은 유지됩니다. /
Remove unused files only. Chats, current memory and other memory are kept.**
Show the analyzed bytes and a short exact action list (for example “3 unused
snapshots; compact database”) beneath it. Pinned adds **보관 기록은 유지됩니다. /
Archives are kept.** Task adds **작업 원본은 유지됩니다. / Original tasks are kept.**
Stored items adds **현재 항목과 외부 파일은 유지됩니다. / Current items and external
files are kept.** A zero-reclaim plan disables the button; it does not prompt
for destructive content deletion. Storage artefacts use the same Clean up copy,
with the exact selected dormant categories and no Reset control.

Success: **초기화 완료 / Reset complete** or **정리 완료 · {bytes} 확보 /
Clean up complete · {bytes} freed**. Failure: **초기화 실패 / Reset failed**,
**정리 중단 · {bytes} 확보 / Clean up stopped · {bytes} freed**, with phase and
whether the reset committed. If committed but removal pending, say so rather
than “Reset failed”. No optimistic removal/success before a durable receipt.

## Crash safety, concurrency and service lifecycle

Proposed common protocol; current code does not yet establish all guarantees:

1. Validate activated storage authority and legacy refusal **before** writing
   intent, lock, queue, temp directory or inventory. Refusal predicate:
   `butler-agent/src/host/runtime/storage_bootstrap.rs:44`. Resolve overridden
   paths without following links outside mutable data. Never migrate a refused
   legacy folder via settings.
2. Persist idempotent operation ID, kind/scope, expected revisions, old/new roots,
   reset admission floor and phase. The existing consolidation coordinator/lease
   serializes writers (`butler-memory/src/coordination/coordinator.rs:1`);
   add reader pins and owner gates, not a second competing lock scheme.
3. Stop admitting writes for the selected owner; cancel/quiesce its consumer and
   exclude stale commits by epoch. Stage and durably sync a new directory on a
   worker, leaving old readers intact. Profile/capsule/extra owners need small
   owner descriptors; existing hard-coded readers must resolve them before use.
   Pinned uses the approved logical tombstone transaction instead of directory
   erasure. Bulk forget captures exact handles/revisions and commits one visible
   set, with targeted archive/exclusion recovery.
4. Under the lease, check revisions and completeness, then install one durable
   authoritative descriptor with CAS. Put floors/queue-view identity in that
   descriptor/immutable manifest; do not attempt unrelated renames as one atomic
   transaction. The existing CAS rechecks descriptor and target manifest hash
   (`generation/cutover/descriptor.rs:81`). The management receipt is recoverable
   from descriptor operation ID if a crash occurs before receipt publication.
5. Invalidate affected prompt/recall caches and cursors, publish committed event,
   reopen consumer on the new epoch and release the gate. Old continuations
   either revalidate against the new epoch or return “Memory changed”; never
   expose old automatic content. Existing turns may finish with content already
   sent to the provider; later recall calls use the new epoch. Tell the owner
   this boundary before Reset. Retire old roots; unlink only after reader pins
   drain. OS-specific deletion/allocation goes through `butler-platform`.
6. Crash before CAS: old root serves, staged root is resumable/discardable. Crash
   after CAS: new root and reset floor serve; reconcile receipts/queue views and
   retire old roots idempotently. Never roll back a committed reset, even if disk
   reclamation fails. On restart recover intents before affected memory admission;
   chats/other owners remain available. Show “Reset complete; removal pending”
   when logical removal succeeded but reclamation did not.

Busy: allow one durable job per owner, serialize shared generation operations,
and disable conflicting buttons with **사용 중 / In use**. An accepted job returns
an ID immediately; bounded waiting/cancellation is visible, not a held HTTP
request. No surprise scheduled reset without confirmation. Cleanup waits for
idle reader drain; interactive memory work cancels/yields before expensive
phases, without cancelling the user's turn. Stale scope/revision fails for review.

Progress uses existing App change-event transport extended with sequenced
operation events: waiting, preparing, committing, removing, complete, failed,
cancelled. Show phase/bytes reclaimed, not invented percentages. Initial/reconnect
GET reads the durable receipt and current summary once; events then drive updates,
no polling timers. Errors identify whether commit occurred, preserve failure
receipt and offer explicit resume. A repeat operation ID replays the result;
different payload under the same ID conflicts. Cancel before commit leaves
content unchanged; after commit cancels reclamation only, not reset itself.

Idle work is change-driven: no periodic inventory/health scans, heartbeat writes,
model calls or fsyncs; added idle reads/writes/jobs are zero, overall idle writes
approximately zero. Reclaim on a reader-release/change event or explicit resume,
not an expiration scanner. Run filesystem/SQL work on blocking workers; bound
resource usage to one heavy management job. Persist small phase transitions
while running. Shutdown cancels work and closes admissions; no VACUUM, deletion
sweep, queue drain, directory hashing or long fsync on exit. SQLite work needs an
interrupt hook; Lance cancellation safety must be verified, not assumed from
dropping a future. Leave resumable scratch under owned staging with receipt.
Test active turn plus queued follow-ups on shutdown, not just an active turn.

Model after reset: next admission omits the removed kind's prompt projection;
no changing timestamp/generation marker in the stable system prefix. If a turn
has already seen old recall/notes, attach one short stable runtime notice on its
next provider round: “Automatic memory was reset. Use only newly retrieved
memory; chat history remains.” / “자동 기억을 초기화했습니다. 새로 조회한 기억만
사용하세요. 대화 기록은 유지됩니다.” Substitute the selected kind's name.
This cannot retract provider-visible context or erase facts in retained chat
history. No persistent per-turn notice when the model has not seen old memory.
Invalidate only changed sections/cursors; unchanged kinds retain identical
prompt bytes. Reset incurs a changed-prefix cache miss where content changed;
cleanup must not change prompt bytes or the live-configuration hash.

## Clean up plan, space, time and writes

Clean up never drops active facts, alters ranking/expansion, repairs semantic
failures with extraction calls or replaces alias postings. It offers an explicit
analysis showing reclaimable and blocked bytes; execute against that inventory
revision, revalidate references under the lease, and report actual allocated
bytes reclaimed after drain. No data-folder glob deletion.

| Work | Eligibility and safety | Example-folder estimate / resource cost |
| --- | --- | --- |
| Retired generations | Unpinned by active descriptor, reader, job, reset intent or recovery reference; no retained rollback dependency. Retired legacy manifests and their physical `db` root must be treated separately. | Size not supplied; additional reclaim only after reference closure. Metadata/unlink I/O; SSD content writes near zero. |
| Four source snapshots | Active reads use live sources (`generation/read.rs:81`; `completion/consumer/process.rs:483`). Delete snapshots only when no candidate/job/recovery/qualification consumer needs them, retiring any obsolete dependency first. Keep concise terminal receipts. | Up to `4 × 123 = 492 MB`. Do not count twice if inside a retired generation. Mostly deletion metadata writes. |
| Qualification evidence | Terminal unused evidence only; no active qualification, rollback or recovery obligation. Paths come from receipts/acceptance roots, not guessed filenames. Keep compact outcome/hash receipts. | Up to 22 MB, near-zero content rewrite; evidence needed for recovery is blocked. |
| Dead letters | Remove payload only after durable disposition: successfully replayed, proven duplicate, reset-suppressed or irrecoverably invalid with compact failure/source receipt. Preserve unresolved recoverable requests and reference checks. | 0–23 MB; compact receipt/remaining queue writes. Never silently discard failed ingestion to make health green. |
| Legacy `db`, `hot`, `conversations` | Only on supported activated data and after proving no active legacy descriptor, capsule, fallback, recovery or source-authority reader. Current capsule graph reader uses `db/graph.sqlite`; keep until explicitly retired or safely moved by separate prerequisite work. Old transcripts may be sole source copies; preserve. | Unknown, possibly zero. No unconditional “legacy cleanup” promise. |
| SQLite graph/profile/index compaction | Quiesce writes; `VACUUM INTO` staged owner copy, retain IDs/table data, indexes, floors and provenance; validate logical equality, preserve vectors/cache, CAS owner pointer, remove old after drain. Journal/WAL/checkpoint correctness part of copy. | Graph currently 1.55 GB; reclaim is free-page space only, unknown without freelist/page/allocation accounting. The 88% alias postings (~1.36 GB) are live data, **not reclaimable by VACUUM**. Write approximately compact DB size plus copied siblings/metadata; conservatively provision another ~1.69 GB for graph + 140 MB vectors if full copy is needed, plus hot/WAL/validation overhead. |
| Lance | Reuse safe compaction/version pruning mechanics (`lance_maintenance.rs:51`, `:69`), preserve tagged/pinned versions and live rows; current defaults keep newest 32 versions and skip unverified files. Reader version pins must gate physical removal. `vector_optimize.rs:72` exists but is not proof of the whole contract. | 140 MB store: reclaim unknown; rewrites approximately live compacted fragments/indexes, potentially ~140 MB or more during version retention. Not a promised 140 MB saving. |
| Failed/stuck work | Recover abandoned claims only after lease/epoch proves no live owner. Keep source and pending payload; compact settled journals. Expose failed count plus separate **다시 시도 / Retry** only if supported and explicitly requested; extraction retry can cost model calls. Cleanup alone never retries semantic extraction or declares failed sources complete. | Reclaim limited to obsolete payloads/temp outputs; missing vectors remain honestly reported. No model/embedding calls during cleanup. |

Conditional dormant-artefact ceiling is **537 MB** (492 + 22 + 23), plus separately
measured eligible retired/legacy bytes and compaction free space. If dead letters
are unresolved, ceiling is **514 MB**; if any snapshots/evidence remain referenced,
subtract them. Guaranteed reclaim before inventory/reference validation is **0**.
These are supplied approximate MB, not new measurements or a GiB conversion.
Future smaller alias indexes may improve size but are outside this estimate.

Duration is not verifiable by source inspection. Planning ranges on an idle SSD:
dormant removal seconds to tens of seconds; 1.55 GB graph copy/validation plus
Lance compaction tens of seconds to minutes; a loaded WSL host can take longer.
They are hypotheses, not UI promises or acceptance timeout increases. Estimate
copy time from bytes / measured sustained throughput plus logical-validation
work; measure cold/warm duration, peak disk/RAM, bytes written, pause time and
reclaim at owner scale during implementation. Deletion writes metadata; VACUUM
rewrites live pages including aliases, so allow roughly **1.55–1.69 GB plus Lance
compaction/index/WAL overhead** of logical file writes for full graph/store copy,
not device NAND-write guarantees. Check free space before staging, fail unchanged
on ENOSPC; keep receipt and cancel safely. Offer cheap dormant removal first,
and avoid expensive compaction when accounting predicts negligible gain.

Never remove chats/BTCC/canonical conversation store, Work Records, project
files/ledger, credentials/config, active memory, pinned tombstones/archives,
unresolved queue payloads, required source snapshots/evidence, live reader
versions or files outside activated authority. Cleanup of a shared generation
may copy other kinds' search projections but cannot alter their logical content
or account their private stores as reclaimed.

## Choices for the owner

| Either/or decision | Recommendation and tradeoff |
| --- | --- |
| One Memory page or controls distributed in personalization/project settings? | One page with five cards and links from existing sections; kinds and the two actions stay discoverable without duplicating controls. |
| Immediate learned-memory reset or seven-day recovery with Restore? | Immediate logical reset/no Undo; simpler independence and no expiry worker. Seven-day restore needs protected bytes, scheduled expiry, and a policy for merging future learning. Pinned archive policy stays indefinite in either option. |
| Explicit Clean up or automatic idle cleanup? | Explicit once-per-request cleanup, cancellable at idle; predictable SSD use and no new idle scans. Auto cleanup would need writer-maintained eligibility and explicit opt-in later. |
| Future-only automatic/profile learning or automatic replay of retained chats after reset? | Future-only; otherwise reset quickly repopulates what was removed and makes extraction calls. |
| Offer “Rebuild from my chats” now or leave it out? | Leave it out. A future separate preview/approval must estimate eligible transcript windows and tokens × extraction model pricing, plus retries, embeddings and graph/vector writes; never bundle it with Clean up or revive removed rebuild orchestration. |
| Reset project summary only, allowing future refresh from retained sources, or suppress all old project evidence permanently? | Summary-only with source-change gate and explicit confirmation. Permanent suppression is a separate source-eligibility product, cannot be achieved by deleting a capsule. |
| Expose existing additional stores now or omit them until public creation paths exist? | Show inventory and independently gated management for existing data now; do not add new creation/recall features. Task control explicitly resets search copies only. |

## Separately shippable implementation and acceptance

Each item can land independently; enable actions only after their prerequisites.
No public CLI additions. UI implementation must use the Butler design system.

1. **Read-only inventory and App surface.** Add mutation-maintained summary/index,
   explicit adoption analysis, authenticated list/preview adapters and event
   subscription; five cards, accurate unknown/blocked states. E2E: fresh folder
   shows exact zero/absent states without creating unrelated stores; populated
   owner-scale fixture page open performs zero graph/Lance/profile opens and
   directory/chat/log scans. Check full paginated text/count/order/latest revision,
   not trimmed content. Idle interval has zero added reads/writes/jobs.
2. **Operation/authority foundation.** Durable receipts, epoch manifest, reader
   pins, lease/gates, platform path/allocation/deletion support and event replay.
   E2E: refused legacy folder byte-for-byte unchanged (including no lock/intent),
   symlink/override refusal, stale revision/no mutation, duplicate operation
   replay, reconnect gets final event/receipt without polling.
3. **Automatic reset.** Lossless typed-survivor copy, future admission floor,
   queue epoch/filtering and swap/recovery. E2E through real remember/profile/chat
   APIs with stub extraction: create old automatic recall, pinned, profile and
   chats; reset; old automatic query returns no old evidence on all pages/cursors,
   pinned/profile/chats/capsules and typed recall remain equal. A future turn learns;
   startup, forced catchup/wrap, old delayed notice and recovered messages do not
   repopulate old memory. Fresh automatic-only folder recall is empty.
4. **Pinned bulk reset.** Reuse approved handle/tombstone owner and per-row Delete,
   captured scope/revisions and atomic visible exclusion. E2E: global/project
   scope, complete text archive preserved, unrelated profile/automatic/task recall
   intact, current prompt excludes reset handles, old typed continuations exclude
   them, stale batch does not partly forget. No physical archive purge.
5. **Profile reset replacement.** Owner directory descriptor, preserve settings,
   consent and admission floor, switch existing clear action to same protocol.
   E2E: on/off consent unchanged, names/style/config durability, future-only
   extraction despite coverage rescan/restart, pinned and other kinds unchanged.
6. **Project capsule reset.** Selected owner descriptor and source-change
   suppression; full preview and exact scope confirmation. E2E: A reset leaves B,
   tasks/ledger/pinned/chat unchanged; unchanged source cannot regenerate A;
   a future source change allows correct refresh with disclosed retained facts.
7. **Additional-owner adapters**, one small task per feedback, know-how, stored
   items, session notes, task search copies and suggestions. Each needs its own
   index/descriptor/floor/reference tests before enabling Reset. E2E each: only
   selected owner changes; referenced Box blocks without partial deletion;
   feedback replay cannot repromote; canonical task results never deleted;
   recovery cannot resurrect notes; suggestions wait until next schedule.
8. **Dormant artefact cleanup.** Reference inventory, settled dead-letter receipts
   and bounded reader-drained deletion. E2E: known eligible snapshots/evidence/
   retired fixture reclaim exact allocated bytes; referenced/unresolved/legacy
   source fixtures remain; full recall results/evidence/prompt bytes unchanged
   and queued work preserved. No extraction calls. Repeat is idempotent.
9. **SQLite/Lance compaction**, separate from dormant cleanup. E2E: seeded free
   pages/fragments reclaim measured bytes, all logical content and complete
   recall results/order/evidence/latest revisions match before/after; tagged/pinned
   versions survive; ENOSPC/cancellation leaves valid old or committed new root.
   If vector score ties reorder due to compaction, do not waive equality: prevent
   behavior changes in the compaction owner without changing recall ranking.

For every mutation task inject crash/cancellation at intent, staging, sync, CAS,
receipt and old-root removal; restart through supported service bootstrap.
Before commit old content survives; after commit removed content never returns,
other kinds stay complete, pending future notices settle exactly once. Include
active turn and full queued follow-up set, consumer in model/vector/cache phases,
concurrent recall reader and old cursor. Record admission latency, peak storage,
shutdown latency/fsync, idle I/O, model-call count (zero for Reset/Clean up),
reclaim/duration/logical writes; timed checks also assert complete/latest content.
No new timeout or performance-budget relaxations.

Run existing relevant suites in implementation: `butler-e2e/tests/memory.rs`,
`memory_hot_cache.rs`, `memory_idle.rs`, `migration.rs` (MIG-01), `cli_surface.rs`,
profile/personalization/config durability and project/task/briefing E2Es found by
module search. Fresh HOME/BUTLER_DATA; stub/replay only, ≤8 test threads. Platform
reader/deletion behavior requires supported-platform validation, not only Linux.

## Validation and limits

This task read AGENTS.md, plans/README.md, current source and the local approved
pinned design. No builds, tests, model calls, owner-data access, fetch, push or PR.
Static references and document consistency are checked separately before commit.
No new measured numbers. The requested worktree target directory is absent;
no build output was created to delete, and shared build caches are untouched.

Unverified by reading: actual eligible snapshot/evidence/dead-letter references,
legacy source uniqueness and retired size; database free pages and Lance garbage;
lossless separation of shared graph/hot support; total disk/RAM/SSD writes and
latency on the example folder; reader-pin/cancellation behavior on each OS;
reset crash recovery, prompt/recall/continuation exclusion and future-only floors.
These are explicit prerequisites and acceptance work above, not current product
capabilities. Owner approval is needed for the choices above before implementation.
