# agent-browser integration

Status: research/design proposal, 2026-10-03; no installed CLI or browser was executed for this research.
Owner request (verbatim): **agent-browser 스킬 통합**.
English: integrate the agent-browser skill/tool with Butler and share its browser installation with the web reader.
Issue: [#475](https://github.com/Hexpy-Games/butler/issues/475). Related: [#171](https://github.com/Hexpy-Games/butler/issues/171), [#165](https://github.com/Hexpy-Games/butler/issues/165).
Branch: `codex/browser-research`. Shared engine/security/lifecycle contract: [Chromium reader design](chromium-reader-design.md), §§4–9.
Source baseline `10b68356da71fafdd3c5551ef7cb62d51ee35da3`; approved Work-model reference `origin/codex/work-model-design` at `0df4b6203b82922fc77cadd2cd41e7fac79d0b35`, §§1, 2.1, 2.6, 3, 7–9.

## 1. Identity and goals

The best-supported interpretation is **Vercel Labs' `vercel-labs/agent-browser`**, not a browser engine, a Vercel-hosted mandatory service, or Microsoft's Playwright MCP. The local `~/.agents/skills/agent-browser/SKILL.md:12` teaches `open → snapshot -i → observed refs → re-observe`, matching that tool. Owner intent beyond this named tool is not claimed as independently confirmed.
Goals: give Butler compact observed-target interactions; progressively disclose useful skill guidance; preserve existing effect authority and Work-model controls; avoid two browser downloads; support Rust agent-only and desktop platforms.
Non-goals: expose every upstream CLI command, replace generic command execution, ship all upstream skills, copy user Chrome profiles, create a second browser daemon supervisor, or add cloud browser accounts. Broader browser capability remains #165.

## 2. Verified primary sources

All URLs in this document were accessed **2026-10-03**. Upstream latest release at access was **v0.38.2**, commit **`39a74c70d7759d5a6de7a22c04570bb626bbd081`**. Pin this revision for the evidence below; mutable docs may move independently. Upstream performance marketing is not a Butler benchmark.

| Topic | Finding / primary source |
|---|---|
| Tool and architecture | [Pinned README](https://github.com/vercel-labs/agent-browser/blob/39a74c70d7759d5a6de7a22c04570bb626bbd081/README.md): native Rust CLI plus persistent Rust daemon, direct CDP; Chrome/Chromium default. Current daemon does not require Node or Playwright. Do not repeat older Playwright-backed architecture descriptions as current. |
| CLI examples | `open URL`, `snapshot -i`, `click @e2`, `fill @e3 TEXT`, `get text @e1`, `screenshot`, `close`; JSON output, sessions, custom executable and CDP attachment are documented in the pinned README. This is a command interface, not an authorization model. |
| Installation | [Official install docs](https://agent-browser.dev/installation): npm global/project, Homebrew or Cargo installation; `agent-browser install` downloads Chrome for Testing. Linux `--with-deps` invokes system dependency installation. Butler must not run that privileged install implicitly. |
| Release platforms | [v0.38.2 assets](https://github.com/vercel-labs/agent-browser/releases/tag/v0.38.2): Darwin x64/ARM64, Linux x64/ARM64 including musl CLI variants, Windows x64 `.exe`. CLI availability does not prove compatible browser/library availability; no native Windows ARM64 asset in this release. |
| Windows process ownership | Official install docs describe hidden private-desktop headless sessions and owned Chrome-tree termination; headed sessions use the interactive desktop; `--cdp` attachments are externally owned. Windows is supported upstream, but Butler Windows integration is untested here. |
| License | [Pinned LICENSE](https://github.com/vercel-labs/agent-browser/blob/39a74c70d7759d5a6de7a22c04570bb626bbd081/LICENSE): Apache-2.0. Preserve license/attribution and applicable NOTICE obligations for distribution/derivation; separately verify bundled dependencies and browser licenses. |
| Skill package | [Skills docs](https://agent-browser.dev/skills): `npx skills add vercel-labs/agent-browser` installs a discovery stub; `agent-browser skills list/get/path` serves version-matched runtime guidance, with `--json`. The skill itself does not install or implement Chrome. Do not import its preference for itself over other tools as Butler policy. |
| Snapshot model | [Snapshots](https://agent-browser.dev/snapshots): accessibility tree with `@eN` handles; surviving DOM nodes can keep refs, replaced/navigated nodes invalidate them, virtual nodes are snapshot-local. `-i`, `-s`, `-d` explicitly filter scope. Documented one-level iframe expansion can omit inaccessible/empty frames; not a complete cross-frame guarantee. |
| Engine reuse | [Chrome engine docs](https://agent-browser.dev/engines/chrome): `--executable-path` / `AGENT_BROWSER_EXECUTABLE_PATH`, `--profile`, `--state`, `--cdp`, headed mode. Auto-discovery can select personal/system Chrome; Butler must pass a fixed engine binding. |
| Security controls | [Security docs](https://agent-browser.dev/security): domain/action policy and content boundaries are available; default usage is permissive. Static action categories and interactive confirmations do not replace Butler's durable exact-effect approval. A hostname allowlist is not sufficient evidence of IP-level SSRF protection. |

Source inspection found two material integration hazards:
- [`chrome.rs:1536`](https://github.com/vercel-labs/agent-browser/blob/39a74c70d7759d5a6de7a22c04570bb626bbd081/cli/src/native/cdp/chrome.rs#L1536) detects CI/root/container and `:584` adds `--no-sandbox`; it also contains upstream OS-specific/unsafe implementation. A direct CLI-launch wrapper cannot claim Butler's strict production sandbox contract without validating the actual launch. Do not vendor this file into a runtime crate or weaken the workspace unsafe prohibition.
- [`install.rs:400`](https://github.com/vercel-labs/agent-browser/blob/39a74c70d7759d5a6de7a22c04570bb626bbd081/cli/src/install.rs#L400) rejects Linux ARM64 CfT installation, while [current CfT documentation](https://github.com/GoogleChromeLabs/chrome-for-testing#supported-platforms) lists Linux ARM64 from 153.0.8001.0. The CLI binary and its installer have different support envelopes. Use Butler's verified platform manifest and explicit executable; test the exact pair.
The inspected installer is a download/extract workflow, not evidence of Butler-grade signed manifests, resumable activation and rollback. Feature A must remain the single installer even if the CLI is offered.

## 3. Current Butler integration points

`R/` = `packages/butler-agent/rust/`; `UI/` = `packages/butler-app/client/ui/src/`, at the baseline above.

| Existing owner | Evidence and extension |
|---|---|
| Skill catalog and precedence | `R/crates/butler-runtime/src/skills/catalog.rs:42` loads project > user > built-in; `:59` fingerprints files, `:293` reads frontmatter. Add discoverable guidance through this path, not another global prompt. |
| Skill installation | `R/crates/butler-runtime/src/skills/install.rs:7`, `:45` stages/replaces a skill. Use existing user opt-in/catalog flows for a versioned optional pack. Do not execute npm just because instructions mention it. |
| Built-in resources | `packages/butler-agent/resources/skills/ship-feature/SKILL.md:1` demonstrates the existing resource location; a future Butler browser guidance pack belongs beside existing skills, with selected content only. |
| Discovery proof | `R/crates/butler-e2e/tests/skills_disclosure.rs:49`, `:111`, `:126` exercises catalog, load and path guard. Extend this public path for optional browser guidance. |
| Current web execution | `R/crates/butler-agent/src/host/guided/tools/dispatch/web.rs:15` calls web search/read with cancellation; no interactive browser command here. Keep read and browser effects distinct. |
| Existing reader/result settings | `R/crates/butler-runtime/src/web_access/page.rs:11`; `UI/components/settings/SearchBehaviorFields.tsx:21`. Feature A owns engine selection and installation status. |
| OS boundary | `R/crates/butler-platform/src/secure_fs.rs:103`; platform crate owns new process, ACL, sandbox and resource implementations on each OS. |
| CLI regression surface | `R/crates/butler-e2e/tests/cli_surface.rs:163` tests skill import/list. Preserve CLI/config persistence when adding browser operations. |

## 4. Options and recommendation

| Option | Benefit | Trade-off / outcome |
|---|---|---|
| Bundle unmodified upstream skill only | Minimal integration effort; rich instructions. | Assumes executable, broad shell access and upstream tool preference. No engine install/security binding; can select the wrong browser. Reject as the product solution. |
| Optional managed upstream CLI + adapted skill | Reuse many interactions; explicit executable shares A's engine. Native release avoids Node in production. | Own daemon/session/version/config drift, automatic sandbox changes, JSON adaptation and duplicate approval risks. Keep as a separately qualified advanced option, not first default. |
| Adopt snapshot/ref workflow in Butler's native browser tool + optional guidance | One runtime authority/session owner; backend-neutral; reuses A's CDP session and can later support Electron. | Butler implements a small interaction/observation subset and must test ref staleness/frame completeness. **Recommended first product integration.** |
| Vendor/fork the full CLI | Maximum control. | Large upstream surface, OS/unsafe code and maintenance burden conflict with this repo's boundaries. Reject for this slice. |

Feature B acceptance is an actual observed-target browser interaction through Butler, not merely shipping a SKILL.md. Keep a concise optional Butler-adapted skill teaching observe → act on observed target → verify; name the provenance and supported subset. The tool remains usable without skill selection, and loading guidance grants no capability.
If the owner specifically requires the upstream executable, phase B3 is a separate accepted deliverable; do not label a native adaptation “agent-browser installed.” No CLI or engine is installed by default.

## 5. User behavior and architecture

User enables Browser globally or for the conversation through #165's existing capability surface; selecting Chromium for reading alone does not enable interactions. A relevant user request can load the optional skill through existing skill discovery. Settings shows “브라우저”, “사용”, “설치 필요”, “로그인 필요”, “중지”; disable unavailable controls with a short tooltip. Compose only Butler DS `SettingsSection`, `SettingsField`, `Switch`, `Select`, `ButtonContainer`, `Button`, `ProgressMeter` and existing decision components; no extra composer launcher or CSS.
Browser tools return observed refs and explicit page/frame identity. A click/fill follows current effect policy: use already granted scope without redundant confirmation; otherwise show the exact origin, target and operation in the existing durable decision UI. Filling a field can trigger network changes, so it is not classified as intrinsically read-only. No raw eval, cookie, HAR, file upload, extension or shell API in the initial surface.
User takeover immediately fences agent actions, pauses observations while credentials are entered, then requires fresh observation on handback. Revocation/stop closes only task-owned resources; an already-issued submission may be `effect_unknown` until reconciled. Never replay a possibly completed click to satisfy a retry loop.

The runtime browser-session owner introduced for A binds one lease to the existing session/attempt/control epoch. Interactive tools extend this owner; snapshots, ref tables and navigation generations are volatile, while control receipts and effect outcomes use existing runtime durability. No separate browser Work, todo list or queue. Task/Spec refs are mandatory only when the existing work model makes the attempt managed; Tier 0 remains lightweight.
OS code stays in `R/crates/butler-platform`. Model-facing tool contracts live with existing tool protocol/agent dispatch; runtime owns engine/session policy; gateway projects events; UI is a consumer. Avoid a cross-domain “browser orchestration framework.”

```text
browser_open { url, purpose, authority_ref }
  -> { browser_session_id, page_id, engine_id, navigation_epoch, status }
browser_observe { browser_session_id, page_id, frame_id?, scope?, cursor? }
  -> { observation_id, navigation_epoch, state_revision, observed_at,
       nodes:[{ref,frame_id,role,name,states}], frames:[{id,status}],
       scope, total_count, returned_count, next_cursor, completeness }
browser_act { browser_session_id, page_id, observation_id, state_revision,
              target_ref, action:click|fill|select|scroll, value?, operation_id }
  -> { receipt_id, effect_status, observation_required, error_code? }
browser_capture { browser_session_id, page_id, observation_id }
  -> { artifact_id, dimensions, navigation_epoch, redaction_state }
browser_close { browser_session_id, operation_id } -> { closed, receipt_id }
```

Runtime resolves ownership/capability from the invocation; the model cannot forge Task, executable, CDP URL, arbitrary profile path or control epoch. `authority_ref` references existing grants, not a bearer secret. `operation_id` deduplicates control requests, not website effects across ambiguous crashes.
Refs are opaque scoped handles, not CSS supplied by the model: `(session,page,frame,navigation_epoch,node_identity,observation_id)`. Surviving nodes may retain internal identities, but actions require a compatible current observation revision. Navigation, replaced nodes, user takeover, policy change or new attempt invalidate the relevant action refs. On mismatch return `stale_observation` and re-observe; no coordinate guess or automatic stale-action retry.
Serialize mutations per page. Subscribe to navigation/DOM/target/close events; coalesce invalidation, no continuous snapshot polling. Validate current node identity and actionability immediately before dispatch. A page can change during dispatch: result must distinguish `not_dispatched`, `completed` and `unknown`; a click receipt is not proof of the intended business outcome.
Expose inaccessible frames as `unavailable` with a reason; enumerate deeper frames explicitly. Requested scope and pagination are visible, never describe `snapshot -i` or omitted subframes as the full page. Use screenshots for canvas/visual evidence only when permitted. Auth fields and private session state stay outside observation output.

## 6. Shared engine and optional CLI contract

Native integration directly reuses A's lease/profile/CDP channel. Reader and interaction jobs use separate contexts and authority, but one immutable installed engine revision per platform. The engine manager is the sole downloader/updater/remover; A and B cannot garbage-collect each other's leased revision.
Optional CLI B3 uses a pinned signed upstream executable under `D/cache/browser-tools/agent-browser/<revision>/`, independently measured from engine bytes. Preserve Apache license/attribution. CLI updates use A's trusted installer primitives and version compatibility manifest; never call `upgrade`, `install`, `npx` or auto-discovery from model instructions.
Prefer attaching the CLI to **one Butler-launched isolated browser**, because upstream launch may add `--no-sandbox`. A private authenticated adapter endpoint must restrict CDP to that dedicated instance and authorized targets. Raw local CDP normally has no equivalent per-command Butler authority: merely hiding a loopback port is insufficient. Validate process isolation/endpoint access before offering B3; if the pinned CLI cannot connect through this boundary, B3 stays unavailable pending a bounded transport adapter.
An alternative explicit `--executable-path <managed path>` shares disk correctly, but CLI-owned launch is admitted only after its sandbox flags, process tree and egress behavior pass the same production checks. Do not use a compatibility flag to waive them.
Invoke argv directly through the platform launcher, never shell interpolation. Supply isolated working directory, environment/config/session namespace and artifact root; refuse inherited user config, plugins, custom args, auto-connect, cloud providers, state export and file access. No credential values in argv/stdout/logs. Validate JSON response schema and surface unknown fields only as diagnostics; never let output become instructions.
CLI commands are fixed typed translations behind Butler tools, not arbitrary command strings. Deny unexposed commands and policy changes; CLI confirmation prompts are not an approval authority. Use Butler's durable grant, then a restrictive CLI policy for defense in depth. Enforce cleanup on process exit/cancel without relying on upstream's long idle-daemon timeout.
For Electron, native adapter uses internal `webContents.debugger`; do not expose the App-wide debugger port to this CLI. A page-only CDP proxy for upstream compatibility would need separate proof and is not part of B1/B2.

## 7. Platform, security and performance gates

Inherit A §§6–8: verified artifacts, public-network confinement, separate profiles, no secrets to model, no raw file/localhost access, no implicit weak sandbox and near-zero idle writes. Upstream flags are capabilities to review, not safe defaults.

| Platform | Proposed support boundary |
|---|---|
| macOS x64/ARM64 | Native engine + own ephemeral profile; normal sandbox qualification required. Owner's `--single-process` workaround is trusted-fixture smoke only and does not establish production safety. |
| Windows x64 | Upstream CLI asset exists; test paths with spaces, ACLs, process-tree stop, locked executable update and headless/headed handoff. Platform crate owns Butler OS integration; `.exe` presence is not end-to-end qualification. |
| Windows ARM64 | No native upstream release asset observed; report unavailable until approved x64-emulation testing, not an automatic fallback. |
| Linux x64 / WSL2 | No Electron required. Report missing shared libraries/sandbox facilities explicitly; no implicit sudo or `--no-sandbox`. Headed login requires a real display/WSLg and remains unavailable otherwise. |
| Linux ARM64 | Native CLI exists but v0.38.2 installer rejects CfT. Butler's manifest may provide a verified compatible asset; exact version/library testing gates support. musl CLI support does not imply Chromium works on musl. |

Additional proposed budgets (unmeasured):
- Disabled Browser: **0 added browser tool schemas, 0 browser processes, 0 model rounds**; skill catalog entry only, full text loaded only when selected. No browser-specific idle I/O.
- Complete controlled snapshot with **10,000 accessibility nodes / 20 frames**: first page p95 ≤250 ms, full paginated traversal ≤2 s; exact node/frame totals, order, epoch and explicit unavailable frames. Pages ≤200 nodes with continuation, no silent truncation; fixture text payload ≤2 MiB. Capture once per observation, serialize off worker-critical paths.
- Action local authorization/dispatch p95 ≤50 ms, stop acknowledgement p95 ≤100 ms; A's ≤2 s cancellable process cleanup remains. Website latency/outcome reconciliation is reported separately.
- Default **1 active page job**, **8 pending admissions**, bounded event/control queues; coalesce invalidation by page rather than drop receipts. Reserve the control lane. No spontaneous screenshot/video or per-node durable writes.
- At A's owner-scale fixture size, **0 browser-owned logical writes over 10 min idle** after cleanup; measure native and optional CLI separately including daemon/profile cleanup. Status/ref correctness must accompany every timed test. Resource limits fail explicitly, never reduce content fidelity to pass.

## 8. Phases and acceptance

Future work starts E2E-first in `R/crates/butler-e2e` on stub/replay providers, via actual agent tools/gateway/config/events. Do not treat skill text assertions, fake refs or a stand-alone upstream CLI demo as Butler integration proof.

| Branch / dependency | Deliverable and criteria |
|---|---|
| B1 `codex/browser-observed-actions` / A1 + #165 effect authority | Enable → open → observe → approved click/fill → fresh observation → verify → close through native adapter. B-01/02/03/04/06. No new daemon or browser download. |
| B2 `codex/browser-skill` / B1 | Optional adapted skill with discoverable provenance/version/supported subset; same tools and engine. B-05/06. Validate existing skills_disclosure and cli_surface regressions. |
| B3 `codex/browser-agent-cli-adapter` / A2 + explicit upstream-CLI decision | Pin optional CLI, signed install, shared engine binding, restricted transport/policy and OS cleanup. B-07/08 and A's security/performance criteria; blocked compatibility is explicit. |

| Criterion | Public-path proof |
|---|---|
| B-01 capability | Disabled tools absent and execution denied; reader-only setting cannot authorize browser mutations; enable/read-only/ask-first use the same policy snapshot in schema and executor. |
| B-02 observations | Real fixture has nested/replaced/duplicate-label nodes, cross-origin frames and SPA navigation; stale/foreign refs are rejected, fresh refs act on the exact observed node, inaccessible frames are visible. |
| B-03 effects | Existing grant needs no new prompt; ungranted action gets the exact durable approval; revoke while waiting prevents dispatch. Form submission/crash records unknown and reconciles without duplicate submission. |
| B-04 controls | Stop/takeover during active action with two queued follow-ups; restart retains Task/Spec identity, receipts and both queued items; new refs required on resume. No separate child Work. Tier 0 creates no managed bundle. |
| B-05 disclosure | Catalog exposes concise metadata; loading one skill returns version-matched instructions, no unrelated skills; project/user precedence preserved; malicious SKILL.md cannot grant effect or engine-install authority. |
| B-06 shared resource | A read and B action acquire one installed revision, isolated profiles; cookie/credential/login screenshot canaries never leak. Close releases owned resources, status/bytes latest, idle budgets pass with full-result checks. |
| B-07 CLI isolation | Fixed binary/args/config; disabled exec/cloud/plugin/file/state-export commands refused. No second browser download, no inherited personal Chrome session, raw endpoint inaccessible from pages. Detect upstream sandbox relaxation and fail closed. |
| B-08 platform | Windows x64, macOS and Linux/WSL stub-browser smokes plus real-browser fixtures; kill owned daemon during action, release process tree/lease, update locked files correctly. Unsupported tuples return typed errors. |

Performance runs use synthetic owner-scale fixtures from A, not production data. Test EN/KO Settings, skill load, approval and handoff on 320/375/390/430 px and desktop with DS-only behavioral smokes; no UI unit tests or screen recordings. New non-E2Es require `race|security|pure-logic|format-pin` tags, and no test-count ratchet increase. Required checks: fmt, touched-crate clippy, source-check, TS/UI check if changed, all isolated. Model calls remain stub/replay; only separately authorized recordings use `openai/gpt-6-luna`.

## 9. Decisions, risks and self-review

One Feature B product decision remains: is **native Butler interaction with an adapted optional skill** sufficient (recommended), or must the product also run the upstream `agent-browser` executable? The latter adds B3's compatibility/maintenance cost; it is not needed to share Chromium or implement snapshot/ref interaction. A owns separate update/login-retention/Electron-priority decisions; do not ask them twice.
Risks: fast upstream CLI/schema/ref changes; omitted frame content; anti-automation/login restrictions; CLI config/plugins escaping wrapper assumptions; Electron exposing all targets; Windows/headless launch behavior; engine/platform mismatch. Each has a bounded criterion above. No claim that all websites, passkeys or MFA can be automated.
Self-review: identity/version/license/install verified; current Rust/CDP architecture distinguished from old descriptions; Windows support separated from Butler validation; one shared engine owner; no default browser/CLI install; exact-effect authority preserved; adapted skill never substitutes for runtime permissions; Work-model controls bind attempts rather than create hierarchies; no new OS code outside platform; DS-only UI, numeric full-content budgets, E2E-first and active-plus-queued recovery specified. No product code or real model calls in this research.
