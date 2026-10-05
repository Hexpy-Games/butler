# Firefox composer flicker investigation (#525)

Investigated 2026-10-05 from `origin/main` at
`ec138feae3d4244fc29537c76fbd1729c0372d9c`.
Issue: https://github.com/Hexpy-Games/butler/issues/525

The final fetch advanced main to `eed5aacf1201732e434b6b55572e7f48414ddfb4`
(preview.10); this branch fast-forwarded to it before delivery. The suspect
paths were rechecked. Upstream already limits Composer's subscription to the
empty/nonempty text boundary; this investigation did not implement that change.

## Result

**Reproduction blocked; root cause unconfirmed.** No product or frozen DS files
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

## Remaining acceptance work

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
