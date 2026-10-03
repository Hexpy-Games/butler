# Butler lifecycle hooks

Status: research/design proposal, 2026-10-03; no product implementation.
Tracking: [#166](https://github.com/Hexpy-Games/butler/issues/166), reused after open/closed searches for `hooks` and `훅`; no duplicate issue.
Owner request (verbatim): **“버틀러 훅 제공”**.
English restatement: let users attach their own actions to BTCC and Butler lifecycle boundaries, including sessions, model/tool calls, approvals, Tasks, message delivery, schedules, memory and updates.
Delivery: `codex/hooks-research`; coordinator batches implementation review/CI; no PR, merge, tag or live Ledger publication on this branch.

## 1. Goals, boundaries and evidence

Provide explicit, inspectable, versioned integrations with deterministic decisions, bounded execution and recoverable delivery. Hooks observe canonical facts; they never become a second scheduler, authority service or Work graph writer. Default is no hooks and no hook-related disk writes, workers, timers, serialization or model calls. One predictable in-memory enabled-bit check is the unavoidable disabled-path cost.

Non-goals: arbitrary code inside the agent process; automatic execution from cloned repositories; inbound webhooks; prompt/agent hooks that call models; transcript export; automatic approval; changing model/tool arguments or Work completion through hook output; compatibility with every third-party hook schema. User-installed integration endpoints may act on external services, but receive no Butler control credential.

Evidence baseline: `10b68356da71fafdd3c5551ef7cb62d51ee35da3` (current code and `origin/main` at research time). `R/` means `packages/butler-agent/rust/`; all code references below are relative to the repository root after expanding that prefix. These are source observations, not runtime measurements.

| Existing seam / finding | Verified source at baseline | Design consequence |
|---|---|---|
| `RouteHooks` records internal model-route events, not user extensions | `R/crates/butler-turn/src/btcc/model_route/hooks.rs:21`, `:44` | Do not expose its storage/fencing interface to user code. |
| Physical model attempt is distinct from accepted/replayed round | `R/crates/butler-turn/src/btcc/model_route/routed.rs:274`, `:305` | Attempt IDs distinguish retries/fallback; replay never invents another physical call. |
| Effect dispatch checks permission before and after journal claim | `R/crates/butler-turn/src/btcc/effects/execution.rs:78`, `:96` | Gate before final dispatch; preserve the final permission/fence check after waiting. |
| Approval holds structured action/targets, including potentially private examples | `R/crates/butler-turn/src/btcc/authority/approval.rs:28`, `:103` | Build a separate metadata DTO; never serialize the approval wholesale. |
| App session creation already appends an event | `R/crates/butler-gateway/src/gateway/application/sessions/write.rs:39`, `:109` | Reuse canonical commit identity, not desktop mount/unmount. |
| Queue has durable reservations/claims, wake and recovery owners | `R/crates/butler-gateway/src/gateway/application/queue.rs:101`, `:170`; `R/crates/butler-gateway/src/gateway/application/queue_dispatcher.rs:89`, `:231` | Extend ingress/receipt boundaries; no parallel queue or polling. |
| Schedule dispatch publishes `automation.run` | `R/crates/butler-gateway/src/gateway/application/automations/dispatch.rs:158`, `:184` | Public hook vocabulary uses `schedule`; attach once to durable run admission. |
| Memory tools call shared publishers | `R/crates/butler-agent/src/host/guided/tools/memory_write.rs:54`, `:77`, `:123` | Instrument committed publication, including non-tool writers, not just tool return. |
| App update `apply` downloads/stages, does not prove installation | `R/crates/butler-runtime/src/operations/update.rs:125`, `:156`, `:168` | `update.installed` needs post-activation version confirmation; staging is different. |
| Linux/Windows protection is unavailable; macOS permits reads by default | `R/crates/butler-platform/src/command_sandbox/unsandboxed.rs:1`; `R/crates/butler-platform/src/command_sandbox/macos.rs:11`, `:23` | Existing wrappers alone cannot safely run hooks; platform containment is a release gate. |
| Process-tree and secret-store abstractions already exist | `R/crates/butler-platform/src/process_control.rs:1`, `:47`, `:62`; `R/crates/butler-platform/src/secrets.rs:245`, `:298` | Extend these ports for containment and internal signing; never pass their credentials. |

Architecture authority: [approved Work-model design](https://github.com/Hexpy-Games/butler/blob/0df4b6203b82922fc77cadd2cd41e7fac79d0b35/plans/work-model/work-model-design.md), `origin/codex/work-model-design` at `0df4b6203b82922fc77cadd2cd41e7fac79d0b35`. In that document, lines 5–7 define Tasks/Queue/Steer, 71–79 hybrid storage, 115–122 attempts and tiers, 164–174 reviewed completion and invalidation. Those decisions are binding, not open questions here:

- Tier 0 has no Spec/Work/Task; use Turn events. Tiers 1/2 use canonical Task IDs, exact Spec revisions, attempts and completion reviews.
- Queue releases after the current answer in Tier 0 and current Task in Tiers 1/2; Steer applies at the next safe point, at every delegation depth.
- Ledger stores immutable Spec bodies; BTCC SQLite owns mutable graph/lifecycle. Hooks neither edit store nor select graph transitions.
- The user's request grants in-scope Spec authoring; hook trust is executable/network authority, not a new Spec approval ceremony.

## 2. Primary-source comparison

All sources below were accessed **2026-10-03**. Documentation is mutable; these observations describe the fetched pages, not an assertion that older installations support them. Trade-offs and recommendations are Butler design judgments.

| Prior art / official source | Observed contract | Butler choice and trade-off |
|---|---|---|
| [Claude Code hooks](https://code.claude.com/docs/en/hooks) | Session/tool/prompt/permission/task/stop events; exact/list or regex matchers; JSON stdin/stdout or HTTP POST. Exit 2 blocks where supported; JSON decisions vary by event, including permission decisions and tool-input updates. Matching handlers run concurrently. Current defaults: command/HTTP/MCP 600 s, prompt 30 s, agent 60 s, with event exceptions; async command timeout is not enforced. | Adopt explicit event schemas and separate before/after semantics. Use bounded exact filters, shorter enforced deadlines and deny-only gates; lose arbitrary argument rewriting/context injection, gain reviewable authority and latency. Do not inherit environment/transcript paths. |
| [Git hooks](https://git-scm.com/docs/githooks) | Executables under hooks directory or `core.hooksPath`; event-specific argv/stdin, cwd/environment and exit status. Pre-commit failure can abort; post-commit cannot change the outcome; some hooks can be bypassed with `--no-verify`. | Useful pre/post distinction and simple command adapters. A hook is not Butler's security boundary; no bypass flag can bypass effect policy. Versioned JSON is more portable than per-event positional arguments. |
| [Codex hooks](https://learn.chatgpt.com/docs/hooks), [plugin packaging](https://developers.openai.com/plugins/build/plugins) | Current docs describe lifecycle command/MCP hooks, merged user/project configuration, concurrent commands and trust review. PreToolUse supports denial and supported input rewrites; PermissionRequest can decide. Most timeouts default to 600 s; SessionEnd/Interrupt default 1 s, max 3 s. Plugin installation does not itself trust hooks. | Codex is no longer merely a completion-notify comparison. Adopt content-bound trust and plugin packaging; do not copy permission overrides or runtime-specific rewrite support. Pin Butler's smaller schema independently. |
| [OpenCode plugins](https://opencode.ai/docs/plugins/) | JS/TS plugins expose event callbacks and tool before/after hooks, including mutable tool args. Session, message, permission and installation events exist. Global/project config and directories load in documented sequence; local code auto-loads, npm dependencies install at startup. | Plugin ergonomics are useful; in-process execution and automatic dependency installation do not meet isolation/idle goals. Butler plugins declare ordinary command/HTTP hooks, without privilege or a second runtime. |
| [Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) | Signed payloads use stable `webhook-id`, timestamp and signature; verify raw bytes, freshness and duplicates. Retries require idempotent receivers. | Adopt authenticated outbound delivery and stable delivery IDs. Network uncertainty precludes exactly-once external side effects; HTTP starts as observation-only, never a remote approval authority. |

Adapter options: (A) synchronous commands everywhere are familiar but unsafe on current Linux/Windows and sensitive to startup latency; (B) native/in-process plugins are fast but can hang/crash/read all agent memory; (C) brokered HTTP plus isolated command/plugin adapters costs an outbox and containment work but preserves authority. **Recommend C**, phased HTTP-first; no unsandboxed fallback.

Platform evidence: [bubblewrap upstream](https://github.com/containers/bubblewrap) provides namespace-based isolation primitives, with security depending on the constructed policy; [Windows AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) scopes files, processes and networking; [PowerShell invocation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh) documents `-NoProfile`, `-NonInteractive`, `-File`. These are candidates and contracts, not proof that Butler already has suitable containment. Existing macOS Seatbelt code above must gain a tested allowlist profile; broad file-read permission is insufficient.

## 3. User-facing behaviour and configuration

Settings → Hooks (“훅”): list scope, event, action, enabled/trust/platform status and last outcome; details show exact executable + argv or endpoint, disclosure fields, timeout, delivery policy and grants. Actions: add, inspect, review/enable, disable, synthetic test, retry failed delivery. No banner or transcript injection. A blocked model/tool operation shows “훅에서 차단됨”, hook name and a link to settings; it does not ask the model to keep retrying.

Use only `@/butler-ds`: `SettingsPage`, `SettingsSection`, `SettingsField`, `Input`, `NativeSelect`, `Switch`, `DialogForm`, `Typo`, `Button`, `ButtonContainer`, `Toaster`; inspect the DS Viewer before implementation. Activity uses existing settings list/status layouts with cursor pagination. No new product CSS, raw controls, inline styles or UI unit tests. Validate keyboard and 320/375/390/430 px plus desktop, en/ko, light/dark and reduced motion. Copy says “예약 작업” / “schedule”.

Configuration locations (new contracts): global `$BUTLER_DATA/hooks/config.json`; project `<registered-project-root>/.butler/hooks.json`; plugin manifest `hooks` declarations scoped to their installed package. No ancestor walking, cwd-based discovery, Git-hook import or code auto-download. Project files only propose hooks. A host-owned trust record under `$BUTLER_DATA/hooks/trust.json` binds canonical project root, configuration digest, handler/package digest, interpreter identity and exact capabilities. Hooks cannot write either global data or trust files. Enabling globally still requires owner review.

Load once at startup/project attachment; changes through the settings API publish an in-memory registry revision after atomic persistence. External edits require explicit Reload; **no polling or filesystem watcher**. Validate complete configuration, preserve active snapshot on parse failure, and show the candidate error. New/untrusted handlers stay inactive; changed executable bytes invalidate trust before their next spawn. Stage reviewed code into an immutable, content-addressed bundle so replacement between hash and execution cannot run different bytes. Dependencies/interpreter upgrades also invalidate that bundle's trust. Configuration selection uses an immutable snapshot; revocation additionally fences already queued/running work.

Merge is additive by qualified ID `(global|project:<id>|plugin:<id>, local_id)`; duplicates within one scope are errors. Project config cannot replace/disable a global gate. Owner disables it through global settings. Sort gates by `(scope_rank global/project/plugin, order, qualified_id)`; order is an integer, never discovery order. Observer deliveries for one hook and source stream are FIFO; different hooks/streams may run concurrently. No global order across independent databases/sessions is promised.

```json
{
  "schema": "butler.hooks.config.v1",
  "hooks": [{
    "id": "task-notice", "enabled": true,
    "events": ["task.completed"], "mode": "observe", "order": 0,
    "match": {"tier": [1, 2]},
    "handler": {"type": "http", "url": "https://hooks.example.org/butler"},
    "timeout_ms": 3000, "delivery": "retry_idempotent"
  }]
}
```

`enabled` expresses intent, not trust. Event names are exact, required lists (no implicit future-event wildcard). Filters are AND across typed fields, OR inside exact-value sets: `tier`, `tool_name`, `provider_kind`, `status`, `component`, `origin`; event-specific unsupported fields fail validation. Project scope is enforced before filters. No content regex, arbitrary predicates or template substitution. Limits: 256 hooks per resolved registry, 32 filter values per field, 256 KiB config; reject oversize definitions explicitly, never silently drop handlers.

Command variant: `{type:"command", executable:<absolute bundled interpreter>, args:[...], script:<bundle-relative file>}` with per-platform variants; no shell-concatenated event data. Plugin variant: `{type:"plugin", plugin_id, package_digest, entry_id}` resolves to the exact reviewed command/HTTP descriptor; no dynamic library/JS imports in Butler. HTTP endpoint and script values cannot contain secrets; secret-bearing URLs/config values are rejected, not logged.

## 4. Event catalogue and allowed decisions

O = observation-only; G = optional synchronous gate at this boundary, in addition to observers. Every after/terminal event is O. There is **no payload modification in v1**: no prompt injection, tool-input patch, permission allow, queue/steer rewrite, result replacement or lifecycle mutation. A future narrow rewrite contract needs separate design and renewed approval of the changed exact action.

| Events | Canonical timing / identity; fields beyond common envelope | Mode |
|---|---|---|
| `session.started`, `session.ended` | Execution attachment/resumption commits a new `session_epoch`; explicit stop/end settles it. `reason` is created/resumed/stopped/closed/recovered_interruption. Not window close or Turn completion. | O |
| `turn.started`, `turn.completed`, `turn.failed`, `turn.interrupted` | Accepted execution start and committed terminal outcome; one terminal per attempt. Tier 0 uses these without synthetic managed records. | O |
| `model.before`, `model.after` | Before each physical provider attempt; after success/failure/cancellation/unknown outcome is recorded. `round_id`, `call_id`, `attempt`, `provider_kind`, `status`, numeric usage/duration; no prompt, output or provider account/URL. Gate denial produces `model.after` with `status=blocked, dispatched=false`. | G / O |
| `tool.before`, `tool.after` | Normalized logical tool operation before dispatch; after committed/reconciled result, including error, denial and uncertain effect. `call_id`, `effect_id?`, `tool_name`, `capability`, `status`, `dispatched`; no argv, paths or tool body. Pure tools need this seam too. | G / O |
| `approval.requested`, `approval.resolved` | Durable request and actual authority decision; `approval_id`, action kind, target count, status. Exact action remains visible only in Butler's existing approval UI. Cannot block/suppress the card or answer it. | O |
| `task.started`, `task.completed`, `task.state_changed` | Start of each canonical TaskAttempt; completion only after exact-revision acceptance review; pause/stop/block/cancel through the owning Work service. Task/attempt/Spec/review refs, revision, enum status. | O |
| `work.completed`, `review.completed` | Work coverage acceptance and recorded review verdict; emit again only for a new canonical revision, never reinterpret preserved completed Tasks. | O |
| `message.received`, `message.queued`, `message.steered`, `message.applied` | Authenticated durable ingress, queue receipt, accepted steer receipt, and actual safe-point application. `instruction_id`, actor kind user/parent, queue anchor (Turn or Task), instruction sequence, receipt status. No text/attachment paths. | O |
| `schedule.fired` | Scheduler commits one admitted firing/run ID, before downstream message delivery; `schedule_id`, `run_id`, trigger scheduled/manual/catchup, occurrence time. Failed delivery is a status, not a second firing. | O |
| `memory.written` | Authoritative memory publication acknowledged; `publication_id`, record ID, revision, operation insert/update/delete. No memory body or source excerpts; vector/cache refresh is not another write. | O |
| `update.staged`, `update.installed` | Verified staging versus confirmed active installation; `installation_id`, component app/agent, old/new versions. Restart reconciliation confirms a matching pending installation once. | O |
| `subsession.started`, `subsession.ended`, `worktree.bound`, `worktree.released` | Existing #166 scope; canonical relation/lease commit, IDs and enum reason only. Child startup is separate from its first Task start; no absolute worktree path. | O |

`model.before` and `tool.before` gates may **continue** (meaning “no hook objection”) or **deny**. Continue cannot grant any capability. Run gates serially; first denial/error ends the chain, later gates get `not_run` audit outcomes. No network HTTP gates in v1. Gates never hold SQLite transactions, model stream locks or scheduler locks while waiting. Re-check current approval, protected targets, Task/Spec/lease/control epochs and hook revocation immediately before dispatch. Stale admission is cancelled/re-admitted; never execute using a pre-hook approval snapshot.

`task.completed` cannot veto a committed fact; acceptance belongs to the Work model's review criteria. Gates do not run on stop, shutdown, queue/steer ingress or hook delivery itself. Disable/edit/reload remains usable while a gate is stuck. Model/tool gates returning denial must not trigger provider fallback or an automatic model retry loop.

## 5. Input/output and API contracts

A privacy allowlist constructs the DTO from typed facts, never by deleting keys from a raw event. Required envelope keys below are stable; irrelevant refs are null. `source_seq` orders one source stream; `causation_id` links related facts across streams without pretending they share a transaction. `delivery_id` is stable for `(event_id, qualified_hook_id, config_revision)` across retries; `delivery_attempt` changes.

```json
{
  "schema": "butler.hook.input.v1", "event": "tool.before",
  "event_id": "evt_01", "delivery_id": "del_01", "delivery_attempt": 1,
  "occurred_at": "2026-10-03T00:00:00Z",
  "source": {"owner": "btcc", "stream_id": "session_01", "source_seq": 42},
  "causation_id": "instruction_01", "config_revision": 7,
  "scope": {"project_id": "project_01", "session_id": "session_01", "tier": 1},
  "refs": {"turn_id": "turn_01", "work_id": "work_01", "task_id": "task_01",
    "attempt_id": "attempt_01", "spec_revision": "spec_rev_01"},
  "data": {"call_id": "call_01", "tool_name": "run_command", "capability": "run_command"}
}
```

Command stdin is one UTF-8 JSON object followed by EOF; stdout is exactly one JSON response ≤4 KiB. Exit 0 plus `{ "schema":"butler.hook.output.v1", "decision":"continue" }` succeeds; gate may return `decision:"deny", reason_code:"policy_denied"`. No free-form model-visible text. Observe handlers return `decision:"continue"` only. Nonzero exit, invalid/multiple JSON, unknown output fields, mutation/approval fields or excess bytes are protocol failures, not implicit grants. Stderr is not parsed or persisted; count bytes up to 4 KiB then terminate on overflow. Output beyond a limit fails the whole invocation explicitly; no truncated result is represented as success. Envelope ≤16 KiB by schema construction; oversized source metadata is a producer contract error, never field truncation.

HTTP POST sends the same DTO and `Content-Type: application/json`; accept 204 or 2xx with the observe response above (≤4 KiB), otherwise classify failure. No response content enters the model. Broker signs exact body bytes using Standard Webhooks' asymmetric Ed25519 scheme, stable delivery ID and fresh attempt timestamp. The private signing key stays inside Butler's secret-store adapter; only signature leaves it. Receiver enrollment receives the public verification key through an owner-controlled operation, never a shared secret or provider/connector/Butler API credential. Rotation supports old/new public-key overlap. Receivers verify freshness and deduplicate the stable delivery ID before effects.

Authenticated local gateway contracts, implemented alongside existing settings/control routes:

| API | Contract |
|---|---|
| `GET /api/hooks` | Effective registry revision, descriptors, origin, trust/platform status; no signing material. |
| `PUT /api/hooks/config` | Scope + expected revision + full candidate; owner/settings authority; 409 stale, 422 invalid; persist atomically, return candidate/effective revisions. |
| `POST /api/hooks/{id}/trust` | Owner review of exact digest/capabilities; no project/model caller may self-trust. |
| `POST /api/hooks/reload` | Read bounded known config paths, validate, atomically publish; no polling. |
| `POST /api/hooks/{id}/test` | Synthetic metadata only; preview mode does not execute. Execute mode uses the real grants/runner and is explicitly selected by owner. |
| `GET /api/hooks/runs?cursor=&limit=50` | Stable indexed pagination, total/outcome counts and complete retained records; max page 100. Existing authenticated event stream signals revisions, reconnect gets a fresh snapshot. |
| `POST /api/hooks/runs/{id}/retry` | Owner-only; same delivery ID for idempotent retry, explicit warning/status for an uncertain command; never replays the underlying model/tool/Task. |

Trust/control endpoints are excluded from model tools and from hook credentials. Config schemas reject unsupported major versions; event schemas add only optional fields within v1, while decisions remain closed enums. A handler declares its accepted major version; incompatible handlers are inactive with an explicit reason.

## 6. Architecture, delivery and failure isolation

`butler-core` holds public DTOs/ports; `butler-turn` owns BTCC event boundaries and gate admission/fences; `butler-gateway` owns authenticated configuration/read APIs and App-source events; `butler-memory` and `butler-runtime` own publication/update facts. Agent composition wires a bounded hook dispatcher and adapters. OS shell selection, sandbox creation, filesystem handle protection, process containment/cancellation and resource accounting live **only in `crates/butler-platform`**. No new dependency from domain code to gateway/UI/platform-specific implementation.

Each domain mutation and its subscribed event/target snapshot are atomic in that domain's existing transaction lane. No second lifecycle store: the hook outbox contains only immutable DTOs and delivery state. Reuse Work-model outbox records after that design lands. App and memory retain their own source transaction identities, with a source-local outbox/cursor where needed; a cross-source dispatcher never requires a distributed commit. For file-based memory publication/update activation, record a pending publication/installation ID before the side effect, then reconcile that exact receipt/version on startup to create its event once. Do not infer facts by scanning transcripts or watching arbitrary files.

Wake only after commit. The delivery worker reads indexed pending IDs, durably marks an attempt, releases the transaction, invokes the handler and commits a result. An atomic registry snapshot pins recipients/grants at event admission; newly registered hooks do not receive history by default. Disabling/uninstalling revokes pending/running deliveries and records `cancelled_by_owner`; no surprise dispatch to an edited URL. Store unique `(event_id,hook_id,config_revision)`, pending index `(state,next_due,source_stream,source_seq)`, run index `(hook_id,finished_at,id)`.

Observation is durable at-least-once attempt delivery, **not exactly-once action execution**. Default command policy `manual_on_uncertain`: crash after spawn/before acknowledgement gives `outcome_unknown` and waits for owner reconciliation. Idempotent HTTP/command registrations may choose retry policy: initial attempt plus 3 retries after 1/5/30 s, one-shot timers only while pending. Same delivery ID; no retry of gates. Retry exhaustion is retained as `failed`, with explicit manual retry. Unknown/failed predecessor holds later events on that hook/stream until owner resolves or explicitly cancels; other streams/hooks continue.

Restart first restores source readiness/fences, then outbox workers; recover the active turn **and every queued follow-up**. A crashed pre-gate never caches a permission grant: resume revalidates scope/epochs and re-runs a side-effect-free gate if needed. Source owners emit `model.after status=unknown` for an unresolved physical attempt, rather than inventing success. Logical tool replay is not another tool execution. Session interruption is synthesized from a durable active epoch only, with a stable recovery event ID.

| Mode | Deadline / cancellation | Failure |
|---|---|---|
| Gate (isolated command/plugin) | Default 1,000 ms, configurable 50–2,000 ms; aggregate chain ≤3,000 ms including queue wait/spawn/read; max 8 gates per event | Deny on timeout, unavailable platform, malformed result, crash or overload. Record why; no fallback to allow. |
| Observer (HTTP/command/plugin) | Default 3,000 ms, max 10,000 ms including DNS/TLS/process startup | Record failure and use declared retry/uncertainty policy; cannot undo the source fact. |
| Shutdown | Stop new starts; ≤500 ms total hook drain/termination inside existing shutdown deadline, without raising it | Contained processes terminate; unfinished durable records recover as interrupted/unknown. Never block shutdown for retry timers. |

Maximum 8 active invocations, ≤2 per hook; gates reserve 2 slots, observers at most 6. Gate runners have no side effects/network/workspace access, only input + immutable code and scratch. Async workers sleep on notifications and earliest pending deadline; no idle timer, retry heartbeat or global scan. Blocking SQLite/file work stays on existing lanes or `spawn_blocking`, never Tokio workers.

Bound the in-memory ready queue at 256; excess accepted events stay in the durable indexed outbox, never dropped. Admission reserves outbox space before subscribed operations: 100k pending deliveries or 256 MiB pending DTOs triggers an explicit resource-exhausted receipt before a new initiating action, not silent loss. Reserve 16 MiB separately for terminal/control receipts; stop and already-admitted terminal facts use their canonical journals even if the delivery spool is full, retaining their replay cursor until space returns. Infrastructure pressure can prevent new work, but an observer's response cannot veto committed work. No finite machine guarantees progress when the underlying disk itself fails; surface the existing storage failure and preserve recovery evidence.

## 7. Security and platform contract

Threats: malicious repository config/script/plugin; prompt injection in content; secret exfiltration; protected-path writes; SSRF; runaway children; replay; TOCTOU after approval; event recursion. Explicit trust permits only the displayed action/capabilities, not blanket execution authority. Security defaults do not broaden with full-access conversation mode.

- **No secrets or private content:** payload is IDs/enums/counts/timestamps only, never prompts, message text, memory bodies, paths, raw tool args/results, headers, environment or transcript pointers. IDs are opaque internal IDs, not titles/paths supplied by a user. HTTP reveals this metadata only to its reviewed endpoint. Error logs use fixed codes, not exception strings/response bodies.
- **Command confinement:** fresh temporary HOME/TMP, cleared environment plus minimal platform startup variables from an explicit allowlist, pinned interpreter/runtime, no inherited handles/sockets/agent tokens/SSH agent/keychain session bus/proc access. Only immutable reviewed code and empty scratch are mounted. No arbitrary workspace read: a secret can occur in any file, so redaction or a `.env` denylist cannot guarantee this contract.
- **Actions:** commands can produce scratch artifacts; optional workspace writes are proposed as typed artifact-copy effects through existing authority, with exact destination and content hash shown before approval. Hooks never write workspace/protected paths directly. Artifact proposals are a separate broker API, not v1 decision output, and remain unavailable until its acceptance phase. Hook state is private scratch by default; persistent per-hook storage requires a bounded, reviewed grant outside protected roots.
- **Protected means protected:** deny read of credential/private stores and write of Butler data, trust/config, databases, installation, Git control directories and policy-protected locations; no grant can override those denials. Resolve symlinks, hardlinks/reparse points and path changes using platform handles. A trusted local program run outside containment could bypass Butler: this design never offers that mode.
- **HTTP egress:** HTTPS, exact reviewed origin/path, TLS verification, no redirects, cookies, ambient proxy credentials or userinfo/query secrets. Resolve and pin checked addresses per connection; reject loopback/private/link-local/multicast/metadata IPs, mixed answers and DNS rebinding, including IPv6 forms. v1 excludes local HTTP endpoints and prevents access to Butler's control listener. Testing uses an injected transport, without weakening production policy. A separately reviewed local endpoint feature is future scope.
- **Plugins:** installation enables nothing; pin full package digest, prohibit install scripts/dynamic dependencies, require the same per-hook grants and containment. No arbitrary native library or in-process callback. Provider credentials are never passed; HTTP signing keys stay in the broker. Third-party services' own credentials remain managed by those services.
- **Recursion:** hook invocations are not model/tool lifecycle events. Broker actions carry immutable `origin=hook`/causation and cannot register/trust hooks or call control APIs; follow-on observations do not trigger any hook by default. A future recursive opt-in needs a separate bounded contract.

| Host | Proposed execution under `butler-platform` | Availability gate |
|---|---|---|
| Linux / WSL | Bubblewrap namespace allowlist, no network, read-only pinned runtime, fresh scratch, no host root/proc/IPC; enforce descendant/resource containment through safe library or helper ports | Probe required kernel features and escape tests. Missing namespace/resource support → `sandbox_unavailable`, never unsandboxed. |
| macOS | Narrow Seatbelt allowlist for pinned runtime + scratch, no home/keychain/network/IPC; platform-owned process containment and resource limits | Existing allow-default profile is insufficient; prove read/IPC denial and detached-descendant termination on supported macOS. |
| Windows | AppContainer with minimal ACL/capabilities, no network/host secrets, Job Object containment established before untrusted execution | Safe wrapper/helper must avoid spawn-before-job race and satisfy workspace `unsafe` ban; missing capability disables command hooks. |

Windows script invocation is pinned `pwsh.exe -NoLogo -NoProfile -NonInteractive -File <reviewed.ps1>`; v1 requires PowerShell 7, no Git Bash or `cmd /c` fallback, no `ExecutionPolicy Bypass`. Linux/macOS invoke a pinned executable/argv or reviewed `/bin/sh` script without login profiles. UTF-8 JSON uses stdin, never command-line interpolation; enforce encoding explicitly in the bundled PowerShell runner. Termination targets only owned sandbox/process handles, including escaped/detached-child tests; plain process-group signaling alone is not claimed to contain hostile children. Limits: 128 MiB memory, 32 descendants, 32 MiB scratch; inability to enforce mandatory limits disables the adapter.

## 8. Observability and performance acceptance

Persist one bounded run record per attempt: IDs/revision, source sequence, queued/start/end times, mode, exit/status/error code, timeout, disclosed-field set, decision and retry count. Never persist stdout/stderr/body. UI shows pending, running, denied, failed, unknown, cancelled and delivered separately; export redacted structured records through the owner API. Existing event stream pushes changes; reads use indexed cursor pages. Retain terminal run history for 7 days with a visible 100k-record cap; prune only on writes, never idle sweeps. Pending/unknown deliveries are never pruned; retention is an explicit product policy, not a performance shortcut.

These are **proposed budgets, not measurements**; existing stricter budgets remain binding. Test optimized builds on the fixed owner-scale runner: App DB 1.3 GB/600+ chats/300k events, BTCC 7 GB, 2,440 transcripts/1.5 GB with a 290 MB maximum and 300+ MB metrics. Add 256 hook registrations, 32 active sessions and eight workers; use generated fixtures, no live owner data. Report p50/p95, CPU, RSS, SQL count, logical and physical write/read bytes including drain/checkpoint. Handler/network time is reported separately, never hidden from end-to-end latency.

| Path | Budget and required correctness assertion |
|---|---|
| No hooks registered | Disabled dispatch p95 ≤1 µs over 1M boundaries; 0 hook allocations, serialization, DB queries/writes, timers, spawns and extra model calls; unchanged canonical event/results/counts. |
| Registered but no matching hook | Match p95 ≤50 µs for 256 entries; 0 payload serialization/spawns/outbox writes, exact matching-set assertion. |
| Observer admission | Incremental commit/enqueue p95 ≤2 ms with ≤4 KiB DTO; no awaiting handler; exact durable recipient IDs and source order, including restart. |
| Gate overhead | Dispatch bookkeeping p95 ≤1 ms excluding handler but including match; full result within aggregate 3 s. All configured gates run or have explicit not-run reason; no effect on denial. |
| Delivery throughput | ≥100 events/s to a local injected zero-latency receiver for 60 s, eight slots; drain ≤2 s afterward; exact 6,000 event/recipient pairs and latest revision, including retries counted separately. |
| Idle after settling | Three 60 s windows, hooks absent and configured: **0 hook-attributable disk-write bytes, 0 polling queries/reads/wakeups**. Preserve whole-process PERF-IDLE gates; source facts and pending counts unchanged. |
| Active storage/RSS | 1,000 ≤4 KiB events, one successful observer: ≤128 MiB added WAL/checkpoint/file writes; dispatcher incremental RSS ≤16 MiB excluding explicitly measured child RSS. All 1,000 payloads/outcomes retained correctly; no sampling/truncation. |
| Activity page | 50 records p95 ≤100 ms warm / ≤250 ms cold with 100k runs; complete stable pages, exact totals/order and newest committed state; no full history scan. |
| Stop/queue | Hook work adds ≤500 ms shutdown drain, never extends existing shutdown budget; preserve Work-model ≤50 ms queue-boundary/wake budget by detaching observers. Verify active turn and all queued follow-ups after restart. |

## 9. Implementation branches and verification

Every phase needs explicit implementation authorization and builds on integrated predecessors. Start with public-path stub E2Es in `R/crates/butler-e2e`; replay only for model behaviour. No real model calls; separately authorized re-recording only `openai/gpt-6-luna`. No new UI unit tests/recordings. Allowed non-E2E additions are tagged `security`, `race`, `pure-logic` or `format-pin` and must fit shrink-only test ratchets. Production files ≤500 lines/functions ≤80; no `unsafe` or OS conditionals outside platform.

| Branch / dependency | Vertical acceptance and E2E/smoke plan |
|---|---|
| `codex/hooks-observe` / design + existing canonical owners | Config/trust APIs, indexed registry, session/Turn/tool observations, durable outbox, signed HTTP adapter and settings list. H-01 disabled/no-match budgets; H-02 authenticated session→stub tool→observer→UI, exact fields/order/signature; H-03 untrusted/malformed/reloaded configs and revocation; H-04 DNS/SSRF, signing and secret canaries; H-05 crash at source commit/attempt/ack, duplicate receiver dedup. No command adapter claimed. |
| `codex/hooks-platform` / observe | Isolated command runner per OS, PowerShell encoding/argv, limits/cancellation, immutable bundles. H-06 malicious scripts try protected reads/writes, traversal/symlink/reparse, network/IPC/credential theft, detached-child escape, env inheritance, fork/memory/output flood; all denied and zero residual child. Supported platforms pass; others explicitly inactive. |
| `codex/hooks-gates` / platform | Model/tool pre-gates, deterministic order, strict JSON/fail-closed deadlines and post-wait authority/fences. H-07 denial/timeout/protocol failure/overload, no effect/model fallback; H-08 approval revoked or Spec/Task epoch changed while gate runs; H-09 active turn + two follow-ups stopped/restarted, same queue/receipts, no repeated effect. |
| `codex/hooks-domain-events` / gates + integrated work-model core/instructions/controls/spec-replan | Complete catalogue: H-10 Tier 0 absence of Tasks, Tier 1/2 reviewed completion/attempts, all-depth queue/steer receipt versus application and stale Spec; H-11 schedule firing dedup, memory publication crash, update staged versus installed/restart, worktree/subsession identity. Instrument all model call owners with call-class metadata; no falsely claimed coverage of background calls. |
| `codex/hooks-plugins` / platform + gates | Digest-pinned plugin declarations use same registry/runner; no auto-install, escalation or recursion. H-12 upgrade/revoke/uninstall and namespace collisions. Optional typed artifact broker only after H-13 exact-action approval + protected target rejection + crash reconciliation; otherwise explicitly unavailable. |
| `codex/hooks-acceptance` / all | H-14 every §8 budget with complete output/state assertions at owner scale, failure backlog and post-drain idle; H-15 DS settings keyboard/responsive/en-ko/light-dark smoke and reconnect snapshot parity; Linux/macOS/Windows/WSL runner evidence. Coordinator performs combined CI once. |

Run existing coverage when its path is touched: `tools_effects`, `queue_shutdown`, `queue_admission_shutdown`, `queue_pause`, `shutdown_order`, `durable_configuration`, `cli_surface`, `schedules`, `schedule_store`, `memory_wiring`, `memory_idle`, `updates`, `update_channels`, `idle_resources`; find model-route/authority and Work-model E2Es again at implementation time. No retries to green, budget increases, ignored failures or reduced-content perf passes. A failure reproduced unchanged on main is searched in open issues and linked/commented the same day.

All tests/checks use fresh HOME/BUTLER_DATA under TMPDIR with cleanup and retained CARGO_HOME/RUSTUP_HOME, via `R/crates/butler-e2e/scripts/isolated-run.sh`. Cargo `-j 8`, one build at a time; E2E threads ≤8. Before each implementation push: fetch origin, follow coordinator integration instructions, fmt, touched-crate clippy `-D warnings`, source-check; frozen Bun install/check for TS/UI. Never touch live services/ports/data. This design-only branch requires fmt/source-check and isolated commit checks; touched-crate clippy and runtime E2Es have no changed production target.

## 10. Risks, owner decisions and self-review

Risks: metadata-only hooks cannot inspect arbitrary tool content or format the live workspace; users may expect Claude/OpenCode compatibility. Containment, especially Windows safe APIs and macOS secret/IPC isolation, may delay commands; HTTP-first remains useful. Durable delivery is more expensive than fire-and-forget but exposes uncertain outcomes rather than fabricating exactly-once effects. Endpoint outages can cause visible backlog/admission pressure. Model/tool event integration must include background owners, while Work events wait for the approved model to land.

Owner decisions (recommendations, not new approval requests for this research):

1. Ship HTTP observations while command containment lands per platform, or wait for command support on all three OSes? **Recommend staged HTTP-first delivery** with explicit capability status.
2. Is metadata-only notification/deny policy plus later approved artifact-copy sufficient for the first release, or is content-aware formatting a required launch use case? **Recommend the former**; the latter requires a separately scoped content-access contract and cannot silently relax “secrets never passed”.

Self-review: [x] one existing issue; [x] primary sources/access date and current file:line evidence; [x] approved tiers/storage/queue/steer/review identity; [x] complete requested event catalogue; [x] deny-only decision/security model; [x] platform-only OS code and DS-only UI; [x] zero idle work/disabled fast path with numeric correctness budgets; [x] ordering, crashes, uncertainty, shutdown/full queue and overload; [x] phased E2E/existing-test/smoke gates; [x] no product changes or live owner access. Self-review corrected two tempting but false shortcuts: current command wrappers are not sufficient containment, and update staging is not installation.

Research-branch validation: isolated `cargo fmt --all` passed without product changes; isolated `cargo run -j 8 -p butler-source-check -- .` passed over **2,181 Rust files**, all enforced violation counts zero. Document validation checked **14 explicit source-path references**, **2 JSON examples** and the ≤400-line bound; `git diff --check` passed. No production crate/TS/UI changed, so touched-crate clippy, Bun checks and runtime E2Es are not applicable. These checks are not runtime performance evidence.

Pending by design: owner decisions above; separately authorized implementation; measured runtime/performance and native-platform proof in §9; coordinator integration. No runtime budgets or containment guarantees have been measured on this research branch. GitHub issue summary and branch push are the review handoff; real Project Ledger publication is excluded by the task's isolation boundary.
