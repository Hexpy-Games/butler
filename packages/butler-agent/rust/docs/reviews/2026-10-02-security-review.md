# Security review — 2026-10-02

Review base: `53fa0a313` on `codex/review-security`, Linux x86_64 (WSL). Scope: changes merged during 2026-09-28–2026-10-02, including pairing/device sessions, App activation, detached CLI supervision, #314 approval summaries, durable questions, consent renewal, and support bundles. This is an adversarial source review with stub-only regression testing; it is not a certification of the native macOS or Windows installation paths.

## Confirmed findings

| ID | Severity | Finding | Evidence test | Fix commit |
| --- | --- | --- | --- | --- |
| SR-01 | High | A captured v2 browser cookie remains valid beyond its advertised 30-day lifetime. The browser's `Max-Age` does not constrain replay; restart reloads the credential without an age check. Checking request admission alone also leaves an already-open SSE stream authorized past expiry. | `security_review::stolen_cookie_expires_on_server_and_stays_expired_after_restart`; `security_review::cookie_expiry_closes_existing_sse_without_another_request` | `68e0d6922` |
| SR-02 | High | App manifest and artifact fetches permit remote plain HTTP, and their default redirect policies permit insecure destination changes. A network attacker controlling a manifest and its checksum can substitute a Linux package. The stricter Agent updater policy was not applied to App updates. | `security_review::app_update_rejects_remote_plain_http_manifest_and_artifact`; `security_review::app_update_does_not_follow_plain_http_redirect_outside_trusted_loopback` | `68e0d6922` |
| SR-03 | High | Operational support bundles do not redact cookie headers, v2 credentials, or pairing codes; username components of home-directory paths also remain visible. The bearer pattern leaves portions of tokens containing `+`, `/`, or `=`. | `service_diagnostics::cli_logs_export_safe_summary_and_have_zero_idle_writes`; `observability::tests::log_tail_is_bounded_and_redacts_source_credentials` | `68e0d6922` |
| SR-04 | Medium | The approval allowlist labels commands low risk without proving their behavior: `git diff` invokes configured external programs and `git status` invokes configured filesystem monitors. File operands can escape through `..`, absolute paths, or symlinks. This understates the approval card's risk; it does not itself grant permission. | `authority::tests::bun_oracle::actual_bun_principal_admission_identity_and_permission_match`, extended command-risk assertions; isolated Git external-diff/fsmonitor and symlink probes | `68e0d6922` |
| SR-05 | Medium | An authenticated settings PATCH can store a positive consent version, and even completion, without any acceptance timestamp. Previously stored inconsistent versions also bypass the consent screen. | `setup_onboarding::setup_11_onboarding_state_lives_in_the_agent`; `security_review::legacy_consent_version_without_acceptance_requires_renewal` | `68e0d6922` |
| SR-06 | Medium | CLI supervision accepts a stop intent for another instance if its PID matches the child. This suppresses crash recovery; stop intents must bind the instance nonce as well as the PID. | `service_supervision::cli_supervisor_rejects_stop_intent_for_another_instance` | `68e0d6922` |
| SR-07 | Medium | Linux AppImage activation overwrites the installed image before spawning the replacement. If the OS rejects the new executable, the helper fails and leaves the App unusable. | `security_review::appimage_failed_launch_restores_and_relaunches_previous_image`; isolated native-helper probe | `68e0d6922` |

Each confirmed behavior has a failing pre-fix regression. The corrected cookie regression was run with its server age check removed: the durable credential was accepted after its lifetime. No live model calls, owner's data, running services, or reserved ports are used. Test/check shells use fresh temporary `HOME` and `BUTLER_DATA`; Cargo/rustup caches stay in their configured locations.

## Review by surface

### (a) Pairing, registry, cookies, and security routes

Eight-digit codes use unbiased random sampling, expire after 60 seconds, and allow at most three rejected POST attempts per active issuance: at most 3/100,000,000 guesses per code. Issuance requires local admin authentication. Both the pairing slot mutex and the gateway's change lock serialize invalidation and redemption. New parallel E2E probes submit 16 bad attempts and then the correct code, and 16 concurrent correct redemptions of a fresh code; expected outcomes are no pairing after invalidation and exactly one successful redemption. Replaced, expired, GET-submitted, and reused codes are covered by SEC-14.

Device secrets are randomly generated, stored as SHA-256 hashes, and omitted from JSON. Cookies are host-only, `Path=/`, HttpOnly, SameSite Strict, and named per gateway port. Browser cookies themselves cannot be port-scoped; Host/Origin and Fetch Metadata admission provide the additional boundary. SR-01 adds server-side fixed lifetime from durable issuance time; activity cannot renew it. A single expiry timer starts on the first successful authentication and cancels the shared credential token, closing established streams without another request. It polls nothing, writes nothing, and ends on revocation or shutdown. A real-time regression ages the durable issuance to 20 seconds before expiry and proves that the admitted stream closes; before the timer it remained open beyond the test's 25-second observation window. Existing SEC-13 covers durable reload, selective/global revocation, and cancellation of established SSE streams. Rotation also revokes the registry before replacing the gateway key set.

Host/Origin checks precede authentication, and security configuration/device administration require both the admin secret and a local-client classification. The latter includes TCP peer, loopback Host, local Origin, and refusal of forwarding headers; it does not rely on `X-Forwarded-For` as an authenticated identity. SEC-01..03, browser, remote, tunnel, and rotation tests exercise those paths.

Plain HTTP LAN pairing assumes a trusted network, as documented in the root README. SameSite and HttpOnly do not encrypt traffic. This change does not claim resistance to a LAN packet observer, a hostile reverse proxy, or malicious services on the cookie's host. Remote access remains off by default.

### (b) In-app update

SR-02 applies the existing Agent updater source/redirect rules to both App clients and manifest/artifact entry points: HTTPS or explicit local sources, HTTP only to the existing exact loopback allowlist, no remote-to-HTTP downgrade, and no more than five redirects. Local fixtures continue to work. The redirect regression uses a second local address as an untrusted destination and asserts zero destination requests.

App download hashes are compared before the temporary file is renamed into staging. Electron verifies the staged checksum again before preparing activation. Agent extraction verifies the requested archive digest before unpacking and rejects traversal, duplicate paths, escaping links, hard links, special entries, and writes through links. Existing hostile-archive and install-hardening tests cover these boundaries. SemVer selection requires a strictly newer version; equal, older, invalid and prerelease/stable ordering are tested. CLI rollback is an explicit owner operation to a verified installed version, not an unauthenticated gateway operation.

Manifest authenticity still depends on HTTPS and the release publisher (or an operator-configured local source). Embedded manifest signatures are explicitly unsupported and rejected. macOS additionally verifies code signatures and compares signing teams before clearing quarantine; Windows verifies its installer publisher. Linux trusts the verified staged checksum and manifest transport.

SR-07 is reproduced with a temporary runnable previous AppImage, an unlaunchable candidate, an already-exited test-owned parent, and the helper's explicit activation signal. The original helper returns failure with the previous image overwritten. Activation now preserves a sibling backup, atomically replaces the installed pathname, and restores/relaunches the previous image if spawning the candidate fails. A failed restoration retains the backup and reports its location. The E2E also proves that cancelling before the activation signal changes nothing.

**Open, platform evidence needed:** macOS runs `ditto` before signature verification, without an application-level archive-entry validator (`crates/butler-platform/src/app_update.rs:63`). Its two-rename bundle replacement has a crash window between moving the old bundle and installing the candidate (`app_update.rs:105`). Native hostile ZIP extraction, swap fault injection, notarization/quarantine behavior, and Windows Authenticode execution remain unvalidated here. Power-loss recovery and candidate crashes after a successful spawn also remain open (`app_update.rs:188`, `replace_appimage`). These are review concerns, not claimed reproduced exploits; no owner installation was touched.

### (c) Unmanaged supervisor and restart

The supervisor keeps one exclusive DATA lease, reaps its direct child with `Child::wait`, caps rapid failures at five per minute, and uses bounded exponential backoff. Shutdown signals target its own Child handle rather than an arbitrary persisted PID. Commands run in isolated process groups; the embedding worker has separate pipes and exits on owner EOF. Existing supervision E2Es exercise SIGKILL, replacement-required exits, the five-crash cap, a subsequent fresh start, and both an active turn and a queued follow-up. Stop/control tests require the exact token and announced instance; detached restart handoffs bind PID, process start, nonce, and executable.

SR-06 is reproduced by writing a valid-schema stop intent with the child's PID and a different nonce, then killing the test-owned child by its OS start identity. The original supervisor never replaces it. Each spawn now generates a fresh UUID, passes it to the child's instance record, and retains it through exit handling. Stop intents must match both PID and that UUID. This does not claim to force real OS PID reuse; it proves the missing identity predicate directly.

**Open, reproduction needed:** the CLI supervisor sends an immediate kill when it is signaled (`crates/butler-agent/src/host/cli/service/supervisor.rs:30`). Full process-tree/orphan behavior under supervisor death and slow worker initialization needs a dedicated native-worker test. No cause or fix is claimed from inspection alone.

### (d) Approval allowlist

SR-04 treats Git commands and commands with unverified file operands as high risk. A lexical allowlist cannot establish where a symlink points or which Git configuration will execute. Low risk is limited to explicit operand-free reads and a small set of listing flags. The classifier also refuses shell evaluation/control syntax, environment expansion syntax, globbing and quoting; commands with prefixes such as `env`, assignments, relative executables, and shell wrappers remain high risk. The regression table covers substitutions, backticks, redirects, pipelines, separators, newline/control input, `%...%`, `!...!`, tilde/globs, outside paths, and symlink-shaped operands.

The command working-directory guard separately canonicalizes the path and rejects symlink escape. The risk summary is descriptive, not an execution sandbox; it still assumes the operator's executable search path and shell initialization are trusted.

### (e) ask_user

Questions and answers use strict schemas, bound owner/source sessions and exact tool occurrence identities. Unknown question/options, duplicate selections, incompatible single-choice answers, or permission-grant fields are refused. Answers become structured tool output (or an explicitly labeled user-message follow-up), not executable authority. Custom user text may influence a model, but does not bypass the reviewed-effect guard.

New E2E probes reject answers under another session and extra permission fields. Existing restart tests retain the exact pending form plus queued follow-up; the extended restart test rejects a stale conflicting answer. Deferred answers have a stable client-message ID, preventing duplicate queued follow-ups. No cross-session authority bypass is confirmed.

### (f) Consent/onboarding

SR-05 rejects a merged positive consent version lacking a valid acceptance timestamp, including clearing a timestamp while keeping that version. Validation occurs before settings are persisted, so failed patches leave state unchanged. Stored inconsistent versions project as null, preserving completion while requiring renewal; a valid renewal survives restart. Partial updates to an already accepted state, renewal, completion, events and restart durability remain covered by SETUP-11. Legacy completion without a consent version can still migrate and requires renewal in the UI.

**Open policy boundary:** consent is App onboarding metadata (`crates/butler-gateway/src/gateway/application/settings/onboarding.rs:1`), not a gateway-wide model-call authorization check. Authenticated direct API and CLI clients are not required to navigate the App consent screen. Preventing all direct API model use until current consent requires an explicit shared consent policy/version and compatibility behavior for CLI/legacy installs; this review does not silently introduce that product change. An authorized caller can still explicitly attest acceptance by sending a valid version and timestamp.

### (g) Log export

SR-03 extends redaction while preserving timestamps, operational event/error codes, counts and non-sensitive path suffixes. Cookie headers, including quoted values and escaped JSON, and recognizable raw v2 session credentials are removed; labeled/grouped pairing codes and connection-link query codes are removed; home-directory username components are replaced for Linux, macOS and Windows, including escaped JSON, spaces and WSL UNC paths. Numeric PID/count values and `code=SIGKILL` remain intact. Complete operational exports are retained; conversation/model payload lines remain excluded by the existing export filter. The E2E verifies both exported log files and the summary and asserts that an unrelated `count=42` survives. JSON cookie masking preserves unrelated JSON fields.

Separate local developer/model-turn logs have a different redaction implementation (`crates/butler-runtime/src/operations/developer_log/redaction.rs:22`) and are deliberately excluded from `doctor --collect-logs`. Extending their privacy coverage is open; support-export success must not be interpreted as complete sanitization of arbitrary model/user text.

## Validation

All commands use the isolated runner, fresh temporary HOME/BUTLER_DATA/TMPDIR, preserved Cargo/rustup caches, `-j 8`, and at most eight test threads. E2Es use stub/replay fixtures only.

| Check | Result |
| --- | --- |
| `cargo build -j8 -p butler-agent --bin butler-agent` | Passed. Initial build 9m42s; subsequent builds reused the cache. Final build passed in 50.45s. |
| Pre-fix probes | Native log export and consent PATCH failed their new assertions; insecure App artifact/manifest redirect checks failed; the command-risk pin failed. The corrected durable-cookie, legacy-consent and wrong-instance stop-intent probes each failed against the relevant pre-fix behavior. Native AppImage helper: exit 1, prepared=true, previous_image_retained=false. Quoted-cookie export also failed before its fix. |
| First broad E2E run: 22 targets | 66 passed, 2 failed. The cookie fixture exceeded the debug clock's one-hour cap, and the newly rejected artifact source returned 422 instead of the promised unavailable status. Corrected the fixture, proved the actual cookie defect, and preserved the update-status contract. |
| Affected-path E2Es after the first fixes: 10 targets | 34 passed, 0 failed. Includes full active-plus-queued recovery. The final full 22-target run passed all 72 tests, including seven review regressions; zero failures or skips. |
| `cargo test -j8 -p butler-turn --lib -- --test-threads=8` | 110 passed, 0 failed. Includes authority/Bun oracle and workspace/command guards. |
| `cargo test -j8 -p butler-runtime --lib operations:: -- --test-threads=8` | 17 passed, 0 failed; rerun after quoted-cookie/path cases also passed (17). |
| `cargo test -j8 -p butler-agent --lib host::service::instance -- --test-threads=8` | 1 passed, 38 filtered; stop-intent wire pin. The earlier executable-target filter selected 0 tests and supplies no coverage. |
| `cargo test -j8 -p butler-platform --lib -- --test-threads=8` | 0 tests selected on this Linux build; native boundaries are exercised through E2E/CLI fixtures. |
| `cargo fmt --all`, `git diff --check` | Passed on the final source. No hook bypass was used. |
| `cargo run -j8 -p butler-source-check -- .` | Passed on the final source: 2,187 files scanned; zero function-length, platform, test-count, architecture, or E2E-gate violations. Non-E2E count stays 502. |
| Clippy on touched crates with `--all-targets -- -D warnings` | Initial invocation caught a missing UUID dependency in the new platform code. Reused the platform's existing temporary-name facility instead. A later invocation caught a missing statement semicolon; corrected it without lint suppression. Final invocation passed in 36.96s on all targets of butler-agent, butler-gateway, butler-runtime, butler-turn, butler-e2e and butler-platform. |
| `bun install --frozen-lockfile --ignore-scripts` | Passed, 1,605 packages installed. |
| `bun run check:verbose` | Failed: 955 passed, 25 existing skips, 1 failed out of 981 tests; 106 files, 3,125,637 assertions. The unchanged Project Ledger CRUD case took 9,072.30ms against 5,000ms. Gate 278.49s. No retries, skips or budgets changed. Exact test/implementation diff against main is empty. Added Linux evidence to existing [#418](https://github.com/Hexpy-Games/butler/issues/418#issuecomment-5952688939). Cause is unproven. |

The final E2E targets were `security_review`, `gateway_pairing`, `gateway_security`, `gateway_browser`, `gateway_remote`, `gateway_tunnel`, `gateway_rotation`, `setup_onboarding`, `settings`, `ask_user`, `service_diagnostics`, `service_supervision`, `service_stop`, `recovery`, `lifecycle`, `update_channels`, `updates`, `install_safety`, `install_hardening`, `install_lifecycle`, `install_versions`, and `cli_surface`.

The initial AppImage E2E used an unsupported `--version` setup command; corrected to `help`. That setup failure is not evidence for SR-07; the native helper probe above is. The real-time SSE probe then failed (six passed, one failed) before the one-shot expiry fix. The complete final matrix passes; none of these runs replace the failed Bun check. The final Clippy-only correction adds a semicolon and changes no behavior.

Measured behavior: `ask_user` kept one complete pending form and one stub model request across a 60.073648s idle window, with zero App/BTCC commits. Native logs measured 10s idle with zero modified files, log bytes, or disk-write bytes. Supervision restored readiness and drained the full queue in 2.083–5.064s across unmanaged/managed stand-ins and SIGKILL/replacement-required cases. `GET /updates` took 2.685ms while the manifest deliberately waited 3s; the forced check took 3.011s and verified the complete updated status. The 16-way pairing probes left zero devices after invalidation and exactly one after concurrent redemption. Wall-clock measurements are recorded, rather than enforced, in this stub tier; response/state assertions remain active.

Remaining environment check failure: `tests/unit/project-ledger-cli.test.ts:687` (#418). Native platform and product-policy investigations are listed above with source locations. No PR, tag, merge or CI rerun is part of this branch delivery.


## macOS follow-up — 2026-10-03

Implemented on `codex/mac-update-hardening`, based on `94973ff092ba` from `origin/codex/review-security`; publication is pending the runner's Git write permission.

- Archive admission now validates every entry and link graph before extraction. Absolute/traversing/ambiguous paths, special files, hard-link metadata, oversized entries and writes through symlink ancestors are refused. A canonical regular-file/directory ZIP is passed to `ditto` to retain AppleDouble signing metadata; links are created only after all writes and their canonical destinations must stay within the staged bundle. Strict/deep code signing, the installed signing team, restored role hard links and launch permission are checked before readiness or activation.
- Bundle replacement uses atomic directory exchange and a durable, bounded journal with old/new inode identities. Startup recovery holds the same exclusive lease and settles the recorded exchange or preserves the old bundle. The two-rename gap is removed. Unsupported atomic exchange fails before moving either bundle.
- CLI supervision retains the ownership pipe outside Tokio's `Child::wait` (which otherwise closes stdin). SIGTERM releases ownership and gives the Agent its six-second graceful deadline, then forces/reaps the group only after eight seconds. Worker EOF is observed independently of CPU initialization.
- Support export and developer/model-turn logging share one redactor. Cookies, quoted cookie headers, v2 credentials, pairing/link codes, home-directory usernames and complete bearer tokens containing `+`, `/`, `=` are covered; JSON shape, unrelated fields, event codes and API-key labels are retained.

Native Mac evidence, all in fresh temporary HOME/DATA with stub/replay providers:

| Check | Result |
| --- | --- |
| Hostile locally built ZIPs | Eight rejected: traversal, absolute path, escaping symlink, hard-link metadata, >1 GiB entry, FIFO, write through a link, and case-alias escape. Installed old bundle stayed runnable; no escaped file or journal. |
| Signed temporary bundle fault injection | Helper killed after journal, exchange, parent sync, launch and cleanup. Installed pathname always runnable; ordinary native Agent startup completed recovery at all five checkpoints. Valid signed symlinks survived extraction. |
| Signed but non-executable candidate | Rejected before readiness/exchange; old bundle remained runnable. |
| Real native Worker owner EOF | Exited during held CPU initialization in 13.073 ms; no survivor. |
| Supervisor death and SIGTERM | SIGKILL: 113.542 ms; SIGTERM: 6.035 s, including the Agent forced-stop deadline. Eight-second budget enforced, no Agent/Worker survivors, active turn and queued follow-up recovered. |
| Shared redaction and support export | 17 runtime operation tests and two native diagnostics E2Es passed. Ten-second idle: zero changed files, log bytes or disk-write bytes. |
| Actual packaged .90/.91 ZIP | Native helper admitted the staged .91 bundle; strict/deep signatures, framework symlinks, role hard links, manifests and modes passed. EOF cancellation preserved installed .90 and removed staging. This is archive admission proof, not GUI A→B activation proof. |

The source concerns above are addressed and native crash/ownership regressions pass. Qualification remains incomplete: packaged Electron aborts with SIGABRT before its CDP page, even with `--single-process`; `hdiutil create` fails with `Device not configured`, so the DMG mount/install smoke cannot complete. Developer ID/notarization, actual power loss, candidate crashes after successful spawn, and Windows execution remain unvalidated. Ad-hoc signed process-kill fixtures do not establish those claims. No owner installation or real owner DATA was accessed.


UI/check follow-up (same working copy; `codex/ui-smokes` publication remains pending):

- #389 is a fixture correction: the public permission menu starts with Ask first, and Full access is selected through its current accessible menu item. #390's 2 px Wallpaper/WallpaperPicker overflow is the browser's default horizontal fieldset margin on Slider; reset that margin only. Navigation fixtures now await the rendered gallery/page and fonts instead of network idleness on a gateway with persistent streams. #391's vector guide/outline reveal now uses transform/opacity clipping windows, preserving its geometry and timeline beats.
- #418: record CLI operations resolve the ledger root once per synchronous operation. A 37-command profile reduced existence probes from 22,620 to 4,287 and reads from 3,863 to 1,244. Timings (429/377 ms) were noisy and are not a latency claim. The CRUD fixture runs independent read-only phases concurrently while mutations remain ordered and all 131 assertions and the 5 s budget remain; focused time 3.59 s versus 6.47 s before.
- The previously failing repository privacy audit reads every tracked text file through 16 bounded readers; no path filter, result loss or budget change. Existing #452 has evidence linked in its issue.
- Restricted Chromium flags are explicit through `BUTLER_SMOKE_BROWSER_ARGS`. Each single-process context owns its browser, teardown is idempotent, and complete CDP ReportEvents traces preserve the renderer PID/thread boundary. Native smoke servers retain an ownership pipe. Node 22 was used for repeated-context runs after Bun's Playwright transport hung; assertions stayed intact.

| Follow-up check | Result |
| --- | --- |
| fmt; touched-crate all-target Clippy `-D warnings`; diff whitespace | Passed. |
| Source-check ratchet | Passed: 2,195 files, 502 non-E2E tests, 405 unmarked, zero violations. |
| Existing native CLI/install/update/supervision/shutdown E2Es | 34 harness cases passed across 11 targets; Linux AppImage execution explicitly unavailable on this Mac. The redirect fixture now uses a bindable local listener and an actually reachable untrusted destination instead of unavailable `127.0.0.2`. |
| Frozen dependency install; full Bun check; packaging unit gate | Passed on the final working copy. Earlier full verbose check: 959 passed, 22 existing skips, 106 files, 3,125,680 assertions. Generated target traversal failed in an overlapping run; removing the task target before the final check resolved it. |
| DS bundle/font assets/navigation/mobile, app DS, conversation stories, question panel | Passed; mobile evidence is Chromium in this restricted runner. |
| App boot/reload, ask-user, branch actions, Steward pill, screen contracts, pairing, composer caret | Passed. |
| Layout, consent, reply language | Passed. Consent: 40 cases, 598 text nodes, minimum contrast 4.9498. Reply fixture now starts at Welcome and uses the current consent copy; all persistence/language assertions remain. |
| DS overflow and standalone DS site | Passed: 308 pages; site root and `/ds/` builds, deep links, navigation, phone layouts and zero foreign requests. Wallpaper cells: scroll width 371 -> 369 px, client width 369 px. |
| Full motion trace | Failed: Color passes the transform/opacity property contract, but 5.83 ms/frame exceeds 0.5 ms. Isolated hero profiling showed 60 fps, zero layouts/paints/long tasks, 486 animations and 120 style recalculations per two-second window (6.15 ms/frame). A compositor-hint experiment still exceeded the budget (3.90 ms) and was reverted. Other hero performance is descriptive, not accepted. No budget or assertion was changed. |
| Font rendering / Electron first-run | Web English/Korean face assertions passed after correcting initial locale-subset checks and comparing unique families while retaining raw font-face arrays. Electron font rendering could not open its window. After installing the correct local Electron binary, first-run still failed with SIGABRT before CDP, matching the packaged GUI limitation. |

Twenty-four before/after PNGs are retained under `.tmp/ui-smokes/`. No UI motion-performance acceptance, packaged GUI A→B, DMG mount/install, Safari qualification or remote publication is claimed. The 22 GiB task target and isolated HOME/DATA directories were removed; inventory found no running executable under this task's temporary installation roots. Git fetch/staging are denied at `FETCH_HEAD`/`index.lock`; no commit, push, PR, tag or merge was performed.
