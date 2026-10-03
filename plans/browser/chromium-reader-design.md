# Optional Chromium web reader

Status: research/design proposal, 2026-10-03. No product implementation or runtime qualification.
Owner request (verbatim): **웹 패치 도구에서 Chromium 선택**.
English: allow a real browser engine for web fetch, installed on demand with a complete lifecycle.
Issue: [#171](https://github.com/Hexpy-Games/butler/issues/171); interactive capability: [#165](https://github.com/Hexpy-Games/butler/issues/165).
Branch: `codex/browser-research`. Companion: [agent-browser integration](agent-browser-integration-design.md).

## 1. Authority, goals and boundaries

Source baseline: `10b68356da71fafdd3c5551ef7cb62d51ee35da3`, matching remote main on 2026-10-03.
Architecture authority: [`origin/codex/work-model-design` at `0df4b6203b82922fc77cadd2cd41e7fac79d0b35`](https://github.com/Hexpy-Games/butler/blob/0df4b6203b82922fc77cadd2cd41e7fac79d0b35/plans/work-model/work-model-design.md), §§1, 2.1, 2.6, 3, 7–9.
Spec revisions describe behavior; Plan orders Works; Tasks are the todo list. Browser execution binds to the existing session/attempt and, when managed, its Task and Spec revision. Tier 0 reads create no artificial Work/Task. Do not add a browser scheduler or independent approval authority.
Immutable Spec bodies remain Ledger-owned; mutable Work-model state remains BTCC SQLite-owned. This repository document is a review artifact, not Ledger publication; owner data was not accessed.

Goals: retain inexpensive HTTP reads; add JS rendering, approved authenticated reads and screenshots; support desktop and agent-only installations; share one managed engine with Feature B; make installation, bytes, failure and cancellation visible.
Non-goals: general-purpose browser replacement, CAPTCHA/paywall circumvention, importing personal browser cookies, extensions, arbitrary script tools, Custom-reader implementation from the wider #171, or an Electron migration.
The local Mac launch lesson supplied by the owner is a fixture constraint, not proof of production sandbox safety.

## 2. Current code evidence

`R/` means `packages/butler-agent/rust/`; `UI/` means `packages/butler-app/client/ui/src/`. All line references are at the source baseline above.

| Finding | File:line |
|---|---|
| Existing agent path is `web_read`/`web_search`, with invocation cancellation passed into the web session. | `R/crates/butler-agent/src/host/guided/tools/dispatch/web.rs:15` |
| URL scheme/credentials checks, backend selection and per-turn observation/page reuse already exist. “public” in the error message is not an IP/DNS guard. | `R/crates/butler-runtime/src/web_access/read.rs:95`, `:108`, `:119`, `:135` |
| HTTP extraction runs first; `auto`/`lightpanda` may render when recommended. `jina-hosted` currently returns a not-enabled warning. Entire read budget is 20 s. | `R/crates/butler-runtime/src/web_access/read/fetch.rs:17`, `:47`, `:72`, `:78` |
| Reqwest redirects check credentials and ten-hop limit; the inspected builder installs no private-address resolver/connect guard. This is a source finding, not an exploit reproduction. | `R/crates/butler-runtime/src/web_access/service.rs:119`; `service/fetch.rs:66` |
| Lightpanda resolves a configured/system executable, spawns a dump process and cancels/reaps it. It is not Chromium and has no managed installer. | `R/crates/butler-runtime/src/web_access/read/lightpanda.rs:98`, `:116`, `:166` |
| Extraction is offloaded; structured evidence, chunks and warnings exist. Preserve these rather than creating a second text-result format. | `R/crates/butler-runtime/src/web_access/read/fetch.rs:162`; `page.rs:11`; `read.rs:217` |
| Settings already offers lightweight/auto/lightpanda/jina-hosted/disabled. Validators, projection and runtime all require coordinated additions. | `UI/components/settings/SearchBehaviorFields.tsx:21`; `R/crates/butler-gateway/src/gateway/application/settings/validation.rs:159`; `settings/view.rs:101`; `R/crates/butler-runtime/src/web_access/service.rs:235` |
| App window has a privileged preload plus sandbox/context isolation and Node disabled; never reuse this window/session for web content. | `packages/butler-app/client/electron/main.mjs:2100`, `:2120` |
| Private filesystem primitives already belong to the platform crate. | `R/crates/butler-platform/src/secure_fs.rs:103`, `:162` |
| Existing command sandbox documents macOS enforcement but no Linux/Windows command sandbox. It is not already a cross-platform browser egress sandbox. | `R/crates/butler-platform/src/command_sandbox.rs:1` |
| Existing reader regressions cover raw GitHub, PDF/Jina fallback and Lightpanda child cleanup; CLI surface includes web read. | `R/crates/butler-runtime/src/web_access/tests/readers.rs:44`, `:79`, `:127`, `:157`; `R/crates/butler-e2e/tests/cli_surface.rs:101` |

## 3. Prior art and choice

Every external source below was accessed **2026-10-03**. Claims are documented capabilities; resource comparisons are architectural estimates, not measured Butler results.

| Option / primary source | Strengths | Cost, limitation and decision |
|---|---|---|
| Current HTTP / [Reqwest client](https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html) | No browser process or engine download; existing extraction/evidence. | No JS execution or interactive login. Keep default; strengthen connection policy before claiming public-only safety. |
| Electron [sessions](https://www.electronjs.org/docs/latest/api/session), [security](https://www.electronjs.org/docs/latest/tutorial/security), [webContents](https://www.electronjs.org/docs/latest/api/web-contents) | Reuses installed Chromium; hidden window, capturePage and debugger/CDP are available. Non-`persist:` partition is in-memory. | Requires running desktop app; shares main/GPU/resource fate, engine updates follow App releases. Optional later adapter after isolation and responsiveness proof. |
| Electron [offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering) | Frame delivery for a rendered browser surface. | Adds frame/pixel transport and rendering work; not an isolation boundary. Use one-shot capture for screenshots; no offscreen stream for text fetch. |
| [Playwright browsers](https://playwright.dev/docs/browsers), [launch API](https://playwright.dev/docs/api/class-browsertype) | Broad automation API, version-pinned browser assets, cache path controls; existing repo test dependency. | Driver/runtime distribution and browser-version coupling. Defaults can install both full Chromium and shell; `--no-shell` selects full-only. Arbitrary executable compatibility is not guaranteed. Candidate artifact source; no production Node requirement just for installation. |
| [Puppeteer browser manager](https://pptr.dev/browsers-api) / [Chrome for Testing](https://github.com/GoogleChromeLabs/chrome-for-testing) | Versioned full Chrome and shell artifacts, install/cache APIs; convenient direct-CDP compatibility. | Butler must own trust, resume, activation and GC; do not run npm installers inside a model command. Recommend pinned full CfT Chrome as initial managed artifact, subject to licensing and platform qualification. |
| [chrome-headless-shell](https://developer.chrome.com/docs/automation-and-testing/headless-chrome-shell) | Purpose-built old headless mode, fewer full-browser facilities. | No headed login handoff; different behavior from modern unified headless. Optional server-only choice later, not a second default download. |
| [CEF](https://github.com/chromiumembedded/cef) | BSD-licensed embedding framework with native integration and offscreen support. | Framework integration, native binaries, security servicing and Rust FFI burden; first-party unsafe code is forbidden. Too much work for a reader; reject for this slice. |

Recommendation: **HTTP → explicitly enabled managed Chromium → optional Electron reuse**. “Tiered” describes transport escalation, not Work-model Tiers. HTTP remains default; no engine ships in the base installer. Use full Chrome so the same verified executable serves rendering, screenshots and headed authentication. Control it with a narrow Rust CDP adapter; dependency selection must pass workspace rules, without copying upstream OS/unsafe code.
Electron can save an additional engine download, but does not solve agent-only Linux/WSL/headless use or guarantee lower memory. Never silently switch a running authenticated job between engines.
CfT's current platform table includes Linux ARM64 since version 153.0.8001.0; older versions and the pinned agent-browser installer disagree (companion §2). Resolve each exact artifact tuple; do not infer availability from the architecture name. Windows ARM64 has no native asset in the checked lists: initially unavailable unless x64 emulation is separately qualified.

## 4. Observable behavior and UI

1. Extend the existing search-reader setting with `chromium` (HTTP-first browser assistance) and `chromium-rendered` (force rendering for this read). Keep saved legacy values and semantics; `auto` is not silently reassigned from Lightpanda. An explicit migration can be offered later. A tool override cannot exceed the saved browser capability.
2. Selecting a Chromium mode expresses installation intent. If absent, show exact engine/version, download and installed-size estimate, available disk and destination label, then start the authorized download with progress. Do not add a second generic confirmation. A model-requested render cannot authorize installation: return `engine_install_required` with a Settings action.
3. HTTP success without render need returns immediately. Render only for detected JS requirements or an explicit render/screenshot request. Detection is heuristic and returns a reason; HTTP 401/403 is `auth_required`, not permission to bypass an access wall. Missing engine or render failure retains the saved choice and truthful HTTP partial evidence, never reports a successful Chromium read.
4. Installation has pause/resume, cancel, retry, update and uninstall. Show compressed, installed, partial and reclaimable bytes separately; “계산 중” for unknown totals, not zero. Unknown total download length uses indeterminate progress. User retry is an explicit operation, not hidden unbounded retries.
5. Authentication uses a separate, user-visible browser session. Pause model observation during credential/MFA entry; user explicitly resumes with a fresh observation. No browser display on headless agent-only hosts returns `auth_interaction_unavailable`; no implied remote credential forwarding.
6. Existing settings UI uses only `@/butler-ds`: `SettingsPage`, `SettingsSection`, `SettingsField`, `Select`, `ProgressMeter`, `ButtonContainer`, `Button`, `Typo`, `Notice` and `Toaster`. Use existing exact-action decision UI for login/site effects. Copy: “직접 읽기”, “Chromium”, “설치 중”, “재개”, “업데이트”, “삭제”, “로그인 필요”. No new banners, CSS, raw controls or parallel composer control.
7. Existing authenticated gateway/SSE carries lifecycle changes. CLI gets the same install/status/cancel operations and errors; enabling browser interaction is separate from choosing a reader.

## 5. Ownership and contracts

Extend `butler-runtime::web_access` with a reader adapter and scoped browser-session owner. A small engine manager in the runtime owns installed revisions, operations and leases; it has a real first consumer in `web_read`, not an independent service/scheduler. Gateway projects settings/status; agent composition connects cancellation and capability policy; Electron is an optional transport adapter only.
All OS detection, data/cache root resolution, executable layout, executable/signature checks, process-tree control, egress confinement and resource measurement live in **`R/crates/butler-platform`**. New Electron code must remain OS-neutral and call those platform facilities through the existing agent boundary. Existing scattered platform code is not permission to add more.
Disk/hash/extract/SQLite work uses existing blocking lanes or `spawn_blocking`; network I/O is asynchronous. No directory scan, child spawn or manifest network lookup on ordinary settings reads.

```text
ReaderRequest { url, mode:http_first|rendered, purpose:read|screenshot,
  session_id, operation_id, authority_ref, deadline, cancellation }
BrowserLease { engine_id, revision, instance_id, session_id, attempt_id,
  task_id?, spec_ref?, control_epoch, profile_id, policy_revision }
EngineManifest { schema_version, sequence, expires_at, os, arch, engine_id,
  revision, min_adapter_version, url, archive_sha256, archive_bytes,
  unpacked_bytes, file_manifest_hash, license_ref, signer_ref }
EngineStatus { revision, state, operation_id?, downloaded_bytes, total_bytes?,
  installed_bytes, partial_bytes, reclaimable_bytes, size_state, active_leases,
  capabilities:{render,screenshot,headed_auth}, error_code? }
ReaderResult = existing PageRead/evidence + {
  requested_backend, actual_backend, engine_revision?, escalation_reason?,
  completeness, observed_at, artifact_refs[], warnings[], error_code? }
```

Public results expose opaque engine/profile/artifact IDs, never executable paths, secrets or raw CDP. Keep existing chunk counts/order/cursors; a rendered page gets new content identity and evidence, not a mutated HTTP cache entry. Cache identity includes profile, engine revision, navigation/observation generation and policy revision. Authenticated observations are private and never reused across sessions.
Typed failures: `engine_install_required`, `engine_busy`, `unsupported_platform`, `dependency_missing`, `verification_failed`, `insufficient_disk`, `sandbox_unavailable`, `network_denied`, `auth_required`, `auth_interaction_unavailable`, `cancelled`, `deadline_exceeded`, `resource_exhausted`, `interrupted`, `effect_unknown`.
Proposed gateway group `/browser/engines`: GET status; POST install/update/pause/resume/cancel/uninstall with `operation_id`, expected revision and selected manifest. Reuse token/Host/Origin protections; no unauthenticated installer or arbitrary URL/path fields. Mutation replay returns the same receipt; mismatched payload conflicts. CLI is an adapter to the same operations, not another writer.
Control checks occur before dispatch, after waiting, and before accepting results. Stop fences future effects and cancels owned resources; it does not undo a submitted page action. Resume uses the same Task with fresh observations; never replay an uncertain mutation automatically. Queue remains after Task at managed tiers or Turn at Tier 0; active plus queued work survives restart through existing Work-model ownership.

## 6. Installation, trust and lifecycle

Resolve `D` from the agent's configured Butler data directory on every OS; do not invent a second home. Layout is `D/cache/browser-engines/<engine>/<os>-<arch>/<revision>/`, staging in the same filesystem, registry in `D/state/browser-engines/`, ephemeral profiles in `D/tmp/browser/<lease>/`. This applies to macOS, Windows (including paths with spaces) and Linux/WSL; platform owns native path/ACL handling. Electron persistent profiles, if approved later, use an explicit path beneath D, never App defaultSession.

States: `absent → downloading ↔ paused → verifying → staging → ready`; `failed` retains a verified resumable prefix when safe; `ready → updating → ready`; `ready → removing → absent`. One writer per engine tuple; simultaneous A/B requests attach to the same operation. Existing leases pin immutable revisions; update activates only after verification and smoke launch. Windows locked-file deletion becomes `removing` until the last owned process exits.

- Download only from a pinned signed manifest. Use Range + If-Range/ETag; validate Content-Range and expected size. Changed validators, 200 to a range request or 416 require a visible restart from zero, never append incompatible bytes. Persist progress checkpoints per 8 MiB and on pause/close, not every network chunk; rehash retained bytes on resume.
- SHA-256 proves content equality, not publisher authenticity. Butler signs approved manifests with a release trust root; root rotation/revocation, monotonically increasing sequence and expiry prevent rollback/freeze. Platform verifies native publisher signatures when supplied; absence is explicitly recorded, not described as upstream signing. No TLS bypass or unsigned fallback. [TUF metadata principles](https://theupdateframework.github.io/specification/latest/) inform this contract; a full TUF client is an implementation choice, not assumed present.
- Checked CfT download metadata provides URLs/version/platform, not a complete Butler signed/resumable installer. Release ingestion must verify provenance, record licenses/notices and sign expected archive/file hashes. Release ownership is a real dependency, not delegated to the model.
- Check free space against remaining archive + unpacked size + **256 MiB** staging margin, retaining current/rollback bytes. No guessed global “Chromium size.” Reject traversal, absolute paths, symlink escapes, duplicate/case-colliding entries and decompression beyond the signed manifest. Verify extracted files before atomic activation; no executable runs from partial staging.
- Cancel stops transfer promptly; explicit cancel/delete removes partial bytes, pause retains them. Crash recovery is triggered once at startup or next engine operation from the registry, not a periodic sweep. Retain current plus one rollback revision; collect unleased old revisions after activation or an explicit cleanup action. User-owned profiles never disappear as an update side effect.
- Check updates on an explicit Settings/update action or normal Butler update event, at most once per 24 h of such events; no idle timer/poll. Proposed default: notify and user-apply. A revoked revision cannot start new leases; show the required update. Active revocation follows existing stop semantics.
- Uninstall blocks new leases and offers “사용 중” with a stop action; only after explicit stop does it terminate owned jobs. Delete managed engine/cache bytes and report reclaimed bytes. Login-data deletion is a separate exact action. Electron removal is unavailable here because its engine belongs to the App installer.

## 7. Security model

Pages and all extracted text, frames and screenshots are untrusted evidence; they cannot enable a capability, approve installation, select a private destination or issue control instructions. Reader navigation executes site code and can have server-side effects: it is read-oriented, not a claim that GET/JS is side-effect-free. Interactive mutations use #165's existing durable exact-effect authority.
Each task/session owns a fresh browser context/profile; separate origins/frames remain explicit. Browser capability off exposes no interactive tools; reader-only mode exposes no click/fill/upload/eval/CDP escape. No App preload, cookies, tokens, extensions, project filesystem mounts or host clipboard is given to a web renderer.

Network enforcement must cover top-level navigation, redirects, frames, scripts, workers, WebSocket and speculative requests. URL filtering alone is insufficient. Normalize and resolve all A/AAAA addresses; reject loopback, private, link-local, multicast, unspecified and metadata ranges including mapped IPv6. Pin the vetted address at connect while retaining hostname TLS verification; repeat on redirect/new connection. Apply this to HTTP as well as browser traffic ([OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)).
Use a task-scoped validating egress proxy plus platform confinement that permits only that proxy and the private control channel. Disable direct proxy bypass, QUIC, WebRTC direct UDP and uncontrolled DNS; block service workers initially. Verify actual connect behavior, not merely launch flags. The proxy handles destination/IP pinning without exposing credentials; no arbitrary TLS MITM is required for address enforcement. A generic HTTP CONNECT allowlist alone does not enforce page action/method approval, which remains the tool/session policy.
Confinement feasibility must be qualified on each OS in phase A1. If unavailable, return `sandbox_unavailable` and leave HTTP available; do not silently widen access. An Electron renderer cannot use broad App process permission as equivalent isolation: gate the optional adapter on equivalent observed network control.
`file:`, custom schemes and local-network access are denied. Internal `about:blank` and page-local blob rendering do not authorize external destinations. Explicit local-development browsing would be a separate #165 grant bound to exact host/port/session; unavailable in this reader slice. Never expose localhost Butler/CDP endpoints to a page.
Downloads, popups, permission prompts, external protocol launches, camera/mic/geolocation and clipboard are denied by default. Screenshots use Butler artifact IDs and private files; no arbitrary output path. A later approved download names origin, filename and destination, quarantines data, and never auto-opens it.
For Electron: unique nonpersistent partition, `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, no preload; deny permission request/check handlers, `will-download`, window-open and unapproved navigations before load. `webContents.debugger` stays internal, not an App-wide remote debugging port.
Credentials are entered by the user while all agent capture/logging is suspended. Clear password-field refs, network bodies and login screenshots; observations resume only after user handback and re-observation. No cookie export. Persistent site login is an owner decision (§10).
Production never auto-adds `--no-sandbox` or `--single-process`. Owner-supplied Mac smoke fact: only `['--single-process']` launches in this Codex sandbox; normal/headless-shell fail with Mach port rendezvous denial. Future fixture smokes may use `BUTLER_SMOKE_BROWSER_ARGS` through one shared helper, with unchanged assertions, only against trusted fixtures. Such a pass does not qualify production isolation; run separate normal-sandbox smokes outside the restricted runner.

## 8. Performance acceptance (proposed budgets, not measurements)

Use synthetic owner-scale fixtures: 1.3 GB App DB, 600+ chats/300k events; 7 GB BTCC DB; 2,440 transcripts/1.5 GB, largest 290 MB; metrics >300 MB. Never read the owner's data to generate them. Declare OS/hardware/build and measure process-tree CPU/RSS/private footprint and attributable write bytes; unsupported metrics are `unavailable`.

| Path | Budget and correctness assertion |
|---|---|
| Disabled or quiescent after final cleanup | **0 browser processes, 0 periodic wakeups, 0 browser-owned logical disk bytes / 10 min**; report OS physical writes separately. No registry rewrite from a status read. |
| HTTP-only read | **0 browser launches/downloads**, added local dispatch p95 ≤10 ms over baseline, same complete evidence/counts/order. Existing 20 s read deadline stays. |
| Engine state / controls at owner scale | Status p95 ≤50 ms, cancel/fence acknowledgement p95 ≤100 ms; no history/profile directory scan. Browser teardown ≤2 s after cancellable work, or report unconfirmed exit explicitly. |
| Controlled JS fixture, engine ready | Cold launch p95 ≤2 s; navigation→complete extraction p95 ≤3 s; preserve aggregate read deadline **20 s** including HTTP fallback. External site timing is reported separately; installation/auth wait returns a resumable result and is not hidden in this deadline. |
| Load and memory | Default **1 active rendered job, 1 tab/job**, bounded **8 pending jobs**; saturation is `engine_busy`. Fixture browser-tree peak ≤768 MiB, runtime incremental peak ≤64 MiB; resource exhaustion is explicit failure, never truncated success. |
| App under browser CPU load/crash | Input acknowledgement p95 ≤50 ms, local input-to-paint p95 ≤100 ms, control publication p95 ≤200 ms; Electron reuse must meet the same numbers. |
| Progress / screenshots | Coalesce progress ≤4 events/s, metadata checkpoints ≤1/8 MiB plus transitions; screenshot only on request, no frame stream. Include download/extract/profile/teardown writes in totals. |

No response field, chunk, frame or item is dropped to meet a timing budget. Existing bounded text windows retain total counts and continuation; test complete retrieval separately. Hard limits produce typed non-success with a resumption path where meaningful. Freeze observed page generation for paginated evidence; do not serve a stale cache as a new measurement. Destroy ephemeral sessions immediately after the job; do not hold a warm browser in idle periods.

## 9. Implementation sequence and acceptance

Each branch is a separate future authorization, not work performed here. Bind Tasks to this document's criteria and the approved Work model; keep files ≤500 lines/functions ≤80, no new unsafe, no source-check ratchet growth.

| Branch / dependency | Deliverable and acceptance |
|---|---|
| A1 `codex/browser-reader` / approved proposal | Smallest usable path: select Chromium → on-demand verified install → JS read via existing tool → full evidence → cleanup. Includes secure install/resume and public-network policy, Mac/Windows/Linux process ownership. A-01/02/03/06; unsupported platform is truthful. Do not ship installation without its real reader consumer. |
| A2 `codex/browser-engine-lifecycle` / A1 | Update, rollback, uninstall, byte accounting and crash recovery. A-04/05/07, including A/B sharing. |
| A3 `codex/browser-auth-screenshot` / A1 + #165 authority | Screenshot artifacts and approved user login handoff, stop/resume, no credential observation. A-06/08/09; persistent login only after owner choice. |
| A4 `codex/browser-electron-adapter` / A1–A3 + explicit decision | Optional app-running reuse with same security/result contract; no-download success, app-close recovery and overload isolation. A-10 and performance table. No automatic priority change until proven. |

Start with public stub-tier E2Es in `R/crates/butler-e2e`: real tool/gateway/config/events/private installer fixture; use an existing page-route seam or test-only egress fixture grant, never relax production local-network rules. Real browser tests run the same paths against deterministic JS/auth/download fixtures; a fake CDP server cannot establish rendering/security qualification.

| Criterion | E2E/smoke proof |
|---|---|
| A-01 selection | Settings save/restart and agent tool + CLI resolve the chosen backend; plain page spawns zero browsers; JS page returns exact expected text, chunk counts, order and provenance. Legacy values retain behavior. |
| A-02 first use | Missing engine → progress → checksum/signature verified → rendered result; explicit selection authorizes install, model-only request does not. Cancel and no-space leave truthful sizes. |
| A-03 resumed trust | Range resume after crash, changed ETag/200/416 restart, bad signature/hash/expiry/path traversal never execute; malicious archive cannot escape D. |
| A-04 update | A/B concurrent jobs pin one engine install; update does not replace a leased executable. Kill between verify/activate/reply, then recover one valid revision; rollback and revoked revision behave exactly. |
| A-05 uninstall | In-use status then explicit stop; Windows locked file, partial and rollback accounting; remove only managed bytes, no user profile or app files. |
| A-06 boundaries | Redirect/DNS-rebind/mapped IPv6/worker/WebSocket/private fetch denied at actual connection; malicious site cannot read app cookies, local files or gateway/CDP. Stop active read with two queued follow-ups preserves both. |
| A-07 performance | All §8 budgets including 10-min idle after cleanup and owner-scale concurrent UI activity; assert full results and latest status for every timed path. |
| A-08 authentication | Credential-entry pause blocks text/screenshot/network logging; user handback refreshes observation; headless unavailable path and logout clear correct profile only. |
| A-09 screenshot | Complete fixture image/artifact ACL, dimensions and source generation; no silent cropping/downsampling. |
| A-10 Electron | App present/absent/closed during action, distinct partitions and no preload leakage; renderer crash/CPU flood leaves App responsive. Uncertain mutation remains unknown. |

Run existing reader tests above, `cli_surface`, configuration persistence/legacy data-dir regressions and relevant authority/queue tests when those paths change. New non-E2Es only `race`, `security`, `pure-logic`, `format-pin`, each tagged `// test-category: ...`; existing untagged tests are no precedent. UI gets behavioral harness/smokes only, no unit tests or recordings; EN/KO at 320/375/390/430 px and desktop. No real model calls except separately authorized Luna cassette recording.
All checks use fresh temporary HOME/BUTLER_DATA; required fmt, touched-crate clippy, source-check and TS/UI checks remain unchanged. Current research needs no product E2E because it changes no product behavior.

## 10. Risks, owner decisions and self-review

Owner decisions before affected implementation branches:
1. **Update policy:** approve recommended user-applied security updates plus revoked-version blocking, or allow automatic verified updates between leases? Trade-off: control versus security update latency.
2. **Login retention:** session-only default (recommended) or opt-in per-site persistent Butler profiles? Retention adds encrypted credential storage, revocation and separate disk accounting.
3. **Electron priority:** defer reuse until standalone qualification (recommended), or fund the extra isolation/performance work to prioritize no additional download on desktop?

Engineering risks, not additional owner questions: CDP/version churn, release manifest signing operations, exact OS/arch artifact availability, Linux library dependencies and egress confinement. Missing system libraries produce a named dependency error; no automatic sudo/package-manager execution. Verify redistribution terms and notices for the selected browser; CEF/CLI licenses do not license Chrome binaries.
Self-review: existing tool/settings consumers reused; no extra scheduler or managed Task at Tier 0; HTTP/browser security gap stated; installer trust and interruption states specified; OS-only boundary and DS-only UI explicit; no idle poll; numerical budgets distinguish targets from evidence; cancellation includes active plus queued work; first vertical has E2E criteria and preserves full output. No product code, tests, manifests, live installation or canonical Ledger changed in this task.

Research validation: isolated `cargo fmt --all` passed; isolated `cargo run -p butler-source-check -- .` passed (test-count, architecture and E2E gate violations: 0). First source-check compilation failed because the pre-existing sccache server referenced a removed temporary directory; running the identical check with `RUSTC_WRAPPER=''` succeeded. An xcrun cache-permission warning remained nonfatal. No test/budget/ratchet was altered. Document line bounds, explicit file references, relative links and whitespace were checked. No touched Rust crate or TS/UI source, so touched-crate clippy, full Bun check and product E2Es are not applicable; no runtime/browser performance measurements were taken.
Delivery evidence: `git fetch origin` could not write shared `FETCH_HEAD`; read-only GitHub API confirmed main and the Work-model branch match the pinned revisions, with main rechecked before delivery. Initial staging worked. The shared pre-commit hook ran lint successfully with warnings, then failed typecheck with missing modules including `ts-morph` (its local package is absent) and type errors. The initial automatic hook run was accidentally not HOME-isolated; it ran static lint/typecheck, not product tests. The subsequent fresh-HOME commit attempt (using the owner's environment-failure `--no-verify` exception) was blocked at staging by `index.lock: Operation not permitted`, before commit. No design commit or push was completed. Per the owner's explicit fallback, the runner must stage both final files, commit and push `codex/browser-research`; baseline HEAD remains `10b68356da71fafdd3c5551ef7cb62d51ee35da3`. No PR/tag/merge or full typecheck pass is claimed.
