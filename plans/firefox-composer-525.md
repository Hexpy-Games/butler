# Firefox composer flicker investigation (#525)

Investigated 2026-10-05 from `origin/main` at
`ec138feae3d4244fc29537c76fbd1729c0372d9c`.
Issue: https://github.com/Hexpy-Games/butler/issues/525

The final fetch advanced main to `eed5aacf1201732e434b6b55572e7f48414ddfb4`
(preview.10); this branch fast-forwarded to it before delivery. The suspect
paths were rechecked. Upstream already limits Composer's subscription to the
empty/nonempty text boundary; this investigation did not implement that change.

## Initial Mac result

**Mac reproduction blocked; root cause unconfirmed.** No product or frozen DS files
were changed. No regression smoke was added: there is no demonstrated failing
app signal to assert yet. The Firefox launch failure is an environment failure,
not evidence of the owner's Windows UI flicker.

## Verified execution evidence

- Installed Playwright Firefox 148.0.2, revision 1511, into a temporary browser
  directory; Playwright version 1.59.1.
- Default headless launch under Bun 1.3.11 timed out after 180,000 ms.
- Default headless launch under Node 22.19.0 timed out after 30,000 ms.
- A separate Node launch with content/GPU sandbox disable environment flags and
  software/accelerated rendering preferences also timed out after 30,000 ms.
  This diagnostic did not change app settings, tests, or production security.
- All three launches emitted these errors before any app page could be opened:

  ```text
  sandbox_extension_issue_file_to_process failed for .../plugin-container.app:
  1 (Operation not permitted)
  RenderCompositorSWGL failed mapping default framebuffer, no dt
  ```

- Isolated UI preview build passed at the initial revision. `bun run check`
  passed at both the initial and final-main revisions.
- `cargo +1.91.0 fmt --all` passed; source-check passed from
  `packages/butler-agent/rust` (architecture and E2E gate: zero violations).
  Running Cargo from the repo root first selected Rust 1.90, which was rejected
  by source-check's Rust 1.91 requirement. A root-level source scan then rejected
  a dependency symlink in `node_modules`; the successful command used the same
  working directory as Rust CI. No ratchet or check was modified.
- No Rust crate changed, so touched-crate clippy is not applicable.
- Explicit build/check/browser commands used temporary HOME and BUTLER_DATA.
  Exception: the initial commit omitted those variables, so its pre-commit
  lint/typecheck ran with the default HOME. That hook runs no tests. The commit
  was amended with isolated HOME/BUTLER_DATA and the normal hook enabled.
  No live Butler install, service, port 18765, or provider was used. Temporary
  data and build target are removed at task closeout.

## Suspects checked against current main

All paths below are relative to `packages/butler-app/client/ui/src/`.

| Suspect | Verified code path | What remains unproven |
| --- | --- | --- |
| Textarea auto-resize | `components/conversation/ComposerTextArea.tsx:29-43` renders Lexical `ContentEditable`. `libs/design-system/lib/useTextareaGrow.ts:5-15` is used by the separate DS Textarea, not this composer. | Older win-fixes builds may differ; current-main textarea recalculation is not on the composer input path. |
| Draft cache | `app/composerDraftCache.ts:108-119` writes localStorage and an optional Electron bridge without a timer or React state update. `components/conversation/composerStore.ts:44-56` updates the store before persistence; `Composer.tsx:37` now subscribes only to text's empty/nonempty boundary. | Per-edit React commits and storage cost need measurement; no proof that persistence causes flicker. |
| Reserve/ResizeObserver | `components/conversation/hooks/useReserveHeight.ts:11-15` measures the composer; `Conversation.tsx:65-70` suppresses unchanged integer reserve updates. | Observe actual size churn and correlate it with typing and parent commits. |
| Scroll anchoring | `components/conversation/MessageList.tsx:49` uses the virtualized scroller with `overflow-anchor: none` in `libs/design-system/blocks/ConversationShell/ConversationShell.module.css:40`. New-chat uses a locked scroller (`Conversation.tsx:110`). | No observed scroll or anchor movement in Firefox; not a confirmed shared explanation. |
| Glass repaint | `libs/design-system/components/TintedGlass/TintedGlass.module.css:22-23` owns backdrop filtering; ComposerCard composes that surface. | Gecko repaint/rasterization remains a hypothesis, not a demonstrated root cause. |
| Containment/compositing | `libs/design-system/blocks/ComposerCard/ComposerCard.module.css:4,21,41` uses inline-size containment, transform and translate. The reviewed ComposerCard, ConversationShell, TintedGlass and Collapsible CSS contains no `will-change`. | A/B diagnostics need actual Firefox frames. |

## Original acceptance work (Windows follow-up below)

1. Run the isolated app preview with Playwright Firefox on a host where Firefox
   can connect and render, preferably Windows matching the reported builds.
2. Measure both a populated conversation and new-chat while typing short and
   multiline drafts, followed by an idle interval. Capture ResizeObserver
   notifications, per-frame element boxes, scroll offsets and React commits.
   Detect whether layout-shift PerformanceObserver entries are supported; an
   unsupported API must not be reported as zero shifts. Save screenshots for
   visual inspection, without pixel sampling as a pass/fail gate.
3. Compare Chromium with `BUTLER_SMOKE_BROWSER_ARGS='["--single-process"]'`
   on this restricted host. Keep content, counts and order assertions alongside
   any performance measurement.
4. A/B one suspect at a time using temporary instrumentation. If the root cause
   is screen-owned, implement the minimal fix and an app-signal Firefox smoke
   that demonstrably fails before and passes after. Capture affected screens
   before/after in both themes, desktop/mobile, wallpaper/plain and
   pending/completed onboarding.
5. If the demonstrated cause is DS-owned, comment the exact owning component,
   line and evidence-backed proposed change on #525; leave the DS frozen.
   No DS change is proposed by this investigation without that evidence.

Minimal launch diagnostic after installing Firefox in a temp browser directory:

```sh
# Set HOME, BUTLER_DATA and PLAYWRIGHT_BROWSERS_PATH to isolated temp directories.
node --input-type=module -e '
  import { firefox } from "playwright";
  const browser = await firefox.launch({ headless: true, timeout: 30000 });
  console.log(browser.version());
  await browser.close();
'
```


## Native Windows follow-up (2026-10-05)

**Firefox renders on Windows, but the reported flicker is not reproduced in
captured headless frames. Root cause remains unconfirmed.** Product and frozen
DS files are unchanged. No regression smoke is claimed: there is still no
observed failing app signal with which to demonstrate before-fail/after-pass.

### Method and scope

- Started from `codex/ff-flicker-525` at `b4b059460`, with preview.10 main
  `eed5aacf1`. Used the dedicated `ff-flicker-525-win` Windows worktree.
- Built the Vite production UI preview natively. Used the existing
  `?visual=components` fixture, which mounts the actual `Conversation`,
  virtualized `MessageList`, Lexical editor, Composer and frozen DS surfaces.
  Temporary fixture edits selected `draft:chat`, empty messages/summary/progress
  for new-chat, and temporarily allowed disabling the entire draft persistence
  function. All temporary product edits were restored after each run.
- A Node server bound an ephemeral `127.0.0.1` port. Non-static gateway calls
  returned a null stub response; new-chat used its normal fallback suggestions.
  There was no Agent/Electron/installer execution and no model call. This is a
  renderer fixture experiment, not gateway integration or owner-scale data proof.
- Playwright 1.59.1: Firefox 148.0.2 (1511) and Chromium 147.0.7727.15 (1217).
  Browsers were downloaded into a task-owned temp `PLAYWRIGHT_BROWSERS_PATH`.
  Headed Firefox launched but closed before `newPage`; the SSH session could
  not provide a usable headed page. Headless Firefox and Chromium rendered.
- Desktop 1280×900, light/dark, populated conversation and actual new-chat.
  Each case typed the complete 26-character suffix after `D`, then reset to `D`
  and typed ten lines (230 edits), then idled for 2.5 seconds. Animation frames
  recorded all target rectangles, scroll offsets, editor identity/focus;
  ResizeObserver notifications, root React commits, draft writes and supported
  layout-shift entries were recorded independently. Screenshots were saved at
  four short-draft checkpoints and after lines 4 and 10, and visually inspected.
  No pixel sampling or screenshot-difference gate was used.
- Each phase asserted the complete draft and unchanged ordered body content.
  The new-chat moment label was excluded from the invariant text comparison
  because it legitimately changes on a minute boundary; suggestion content
  remained included. Every sampled frame retained editor identity and focus.
- Light-theme A/B changed only one suspect per fresh browser context: glass
  filtering, floating transform/translate (position preserved), inline-size
  containment, reserve observer delivery, or the entire draft persistence path.
  Dark-theme baselines were measured separately. Diagnostic CSS overrides only
  existed in the browser page; no frozen DS source was edited.
- An initial diagnostic used exact class-marker selectors instead of token
  selectors and timed out after rendering. An intermediate new-chat fixture
  retained prior task progress and its clock-text invariant crossed a minute;
  those diagnostic runs are excluded from the final matrix. Component counts
  were corrected to compare current/alternate Fiber snapshots; raw Fiber flags
  alone persist across commits and overcount reused components.

### Measurements

- Final typing matrix: **28 cases, 84 phases, 18,625 animation-frame samples,
  168 screenshots, zero page errors**. All complete-draft/body/identity/focus
  assertions passed. Persisted summaries and 16 representative baseline images
  are in [the evidence directory](../tests/smoke/evidence/firefox-525/README.md).
- Both engines, both screens and themes: short typing had **0px rectangle and
  scroll drift, 0 composer ResizeObserver notifications, 26 root commits,
  0 Composer-shell renders**. These are editor commits, not a per-key shell
  rerender. Every idle phase had **0 commits, 0 observer notifications, 0 draft
  writes and 0px drift**.
- Baseline multiline: **147px** monotonic composer growth, **7** composer size
  notifications/shell renders. Root commits: **258** in the populated fixture,
  **237** in new-chat, in both engines/themes. The transcript bottom-following
  scroll moved **147px**; the editor scroll moved **51px Firefox / 48px
  Chromium** after reaching its eight-line cap. This is expected growth and
  scrolling, not oscillation. No downward composer-height step was sampled.
- Reserve-delivery A/B retained seven actual size notifications but suppressed
  the app callback: multiline root commits fell to **230** and shell renders to
  **0** in both engines/screens. It also prevented the needed bottom-reserve
  update, so this is a diagnostic intervention, not an acceptable fix.
- Draft-off A/B: **0 writes**, unchanged baseline layout/commit behavior.
  Baseline short/multiline writes were **26 / 230**. Largest observed individual
  storage write: **1ms** (fresh isolated cache; not owner-scale storage proof).
  Transform/translate and inline-size containment A/B did not produce or remove
  an observed layout failure.
- Firefox did **not support** `layout-shift`. Chromium supported it: **0**
  short/idle shifts, **7** baseline multiline entries corresponding to growth.
- Separate same-page glass A/B/A, with no screenshot in the timed 2.5s interval:

  | Engine / screen / theme | Original median interval | Glass off | Restored |
  | --- | --- | --- | --- |
  | Firefox conversation light | 37ms | 28ms | 35ms |
  | Firefox conversation dark | 36ms | 28ms | 35ms |
  | Firefox new-chat light | 18ms | 18ms | 18ms |
  | Firefox new-chat dark | 31ms | 31ms | 30ms |
  | Chromium conversation light | 18.1ms | 16.6ms | 16.7ms |
  | Chromium conversation dark | 16.6ms | 16.7ms | 16.6ms |
  | Chromium new-chat light | 17ms | 16.6ms | 17ms |
  | Chromium new-chat dark | 16.6ms | 16.6ms | 16.6ms |

  All **24 idle windows** had zero commits/observer notifications/writes and
  retained the complete draft. This is descriptive headless scheduling evidence,
  not a latency budget or flicker gate. Chromium reported ANGLE/SwiftShader;
  Firefox's WebGL string was privacy-sanitized (`GTX 980 ... or similar`), so it
  cannot establish the host's actual GPU. These are not matched interactive
  hardware-acceleration measurements. The new-chat bloom canvas was present,
  visible and 1278×900. There is no consistent new-chat improvement to explain
  the reported symptom on both screens.

### Interpretation and next acceptance

1. Stable nonempty typing does not reproduce a layout/reserve or Composer-shell
   churn problem. Multiline size/scroll changes track legitimate editor growth;
   observer activity stops at the height cap and during idle. This evidence does
   not rule out an intermittent GPU paint failure between saved screenshots.
2. Disabling draft persistence removes all draft writes without demonstrating
   a flicker fix. No timer-driven writes were seen during the idle interval.
3. The glass A/B is a rendering-cost clue, not proof of a DS-owned flicker.
   Frozen `TintedGlass/TintedGlass.module.css:22-23` owns the filter;
   `ComposerCard/ComposerCard.module.css:4,21,41` owns containment/transform.
   No appearance-reducing production change is justified by these observations.
4. Remaining: reproduce the owner's visible symptom in an interactive Windows
   Firefox session, ideally compare the originally reported win-fixes build
   with preview.10; correlate the paint failure with these signals. Then either
   implement an evidenced screen fix plus a failing/passing app-signal smoke,
   or request a specific evidence-backed DS change on #525. Full visual
   before/after mobile/plain/wallpaper/onboarding matrices apply when a product
   fix exists; none was made here.
5. GitHub Windows confirmation belongs to the coordinator's combined PR/CI run;
   this task intentionally opens no PR and triggers no separate CI campaign.

### Checks and isolation

- Windows frozen dependency install and native Vite preview build: passed
  (final diagnostic build retained all normal UI features unless one A/B flag
  was selected). Full typing matrix and separate glass A/B/A: passed their
  draft/content/focus assertions; visual flicker remains unconfirmed.
- Mac isolated frozen dependency install and `bun run check`: passed.
  `cargo +1.91.0 fmt --all` and Rust-workspace
  `cargo +1.91.0 run -p butler-source-check -- .`: passed, architecture/E2E
  violations **0**. No Rust crate changed, so touched-crate clippy is not
  applicable; Windows ORT/Agent builds were unnecessary for this renderer slice.
- Every build/check/browser run used fresh temp HOME/BUTLER_DATA; Windows also
  redirected LOCALAPPDATA/APPDATA. Each PowerShell run compared
  `reg query HKCU\Software\Classes\butler /s` before/after: unchanged. No
  protocol/login-item/shortcut/service/installer path was executed. Browser
  servers and Node runners recorded exact PIDs and closed in `finally` blocks.
- Final fetch advanced main to `cecaaccdb` (macOS ad-hoc signing policy only).
  It is merged before delivery; measured UI/DS sources are unchanged.
  Final merged frozen install, `bun run check`, fmt and source-check all
  passed again (architecture/E2E violations 0). `git diff --check` passed.
- Windows final audit: **owned processes 0**, original clone and task worktree
  tracked status clean, registry sentinel unchanged. Removed the task worktree,
  temp Playwright browser tree and all task profiles. No software or system
  settings were installed/changed. Removed the Mac task Cargo target after
  final checks. No PR, tag, deployment or merge into main was performed.
