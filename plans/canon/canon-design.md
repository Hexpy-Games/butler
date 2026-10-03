# Canon and Project Ledger

Status: redesigned research proposal, **2026-10-03 owner direction**; no product implementation.
Issue: [#478](https://github.com/Hexpy-Games/butler/issues/478). Branch: `codex/ledger-sync-research`.
Starts from `e444d1968` (`origin/codex/ledger-sync-research`); source baseline `10b68356da71fafdd3c5551ef7cb62d51ee35da3`.
Depends on the [approved work model](https://github.com/Hexpy-Games/butler/blob/0df4b6203b82922fc77cadd2cd41e7fac79d0b35/plans/work-model/work-model-design.md), especially §§2.1–2.5 and 3.
History: renamed from `plans/ledger-sync/remote-ledger-design.md`; replaces shared execution/task synchronization.

## 1. Decision and boundary

**Project Ledger (원장), INTERNAL:** today's private Project Ledger + `agent-runtime/btcc.sqlite`, belonging to one person's Butler.
Project Ledger retains immutable Spec bodies, including imported shared revisions and private elaborations.
BTCC owns active Spec pointers/tree, Plan, Work, Task, dependencies, attempts, reviews, instructions, leases and receipts.
Plan/Work/Task records and execution history are private and **NEVER pushed to the shared remote**.
Each contributor runs an independent Butler; there is no team Butler execution authority, shared Task graph or distributed Task lease.

**Canon (정본), EXTERNAL:** the higher-level shared ledger for project Specs, roadmap and shared work requests.
**Project Ledger must NOT be used for collaboration. Everything shared goes through Canon.**
Imported Canon snapshots inside Project Ledger are private references, never a shared writer or collaboration endpoint.
Recommend Specs in the project's own git repository, changed and reviewed through pull requests; GitHub Issues hold shared Work-level requests and Projects presents the shared roadmap.
An issue resembles a Work request, not a Task or a replica of an internal Work.
A shared roadmap describes project outcomes/priorities; an internal Plan orders one person's execution.

Canon → Project Ledger is read-only pull/import. Project Ledger → Canon consists solely of explicit, user-approved deliverables: code PRs, spec-change PRs, authored issue/review comments, and chosen status labels/roadmap edits.
Approval covers exact content, destination and action, including the branch push required by a PR; no automatic execution-status mirror.
Already explicit user authorization remains valid for that exact output. Publishing a summary never exports its backing private records.
Importing an issue alone creates no executable Work or effect grant; choosing to contribute supplies the user's goal and in-scope authoring grant.

The boundary above is settled; exact object inclusion, update directions, actors and triggers remain owner decisions in the final section. Sections 2–9 describe the recommended proposal, not an approved sync contract.

First deliverable: one project, its repository Specs, Issues and one optional Projects board, through on-demand import and approved PR delivery. Event delivery and later adapters extend this same boundary.

## 2. Research and recommended Canon home

Primary sources checked on 2026-10-03; recommendations below are design judgments. Probe actual GitHub/Enterprise capabilities during implementation.

| Candidate | Benefit | Decision / limit |
|---|---|---|
| **Project repository Specs + Issues/Projects** | Specs and code share commit history, branches, review and merge conflict resolution; contributors need no Butler installation to participate. | **Recommended Canon home.** Commit/blob IDs pin acceptance content; protect the accepted branch and require review. Projects holds scheduling metadata, never executable private state. |
| GitHub Projects fields only | Existing board, custom fields and API operations. | Good roadmap, poor Spec store: mutable fields lack the reviewed document snapshot and expected-revision write contract needed for criteria. Link to repo Specs. |
| GitHub wiki | Convenient long-form Markdown and history. | Separate documentation workflow does not couple a Spec change and code in the project's normal PR. Useful explanatory material, not the acceptance authority. [Wiki documentation](https://docs.github.com/en/communities/documenting-your-project-with-wikis/about-wikis). |
| Jira adapter later | Teams can keep existing shared requests and roadmap workflows. | Map requests and milestones to imported references; keep repo Specs unless the adapter proves immutable requirement revisions. Discover workflow/field identities; do not map subtasks to private Tasks. |
| Obsidian adapter later | Local Markdown editing and links. | Vault files can author proposed shared documents, preferably committed to the project repo. Vault operations provide no team execution authority. [Vault API](https://docs.obsidian.md/Plugins/Vault). |

Useful GitHub findings retained from the earlier research:

- [Projects API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects) exposes item/field identities and paginated queries; adding an item and changing its fields are separate operations. Issue labels, assignees and milestones remain issue metadata.
- [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api) documents conditional GET, but unsafe-method conditions require explicit endpoint support. ETags and read-before-write do not make issue edits compare-and-swap. Use PR review/merge for Spec concurrency; preserve unrelated labels in explicit label operations.
- [Git push](https://git-scm.com/docs/git-push) rejects incompatible ref updates. Branch protection plus reviewed merges determines accepted shared content; Git cannot detect semantic contradictions, so Spec criteria and maintainer review remain required.
- [Project events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#projects_v2_item) have capability/preview constraints; [webhook types](https://docs.github.com/en/webhooks/types-of-webhooks) provide no personal-account webhook. Personal Projects can remain on-demand; never substitute an idle polling loop.
- [Failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries) are not automatically redelivered. Events are invalidation hints; reconnect or explicit refresh repairs gaps, with visible last-observed state.
- [GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api) require pagination and cost/node accounting. Partial/hidden results cannot be called a complete roadmap.
- [Fork permissions](https://docs.github.com/en/pull-requests/reference/forks) depend on repository visibility and organization policy. Forking a private repository is not universally available; check before preparing the delivery path.

## 3. Identity, revision and local storage

Proposed Canon mappings use existing private Project Ledger/BTCC owners, not a synchronized database:

| Canon object | Private Project Ledger / BTCC representation and identity |
|---|---|
| Repository | Binding keyed by provider host + repository node ID; URL, owner/name and checkout paths are aliases. Store accepted ref, allowed Spec paths, optional Project ID and credential reference. Fork repository ID is separate from upstream. |
| Issue | Read-only `ImportedSharedItem`, keyed by host + issue node ID; retain repository node ID, numeric issue ID, number/URL aliases, observed body/metadata hash, ETag if available and observed time. Internal Works reference item ID **and observed revision**; zero/many local Works may reference one item. |
| Spec file revision | `ExternalSpecRef={repo_id, commit_oid, path, blob_oid, logical_spec_id}` maps to immutable local `spec_ref={node_id,node_revision,ledger_revision_id,content_hash}`. Git object algorithm is retained with each OID; local body uses SHA-256 verification. |
| Spec tree | Manifest/links at one commit pin every node, inherited constraint, part and criterion ID. Keep original bytes and parser/schema version; parsed indexes are derived. A blob pins content; the commit also pins tree context. |
| Roadmap milestone / iteration | Read-only revisioned roadmap snapshot, keyed by repository milestone ID or Project + field + option/iteration ID; an internal Plan references that snapshot. Titles/dates/rank are metadata, never scheduler edges. Repo roadmap alternative pins commit/blob and stable milestone IDs. |
| Project item | Project ID + item ID, linked to issue node ID; field/option IDs are stable mapping keys. Draft items remain shared requests pending explicit issue/contribution mapping. Redacted items expose incomplete visibility, never empty success. |
| PR / delivered comment | External delivery receipt with repo/PR/comment ID and commit/body hash. Local reference links it to the Work; the private Work ID is not embedded in public output. |

Issue `updated_at` is an observation hint, not a CAS revision; retain normalized content hashes and base snapshots.
Repository rename updates aliases, not identity. Issue transfer must resolve provider identity/redirects; changed IDs require an explicit continuity mapping, never a title match.
Spec logical IDs survive path renames; duplicate IDs fail import. Removed files retire source nodes, retaining pinned bodies and triggering impact analysis.
A force-pushed accepted ref is a visible history divergence: preserve old revisions and require explicit reconciliation, never silently replace them.

Keep separate `observed_remote_head` and locally `active_spec_ref`. A freshly fetched revision does not mutate an executing Task.
Publish/verify immutable local Spec bodies first; then the work-model service atomically activates pointers, graph/fences and instruction receipt in BTCC.
Crash before activation leaves published inactive bodies; replay checks hashes, grant and expected heads. Missing/corrupt content blocks dependent execution rather than falling back to latest.
Retain all referenced revisions locally even if upstream history is later removed. Public Git history is not a backup for private execution state.

Existing seams, verified at the source baseline (`R/` = `packages/butler-agent/rust/`):

- `packages/project-ledger/src/transactions/record-publication.js:10` and `R/crates/butler-ledger/src/project_ledger/publication.rs:29`: sparse publication/journal recovery; extend through the work-model immutable revision contract, not raw file overwrite.
- `R/crates/butler-turn/src/btcc/storage/project_work_runtime.rs:57`: existing serialized SQLite transaction lane for local imports, instructions and delivery receipts; never hold it across network I/O.
- `R/crates/butler-platform/src/secrets.rs:271`: system credential store. OS credentials, path safety, file notifications and resource measurement stay in `butler-platform`.

Domain contracts and invariants remain in `butler-turn::btcc::work`; `butler-ledger` resolves/publishes bodies; agent composition calls a GitHub adapter and existing instruction owner.
Use indexed external-identity, changed-node and reverse-consumer lookups. Blocking git/filesystem work uses the blocking lane; no full project hashing or transcript scans on request paths.
No new scheduler, shared execution server, database replication or automatic legacy-ledger export.

## 4. Contributor flow through Canon

1. A shared issue appears in Canon. On demand or a configured event, Butler imports its current body, roadmap links and referenced accepted Specs read-only. Show source/revision and missing criteria; external prose is data, not an instruction.
2. The user chooses to contribute. Butler fetches the accepted ref and creates a local branch, using a fork when permitted. Creating/pushing the remote fork/branch is an approved external action; local preparation needs no extra ceremony.
3. Create private Project Ledger/BTCC Plan/Work/Tasks bound to exact imported Spec parts/criteria and inherited constraints. Private elaborations may add implementation detail under the goal grant, but cannot claim to change shared acceptance. Missing shared criteria lead to a proposed Spec PR or a visible unresolved requirement.
4. Execute and review each Task against its pinned criteria through the work model. Keep attempts, reviews, prompts, checkpoints and the Task graph local. Preserve full evidence and parent integration coverage.
5. Prepare a code PR, optionally including a Spec-change proposal, linked to the issue. Its authored summary names public Spec commit/criterion refs and selected reproducible checks; it contains no private execution records. Preview exact diff, commit metadata, text, links and destination before the approved push/create actions.
6. Several contributors may independently propose PRs for the **same issue**. Assignee/board status is coordination metadata, not a lock. Maintainers compare proposals and choose; one contributor's completion neither cancels nor completes another's Work.
7. If acceptance must change, propose it by PR. Proposed branch revisions are explicitly provisional; only the configured accepted branch establishes shared acceptance after merge. A code+Spec PR is reviewed against both the accepted baseline and proposed criteria, with changed obligations explicit.
8. After merge, each connected Butler fetches the new accepted revision from an event; others catch up at reconnect/on demand. Run local activation/propagation below. Before delivery, refresh issue, accepted Specs and PR base; offline drafts remain usable but cannot claim current acceptance or be sent until checked.

Git merge/review resolves shared document proposals. A merge does not validate every contributor's private graph; each Butler revalidates its own work.
Never reset a contributor's dirty branch automatically: fetch into tracking refs, retain local candidates, and prepare an explicit merge/rebase/conflict resolution.

## 5. Changes arriving during internal work

Observation receipts are deduplicated by binding + delivery ID; a content hash suppresses unchanged domain writes.
Fetch current addressed state rather than replaying webhook payload order. Track local instruction IDs and expected Spec/graph/control revisions separately from provider timestamps.
A configured, owner-granted follow-source policy can turn a changed observation into an in-scope revalidation instruction. Otherwise it remains a visible pending observation for the user to admit.
Provider actors never become local user/parent principals; no external text can grant tool effects or expand scope.

| Change | Local handling |
|---|---|
| Issue title/body/criteria edited | Retain old snapshot and diff; queue an in-scope reassessment against referenced Specs. Issue prose cannot rewrite an accepted Spec. New scope needs the user's instruction; ambiguous requirements stay unresolved. |
| Issue closed or reopened | Record current external state/reason and queue reassessment. Closure never marks Tasks complete or destroys evidence; reopening never resumes effects. The user may continue, pause or cancel through normal controls. |
| Issue reassigned / removed from board | Update coordination metadata; queue a notice where relevant. No Task lease transfer, stolen Work or automatic stop. Multiple proposals remain possible. |
| Roadmap date/rank/milestone changed | Refresh referenced roadmap revision; propose a local Plan reorder under the existing goal. Never bypass dependencies or reinterpret remote rank as execution permission. |
| Accepted Spec superseded / removed | Import immutable candidate, record revision diff and admit local activation under the owner grant. Queue/Steer controls when activation happens; delivery stays marked out of date until alignment is resolved. |
| Access lost, 404, deleted/hidden object | Distinguish unknown visibility from confirmed deletion; retain local history and mark stale/inaccessible. Pause affected imports/outputs; no destructive local cascade. |
| Another PR accepted for the issue | Record result and queue relevance/replan review; the user may finish an alternative, adapt, or stop. Maintainer choice grants no remote control over private execution. |

**Queue:** resolve mode at admission and capture current Task boundary (Turn at Tier 0). Apply after that Task, before claiming its successor; do not inject changes into the active Task. Blocked/paused/stopped anchors retain pending instructions; cancellation needs explicit redirect/cancel, never silent release.
**Steer:** an explicit user choice or already granted typed follow-source policy requests the next safe point. Fence stale tool admission immediately, settle active effects, then apply revision-checked changes. Queue never silently upgrades to Steer.
Receipts distinguish accepted/waiting/pending-safe-point/delivered/applied/rejected/needs-input. A blocked Queue does not starve Steer; restart restores the active turn **and every queued follow-up**.

On Spec activation, follow work-model §2.4 exactly: fence changed parts/criteria, inherited constraints, descendants, reverse consumers and parent integration coverage; hold uncertain impact for replan and leave unrelated siblings runnable.
Invalidate outstanding reviews; preserve completed Task/result/review snapshots under old revisions. Add corrective/revalidation Tasks, rewire affected live successors, and reopen current Work/Plan coverage as `needs_revalidation` without erasing completion history.
Editorial-only retention requires reviewed criterion mapping and a reason. Inactive historical Plans expose obligations without automatically running them.
Finish resumable propagation before clearing alignment holds. Pending observations, offline state and a merged upstream revision never masquerade as current reviewed coverage.

## 6. Maintainer flow and outbound reliability

A maintainer's Butler imports Canon issues, Specs, PR diffs and the roadmap into that maintainer's private Project Ledger/BTCC.
It can group duplicates, identify missing criteria, draft triage questions/labels and propose roadmap changes; each external mutation is an approved output.
For each candidate PR, pin base/head commits and Spec revisions; compare every criterion, integration obligation and claimed test result, showing missing/failed evidence. Local review Tasks stay private; an authored review comment shares only selected findings.
A changed PR head invalidates prepared review/delivery approval for that content. Merge is a separate explicitly authorized action checked against the reviewed head, repository rules and current accepted Specs.
After selection, prepare approved issue closure/comment and roadmap updates. Project status expresses maintainer intent, never a contributor's Task percentage. Different maintainers can review in parallel without sharing their Task lists.

Delivery records: `{operation_id, destination_ids, action, approved_payload_hash, base_head?, state, remote_receipt}`.
States are prepared/approved/sending/confirmed/unknown/conflict; approved payload/destination changes require renewed authorization.
Commit local intent before network I/O; confirm exact remote identity/hash afterward. On timeout/crash, reconcile branch/PR/comment identity before any resend; never assume `clientMutationId` supplies exactly-once semantics.
Use a public opaque delivery marker (no private IDs) where appropriate to find an authored comment; if outcome remains ambiguous, keep `unknown` for user resolution rather than duplicate it.
Use ordinary branch pushes; non-fast-forward means conflict resolution and a new preview, not force overwrite.
Default roadmap edits are proposals/comments or repo PRs. An approved Projects-field update is a best-effort native mutation with an explicit human-edit race, never advertised as CAS; prefer a repo roadmap when reviewed concurrency is required.
Use chosen add/remove-label operations without replacing unrelated labels. Never derive labels/comments from private lifecycle events automatically.

## 7. Transport, privacy and credentials

Triggers: explicit import/refresh, verified webhook/notification, one reconnect catch-up, or pending approved delivery. No idle polling, directory-scan timers, periodic SQL heartbeat/checkpoint writes or idle token refresh.
Repo `push`, issue/PR and supported Project events invalidate addressed resources. Validate [raw-body webhook HMAC](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), host/installation/repository scope and delivery identity before durable acceptance.
No personal-Project hook means on-demand refresh. Notification support means an actual pushed notification or user opening one; it must not hide a notifications-API poller.
Webhook ingress is optional, separately authenticated, and never exposes Butler's control listener. A later relay may deliver tenant-scoped hints; it has no private ledger or execution authority.
Missed-event repair uses one resumable snapshot at explicit refresh/reconnect. Git ref comparison identifies changed Spec paths; staged Project pages publish their local snapshot only when complete. GitHub gives no atomic multi-page issue snapshot: show observation times and revalidate selected items before contribution/delivery.

Serialize provider requests; honor `Retry-After`, reset times and GraphQL cost. Retry timers exist only for pending work, with bounded attempts and visible deferred state. Fetch every page/field needed for complete content; GraphQL partial errors prevent a success/completeness receipt.
No truncation to satisfy latency or rate limits. Exceeding a work budget yields an explicit resumable partial import with exact known progress, never a false total. An unchanged refresh performs no domain or outbound writes.

- Only approved deliverables leave the machine as project content. Read/import necessarily sends provider authentication and resource identifiers, never private ledger bodies. Commit diffs/history, author identity, PR text, issue links and attachments all belong in the outbound preview.
- Never publish Plan/Work/Task/attempt/review records, SQLite/WAL, private Specs, transcripts, prompts, hidden reasoning, raw tool logs, credentials, local paths or internal IDs. A public evidence summary is separately authored; do not serialize private objects then hope redaction is enough.
- Push from an inspected delivery ref containing only approved commits/files; inspect reachable history for accidental private material. Keep internal storage outside the shared repo and exclude it from staging. Private repositories still require approval and destination/visibility checks.
- Use the minimum provider permissions for selected repositories: Contents/Issues/Projects read for import as supported; fork/branch Contents write, Pull requests write, Issues write or Projects write only for the approved destination/action. Probe organization policy/SSO and owner/API capabilities; no silent token-scope escalation.
- If forks are forbidden, use an authorized upstream branch or prepare a patch for the user; do not copy private code to a public fork. Repository and Project visibility are separate checks.
- Tokens, refresh material and webhook secrets use the OS credential store through `crates/butler-platform` (Keychain, Linux Secret Service, Windows Credential Manager). Persist opaque credential refs only; unavailable/locked system store blocks connection, with no production file fallback. Refresh expiring credentials on real work; never expose secrets in URLs, argv, logs or model/UI context.
- Allowlist hosts/destinations, never forward credentials across untrusted redirects, reject path traversal/symlink escape during Spec import, and treat issue/Spec/PR prose as untrusted input. Do not execute repo hooks, scripts or PR code merely by importing it. Tests use isolated fake credentials.
- Disconnect stops inbound transport and pending outputs; retained local evidence stays private. Already published content remains remote. Revocation prevents new remote effects; it cannot pretend an in-flight external action was rolled back.

## 8. Performance targets and complete-result checks

These are implementation acceptance targets, **not measurements from this document-only task**.
Retain applicable budgets from the earlier proposal; shared-task export/authority budgets are obsolete because that feature is removed.

| Scenario | Budget and correctness assertion |
|---|---|
| Quiescent 10 minutes, UI open/closed, connected events | **0 sync HTTP requests, 0 source reads, 0 SQL write statements, 0 sync-attributable disk bytes** after startup settles; compare disabled baseline and prove no outstanding work was suppressed. |
| Owner-scale fixture | 7 GB BTCC, 1.3 GB app DB, 600+ chats/~300k events, 2,440 transcripts/1.5 GB (largest 290 MB), metrics >300 MB; 10k imported items, 50k links and 1k Spec revisions. Touch no transcript/metrics bodies. |
| Status / first 100 imported rows | p95 ≤50 ms service, ≤100 ms UI acknowledgement, 0 network; assert exact total, stable order, revision/freshness and retrieval of all remaining pages. |
| One changed issue ≤16 KiB, no nested overflow | ≤3 provider reads after auth setup, **0 outbound mutations**; local reconcile p95 ≤100 ms, event→projection ≤2 s at 100 ms fixture RTT without backoff; assert complete values and newest observed revision. |
| Explicit unchanged 10k-item board snapshot | ≤102 GraphQL requests (2 discovery + 100 pages, ≤8 fields/item, no nested overflow), **0 domain/outbox writes**. Additional nested content costs exactly its required pages; assert every item/field and honest visibility. |
| Changed 16 KiB import, excluding initial git hydration | ≤512 KiB incremental durable bytes including WAL/receipt/body; ≤64 MiB memory above baseline; assert hash/readback, receipt and exact counts. |

Initial repo/board hydration streams in a background job with visible completeness, not a UI full scan. Read changed git objects once; cache immutable content by OID while always rechecking accepted refs on a trigger.
Timed tests must assert latest state, full content/count/order and privacy; reduce work, never fidelity. Measure disk/resource counters through `butler-platform`; no OS-specific measurement code elsewhere.

## 9. Phases and acceptance

Implementation depends on integrated work-model publication/activation, criterion review, propagation and Queue/Steer recovery. Do not build a second legacy execution path.
Each phase uses public CLI/gateway/adapter paths with stub models and a local recorded GitHub API fixture server; no live GitHub/model calls in CI.

| Phase | Deliverable and required E2E acceptance |
|---|---|
| 1 — one-project GitHub contribution | Repo Specs + Issues + Projects on-demand import, private Work creation and approved PR delivery. **LS-01:** import alone creates no Work/effect; contribute pins exact complete Spec tree. **LS-02:** two independent Butler data dirs import one issue, run different private Tasks and propose two PRs; remote payloads contain neither graph; maintainer can select either. **LS-03:** private-repo/fork restrictions, explicit output preview/approval, no writes before approval, full pagination/visibility. |
| 2 — revision and delivery recovery | **LS-04:** concurrent Spec PRs, merge conflict, accepted merge and propagation through leaf/ancestor/parent criteria; completed evidence retained, siblings unaffected, private candidate stays provisional. **LS-05:** edited/closed/reassigned issue and roadmap change with active A + queued B/C; Queue, Steer, cancelled/blocked anchors and restart lose no instruction. **LS-06:** crash before/after publication, activation, push/PR/comment and receipt; unknown outcome reconciles without duplicate outputs. Required before production use. |
| 3 — maintainer and events | **LS-07:** triage, two candidate reviews, changed PR head, approved review/roadmap/merge actions; no contributor internals imported. **LS-08:** webhook signature/replay/cross-project denial, duplicate/out-of-order/missed delivery, access loss, personal Project fallback and reconnect; honest freshness, no polling. **LS-09:** every §8 budget plus complete content/privacy assertions. |
| Later — Jira, then Obsidian | Shared request/roadmap and document-proposal adapters only, same private execution boundary. **LS-10:** adapter conformance for stable identity/revisions, lossless content, permissions, event/on-demand refresh and approved output; Jira workflow mapping and vault rename/conflict/path boundaries. No Tasks/subtasks replication. |

Fixtures: record sanitized REST/GraphQL requests/responses and webhook traces from a dedicated disposable repo/Project in a separately authorized capture step.
Preserve API/schema version, method/path/query/variables, bodies, multi-page cursors, actor/resource relationships, headers, cost and failures; replace IDs consistently and synthesize test HMAC. Include local bare git repos for commit/blob, fork and merge histories.
CI disables external egress and replays a fixed clock, including 401/403/404, partial results, rate limits, lost responses and concurrent human edits. Missing fixtures fail; no automatic live fallback. Any separately needed model recording uses only `openai/gpt-6-luna`.
E2E lives in `R/crates/butler-e2e`, ≤8 threads. Non-E2E exceptions only race/security/pure-logic/format-pin, tagged within the shrink-only ratchet; no UI unit tests or screen recordings.
When implementation touches these paths, also run existing Ledger publication/source-head/CLI/state-machine tests and `credential_store`, `cli_surface`, `queue_admission_shutdown`, `queue_shutdown`, `queue_pause`, plus integrated work-model propagation/review E2Es.
All checks/tests use fresh temporary HOME/BUTLER_DATA under TMPDIR, isolated test credentials and cleaned task-owned target dirs; cargo `-j 8`, one build at a time.

## 10. Decisions for the Canon deep-dive

The owner will decide **what syncs and what each direction may update**, row by row. These recommendations do not authorize implementation or remote writes.
**Pull** = Canon → private imported snapshot/reference; **push** = a separately authored, user-approved output to Canon, never replication of its private source record; **none** = no transfer.
In the table, **R** marks the recommended option; **A** lists alternatives. “Project Ledger” includes its private BTCC execution state. Canon owns shared truth; a retained local copy is not a second authority.
For every push, the local user approves exact content/action/destination and the provider checks the actor's permissions. Approval may already exist in the user's instruction; it cannot be inferred from an imported item.
All rows inherit no idle polling and no private execution export. Fixed privacy boundaries are marked **fixed**, not reopened as alternatives.

| Candidate object | Lives in (R) | Direction (R) | Who may update it (R) | Trigger (R) | Conflict rule (R) | Alternatives / owner choice (A) |
|---|---|---|---|---|---|---|
| Shared Spec node / tree / criteria | Canon repo; imported Project Ledger reference | Pull; push proposed Spec PR | Contributor proposes; maintainer accepts; local owner activates | Import/refresh or accepted-ref event; approved proposal | Stable node/criterion IDs; reviewed git merge; local revision fences | Repo's existing schema/location vs `specs/<stable-id>.md` + frontmatter/tree manifest; disable Butler proposal output |
| Immutable shared Spec revision | Canon commit + path/blob OID; retained Project Ledger body | Pull; push only as new proposed revision | Authors create new revisions; nobody rewrites retained content | Fetch changed accepted ref; PR merge | Commit pins tree context, blob pins bytes; divergence requires reconciliation | Pin release refs instead of accepted branch; exact source bytes plus parser version vs agreed canonical serialization |
| Private Spec elaboration | Project Ledger only | None | Local user/in-scope Butler | Local goal/replan | Immutable publication + BTCC activation | **Fixed private record**; optionally author a separate Canon Spec proposal without exporting local body/history |
| Roadmap / milestone / iteration | Canon Projects + issue milestones; local Plan reference | Pull; push approved roadmap proposal/edit | Maintainer; delegated project editor | Refresh/event; approved prioritization change | One authority per field; native API race is visible, no CAS claim | Repo roadmap via reviewed PR; pull-only board; choose who can edit dates/rank |
| Shared issue / work item | Canon Issues; imported item referenced by private Work | Pull; push approved new issue/comment or maintainer edit | Issue author and authorized maintainers | Refresh/event; explicit contribute/triage action | Preserve observations; reread before edit, report race; no Work lifecycle coupling | Import selected issues vs whole project; comments-only output vs native body edits |
| Labels / shared status | Canon Issues/Projects | Pull; push only chosen labels/status | Authorized triager acting for approving user | Event/refresh; approved triage action | Add/remove chosen labels, preserve others; field updates have native race | Pull-only; maintainer-only changes; proposal comment instead of field update |
| Assignees / issue closure | Canon Issues | Pull; push approved maintainer operation | Maintainer or provider-authorized actor | Event/refresh; explicit assignment/selection | No contributor lock or private Task completion; recheck current state | Pull-only in first release; author may close own issue where permitted |
| Discussion / issue comments | Canon issue threads; optional Discussions | Pull selected context; push authored comment | Authorized participant for approving user | Open thread/event; approved reply | Retain comment ID/body hash; append by default, detect edits/deletion | Link-only/no import; Discussions adapter later; allow editing own comments after new preview |
| Code PR / Spec-change PR | Canon repo + PR; local delivery receipt | Push proposal; pull PR state/diff | Contributor pushes own proposal; maintainer reviews/merges | Approved delivery; PR/accepted-ref event | Pin base/head/Spec refs; changed head invalidates approval, reconcile unknown send | Patch-only delivery when forks unavailable; separate code and Spec PRs vs combined PR |
| Review verdict against Spec criteria | Authored Canon PR review; private review remains Project Ledger | Pull public verdict; push selected authored verdict | Authorized reviewer; user approves public verdict | Review request/head change; approved review | Verdict pins PR head + Spec/criterion refs; stale verdict cannot prove current coverage | Text-only verdict vs structured criterion summary; independent reviewer policy; pull-only |
| Decision records / ADRs | Shared ADR in Canon repo; private reasoning in Project Ledger | Pull shared ADR; push separate proposed ADR | Contributor proposes; maintainer accepts | Linked Spec import; approved decision PR | Stable ADR ID; supersession + reviewed merge, preserve history | Issue/Discussion decision record with immutable snapshots; link-only import; private decisions never transfer |
| Release notes | Canon repo changelog (recommended) | Pull selected release; push approved notes PR | Maintainer/release editor | Release view; approved release preparation | Pin release commit; reviewed additions/corrections | GitHub Releases as authority; links only; no Butler publication in first release |
| Public test/evidence summary | Canon PR/check links; raw attempts/evidence private | Pull public evidence; push selected reproducible summary | Contributor/reviewer with user approval | PR preparation/review | Pin code and Spec refs; distinguish missing/failed evidence; no raw-log export | Links-only vs attached approved artifacts; format agreed per project |
| Plan / Work / Task / dependencies | Project Ledger/BTCC only | None (**fixed**) | Local user and granted Butler sessions | Admitted local instruction | Work-model graph/revision/lease fences | No shared variant; Canon roadmap/items may be referenced, never replicated from these records |
| Attempts / private reviews / prompts / execution history | Project Ledger/BTCC only | None (**fixed**) | Local execution/review owners | Local execution/checkpoint/review | Preserve immutable evidence and completion history | No record export; separate public verdict/evidence rows above cover authored outputs |

Cross-row choices for the discussion: select the repo Spec convention and roadmap authority above; decide which optional Canon objects enter the first release; choose on-demand-only import vs verified events, and Queue by default vs an explicitly granted typed Steer policy for accepted Spec changes.
The recommendation is Queue for in-scope revalidation, with pending observations if no follow-source grant exists; neither choice lets Canon prose expand local scope or effect permission.
Pending after this proposal: the owner's row decisions, product implementation/recorded fixtures (§9), and runtime/platform/performance proof (§§8–9). Numerical budgets are targets, not measurements.
This design task publishes no data to the owner's Project Ledger. Coordinator batches branches and runs CI; this branch opens no PR, merges nothing and creates no tag.
