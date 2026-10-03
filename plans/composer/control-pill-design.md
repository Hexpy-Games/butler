# Separate composer controls

Status: implementation candidate, 2026-10-03; interactive owner review on Monday 2026-10-05.
Issue: [#473](https://github.com/Hexpy-Games/butler/issues/473).
Branch: `codex/composer-ideas-research`. Owner request: **컴포저 컨트롤 영역 분리**.

## Authority and scope

Separate input and controls into two visible surfaces; keep the glass control pill in the space immediately below the input even when the editor is collapsed. This document specifies Monday's owner walkthrough (2026-10-05); it does not claim a working prototype exists.

Baseline: `10b68356da71fafdd3c5551ef7cb62d51ee35da3`, also GitHub main on the access date. Architecture authority: [work-model design at 0df4b620](https://github.com/Hexpy-Games/butler/blob/0df4b6203b82922fc77cadd2cd41e7fac79d0b35/plans/work-model/work-model-design.md), especially §§2, 3, 5. Immutable Ledger Spec bodies and SQLite mutable state remain owned by that design. This visual change creates no Work/Task, second queue, control protocol or approval authority. Repository documents are review artifacts; real owner Ledger access/publication is excluded by this task's isolation rule.

Goals: reliably reachable controls, unobstructed text, stable focus and selection, usable small screens, unchanged message/approval semantics. Non-goals: new work-model controls, new editor, changed defaults/access grants, attachment drawer redesign, mockups, product code or rollout. Retain Local as the initial workspace selection.

## Current code evidence

Paths below use `UI = packages/butler-app/client/ui/src/`; references are source observations at the baseline, not runtime measurements.

| Evidence | Reference | Design implication |
|---|---|---|
| One form currently owns glass surface, adjunct and children. | `UI/libs/design-system/blocks/ComposerCard/ComposerCard.tsx:46` | Keep one form, split its visual surfaces inside DS. |
| Card toolbar has a divider; compact state hides expanded controls. | `UI/libs/design-system/blocks/ComposerCard/ComposerCard.module.css:125`, `:219` | Move glass styling and visibility responsibility, not submit ownership. |
| Toolbar includes attach, access, workspace, Plan, context, model and send/stop. | `UI/components/conversation/ComposerToolbar.tsx:33` | Reuse real commands and menus; no parallel toolbar store. |
| Authority/question/plan modes return early, replacing normal toolbar. | `UI/components/conversation/ComposerInputSurface.tsx:30` | Hoist the control slot above the mode switch; preserve panel handlers. |
| Stop currently calls cancellation; card reserves measured height. | `UI/components/conversation/Composer.tsx:101`, `:113` | Do not relabel current cancellation as future resumable stop. |
| Editor is Lexical keyed by draft session, with composition events and eight-row cap. | `UI/components/conversation/ComposerTextArea.tsx:15`, `:29` | Keep editor identity and composition ownership stable. |
| IME guards precede Enter submit; Escape closes menus. | `UI/components/conversation/hooks/useComposerKeyboard.ts:38` | Surface relocation must not intercept editor keys. |
| ResizeObserver reserves the wrapper's complete height. | `UI/components/conversation/hooks/useReserveHeight.ts:8` | Measure panel + input + gap + pill, not input alone. |
| TintedGlass supports control/panel/popover/composer, not pill radius. | `UI/libs/design-system/components/TintedGlass/TintedGlass.tsx:6` | Add a DS-owned pill radius; no product CSS override. |
| Bottom anchoring includes safe-area and keyboard tokens; keyboard token defaults to zero. | `UI/libs/design-system/blocks/ComposerCard/ComposerCard.module.css:11`; `UI/libs/design-system/tokens.css:10` | Insets are an existing seam, not evidence mobile keyboard handling works. |

Open/closed issue search on 2026-10-03 used composer, 컴포저, wallpaper, glass and decoration. #25 concerns attachments/optional drawer and is closed; #173 concerns mentions; #468 concerns caret smoke geometry. None covers the separated always-visible pill. #473 is the single new feature issue; preserve those related scopes.

## Prior art and option choice

Primary sources, all accessed **2026-10-03**:

| Source | Relevant practice and Butler choice |
|---|---|
| [WAI-ARIA toolbar pattern](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/) | True toolbar semantics imply roving focus and arrow navigation. For this initial mixed Select/menu group, use labelled `role=group` and ordinary Tab order. Do not claim toolbar semantics without implementing that contract. |
| [WCAG contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) | Normal text needs 4.5:1. Verify final composited colors on wallpaper; translucency alone provides no guarantee. |
| [WCAG target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) | Minimum target/spacing requirements inform the floor; Butler chooses 44px mobile hit areas, above the 24px minimum. |
| [WebKit safe-area guidance](https://webkit.org/blog/7929/designing-websites-for-iphone-x/) | Use environment insets with a normal minimum gutter. Safe-area variables are not a keyboard-height API. |
| [W3C UI Events](https://www.w3.org/TR/uievents/#events-compositionevents) | Composition spans multiple events. Keep the native composition session intact while controls/panels change. |

| Option | Trade-off | Decision |
|---|---|---|
| Keep toolbar inside input card | Few changes, but does not deliver requested separation. | Reject. |
| Independent fixed-position toolbar | Easy visual split, but duplicates positioning/reservation and risks form/focus drift. | Reject. |
| One form, stacked input surface and separate glass control surface | Small DS/API change; shared geometry and submit ownership survive. | Recommend. |
| Wrap controls onto multiple pill rows | Everything visible, but unpredictable editor movement and tall mobile obstruction. | Reject for primary row. |
| Horizontal scrolling | Fits all controls, but hides affordances/send and complicates focus. | Use only inside long pickers, not the pill. |
| Stable essential controls + explicit overflow | Fixed height and reachable secondary controls; one extra click on narrow screens. | Recommend. |

## Layout contract for the design agent

Reading order from top to bottom: notices → progress adjunct → active question/decision panel → input/compact preview → **8px clear gap** → control pill. All surfaces share a conversation-centered wrapper. Empty notice/adjunct/panel slots take zero space. Question and decision cards remain distinct readable surfaces above the input, never floating behind the pill. Decorative extension rules are in [decoration design](decoration-themes-design.md).

Dimensions are acceptance geometry in CSS pixels, implemented with existing DS tokens or a narrowly named DS token where absent. No product inline styles, raw interactive elements or new product CSS modules.

| View | Input and panel | Control pill |
|---|---|---|
| 375px viewport, no sidebar | 16px gutters, 343px wrapper; editor 1–8 rows, internal vertical scrolling beyond 8. | Same 343px width, 52px high, 4px inner inset; 44px mobile targets with 4px gaps. |
| 1280px viewport, no side panels | 760px content wrapper centered at x=260; 16px input padding. | Same 760px width; 42px high, 6px inset, 30px controls. |
| 1280px with sidebar/inspector | Center within available conversation pane; width `min(760px, pane width - 32px)`. | Overflow follows **container width**, never viewport width alone. |

375px row, left to right: attach (44), access icon (44), model trigger (107, ellipsized visual name), More (44), send/stop (44); four 4px gaps and two 4px insets total 307px, leaving 36px flexible spacing before send. Model has full accessible name and opens full value; no stored value is truncated. Access icon always names its exact current mode. Workspace, Plan and context move to More. Workspace remains Local until explicitly changed; no hidden reset on resize.

1280px row: attach → access → workspace when applicable → active Plan badge → context → model → flexible spacer → send/stop. Add More only when needed. Labelled controls use existing `ComposerControl`/`PillButton`; adjacent DS buttons use matching-size `ButtonContainer`. Outer `TintedGlass radius="pill"` is a planned DS extension, not an existing prop.

Overflow uses deterministic priorities: move context, then Plan, then workspace; then use compact access and bounded model labels. Keep attach, access, model, More and send visible at 375. At 320px collapse model to a labelled icon to retain 44px targets. Container ResizeObserver triggers recalculation only when size changes; never measure every key. Freeze placement while an affected popup is open; on required narrowing close it, focus More, and retain its selected value. No duplicate hidden focusable controls. Overflow is a DS Popover with the **same Select/form controls**; do not represent model selection as action-menu items.

Use one rounded pill even in overflow; do not stretch across the entire app under the sidebar. Never hide it on blur, idle, empty input, panel replacement or compact editor state. Modal overlays may occlude it normally; “always visible” does not bypass dialog modality.

### Visual and viewport states

- Light/dark: input and pill use TintedGlass tokens independently; 8px wallpaper gap stays visibly clear. Focus ring is drawn outside each control without clipping by the glass surface. Icons/interactive boundaries target 3:1; all normal text including placeholder targets 4.5:1.
- Wallpaper: no label sits directly on an image. The DS glass fill must include a sufficient neutral contrast floor; if contrast cannot be guaranteed, use the DS opaque surface fallback, preserving layout. Test white, black, high-frequency and mixed bright/dark wallpaper in both themes. Do not run a per-keystroke luminance sampler or animate blur.
- Compact: preview stays in the **input surface**, with a visible hit target to expand; controls remain in the separate pill. Restore the same editor/selection rather than mount another input.
- Sending/active turn/blocked-image/reconnecting: keep the existing capability-driven send/stop/busy branches and reasons. Disabled control plus terse tooltip suffices; no banner or invented completion state.
- Mobile anchor: pill bottom is 12px above the unobscured viewport bottom plus the applicable bottom safe inset. One shell-owned VisualViewport resize/scroll adapter calculates keyboard occlusion; subtract it once, do not double-count layout-viewport resizing. When keyboard already covers the home-indicator region, do not add that inset a second time. Use landscape left/right safe insets with the 16px minimum gutter.
- Short viewport/200% zoom: pill remains reachable; editor reduces its visible rows down to one and scrolls internally, panel body scrolls above it with panel actions visible. If the complete minimum stack cannot fit, the composer region itself scrolls while its pill stays sticky within that region. Never overlap panel controls or clip required questions.
- Shell viewport/geometry adapters are browser-neutral DS/shell code. Any native keyboard/window adapter belongs in Rust `crates/butler-platform`, with a narrow existing bridge; no OS-specific branches in domain or product UI.

## Interaction and authority states

DOM/focus order matches the layout: notice actions → adjunct actions → panel controls → editor (or compact preview) → attachment remove actions → attach → access → workspace/Plan/context when visible → model → More when present → send/stop. Omit absent controls; reverse exactly with Shift+Tab. Arrow keys retain their meaning inside editor/Select/popover. Escape closes the topmost popup and returns focus to its opener; it never approves/rejects or discards text. Existing `mod+shift+e` editor focus shortcut remains.

A panel arriving does not steal focus from typing, selection or an open IME candidate window. Announce its concise pending state through existing status semantics. Authority > question > plan precedence remains as at `ComposerInputSurface.tsx:30`; pending items are retained by their current owner, not replaced by this layout.

During an active decision/question, the input surface shows its existing reply/revise action or compact draft preview. The pill is still present. Message-specific controls that cannot apply are visibly disabled with a reason; panel-local confirm/deny/answer buttons retain exact actions and identities. Pill Send must not submit approval or answers accidentally. Enter in panel follows that panel's existing handler; there must be no nested HTML form. “Write a message” explicitly restores the editor and draft without resolving the pending decision. An available session-stop command remains independent of decision submission.

Composition-start/update/end stay in the existing editor. No reparent/remount on expanded-state, breakpoint, decision arrival or theme change. Do not synthesize Enter, prevent native candidate selection, read candidate strings or trigger submit at composition-end. Preserve selections, attachments and reference tokens through collapse/expand, menu close, send rejection and panel return.

## Architecture and contracts

Extend the existing DS `ComposerCard` with `controls: ReactNode` and `panel?: ReactNode` slots. The single form becomes a neutral layout wrapper; DS-owned glass surfaces wrap the panel/input and controls individually. `adjunct`, `notice`, `expanded`, `containerRef` and form submit props preserve their owners. `ComposerCardToolbar` becomes the pill's inner layout; remove compact-state control hiding on this path. Migrate all existing ComposerCard consumers, including dashboard, harness and showcase, in the same slice; no permanent old/new duplicate route.

`ComposerInputSurface` supplies mode-specific input and panel content; `ComposerToolbar` is mounted once outside its early returns. Product containers select capability/command props; DS owns visual state, overflow geometry and accessibility. `ComposerCard` receives final labels, not store/API imports. Selection and draft remain in the existing composer/Lexical owners. Height reservation measures the full wrapper via existing `useReserveHeight`.

No new network API or persisted layout preference is required. Use current `canSend`, `canStop`, busy, selection and pending-decision state; decision replies carry their existing request identity. Every non-submit control uses `type=button`. Future work-model integration must use its durable instruction receipts and control epochs: Queue releases at Task completion for tiers 1/2 and answer-end for tier 0; Steer applies at a safe point. Never infer those semantics from a visual stop icon. This branch neither implements nor advertises them before the owning work-model slice lands.

Security: menus preserve access policy, exact action text and attachment authority; moving a button never widens grants. No draft/selection content in layout telemetry. Resizing, focus and panel presentation create no runtime mutation.

## Performance targets and proof

These are **proposed acceptance budgets, not measured results**. Use owner-scale synthetic data: ~1.3GB App DB, 600+ chats/~300k events, ~7GB BTCC DB, 2,440 transcripts/1.5GB (largest 290MB), metrics >300MB. Do not read owner data. Layout depends only on active composer and bounded projections; no transcript/catalog scans on input.

- Incremental pill-layout work: p95 <1ms per edit, no additional synchronous layout read in the edit handler; container resize/overflow calculation p95 <4ms.
- Ten-second sustained typing at 10 edits/s: no added >50ms main-thread task attributable to the pill; no lost/reordered characters, references or attachment state. Compare same build with layout enabled/disabled using a disposable harness.
- Settled idle: 0 attributable durable writes, 0 polling requests, 0 repeating geometry timers in three 60s windows. Report whole-process I/O separately; existing draft autosave on real edits is not feature-idle I/O.
- Opening an overflow with 20 controls: p95 ≤50ms input-to-next-paint locally, every control reachable in deterministic order; no top-N removal. Locale text length/200% zoom must not change command identity.

## Implementation branches and acceptance

| Branch | Public outcome and required proof |
|---|---|
| `codex/composer-control-pill` | A-01: actual conversation, new-chat and project-dashboard composers have two surfaces at 375/1280; all current commands work. A-02: persistent pill in collapsed, empty, sending, question and approval modes. A-03: no selection/IME/draft regression; full-stack reserve prevents last-message occlusion. DS API + its real consumers ship together. |
| `codex/composer-pill-mobile` after first | A-04: overflow, 320/375/390/430/tablet/1280, 200% zoom, safe areas and keyboard; exact 375 layout above. A-05: light/dark/wallpaper contrast, focus/popover clipping and reduced motion. A-06: budgets with correctness assertions at owner scale; integrate B without text overlap. |

Start implementation with failing public-path smoke scenarios; no UI unit tests or recordings. Reuse `tests/smoke/app-composer-caret-smoke.ts`, `app-composer-refresh-smoke.ts`, `composer-question-panel-smoke.ts`, `composer-decision-panel-smoke.ts`, `ds-question-panel-smoke.ts` and applicable `app-layout-smoke.ts`/DS viewer coverage. Preserve assertions; account for open caret issue #468 rather than retrying to green. Inspect current issue status before treating it as a blocker.

Stub E2E in `crates/butler-e2e`: send via actual gateway, decide exact pending request once, preserve queued follow-up content/order; if backend is unchanged reuse its existing request/queue tests rather than create a redundant test. Non-E2E logic tests only if necessary and tagged `// test-category: pure-logic|race|security|format-pin` with one actual category; source-check ratchet cannot grow. All runs use fresh temporary HOME/BUTLER_DATA and cleanup. Browser smokes here require `--single-process`; native iOS keyboard/IME needs physical-device owner proof, not synthetic-event claims.

Monday walkthrough script for the later implementation/mockup: compare 375/1280 light/dark and four wallpapers; type Korean with IME and a long mixed-language draft; open all menus; narrow with a menu focused; show question then approval; switch back to draft; use keyboard-only send and stop; verify final message stays visible above the entire stack. Record which steps are static mockup review versus working-product proof.

Before each implementation push: fmt, touched-crate clippy `-D warnings`, source-check, frozen Bun install/check for TS/UI, and focused existing smokes. Files ≤500 lines, production functions ≤80; preserve stricter DS limits. Coordinator batches CI; no PR from this design branch.

## Review, risks and owner decisions

Self-review: requested separation/visibility, two widths, both themes/wallpaper, overflow, panels, keyboard/IME, safe-area, DS ownership, security, work-model authority and numbered acceptance are covered. Highest risks are current early-return modes losing the toolbar, compact CSS hiding controls, clipped focus rings in TintedGlass, and double-counted keyboard insets. Each has an explicit behavior/smoke above.

Implementation decision: **content-width, left-aligned pill**, inset with the editor text at desktop and bounded by the input width on mobile. Keep one layout, with no old-layout setting. The owner explicitly waived mockups and requested the interactive DS viewer before app wiring. This supersedes the research-only non-goals and full-width recommendation above.

Unverified/deferred: rendered layouts, real contrast samples, physical IME/mobile keyboard and latency measurements await implementation. No product code, screenshot/mockup, live app run or runtime mutation is delivered by this document.


## Implementation record — issue #473

Authority: the implementation request on `codex/composer-pill`, based on research
commit `3dc840e7a`, supersedes the research/mockup-only scope. The interactive DS
story was built and its five-state smoke passed **before app wiring**.

Decisions and shipped path:
- One neutral form, input TintedGlass + 8px gap + TintedGlass pill. Panels have
  their own slot above the input; empty slots take no space. Every app composer
  uses the existing Composer container, including new chat and project drafts.
- Desktop hugs content at the editor's 16px inline inset. At ≤520px container
  width the workspace, Plan and context move together into More. This simpler,
  deterministic grouping replaces the proposed three-step priority algorithm.
  Essential controls remain one row at 375; longer desktop groups may wrap.
  At 320 the model label is visually hidden while its accessible name remains.
- No legacy setting. No model/access/workspace defaults, approval actions,
  backend queue or stop semantics changed. Stop remains the existing cancel.
- The Lexical editor stays mounted across panel changes and collapse; active
  composition keeps it expanded. Panel submission and pill Send remain distinct.
- ResizeObserver alone changes overflow placement; open More stays mounted on
  widening. Narrowing closes an affected context popup and focuses More.
  Form controls retain their container-owned selected values across relocation.
- The shell's event-driven VisualViewport adapter accounts only for occlusion
  not already handled by viewport layout. Mobile preserves safe-area gutters;
  short viewports make the composer scroll with the pill sticky inside it.

Owner preview: build `packages/butler-app/client/ui/dist-ds-site`, entry
`index.html?page=blocks/ComposerCard&theme=light&locale=en`. Serve this directory
at any static-host subpath; all assets are relative and bundled, with no API or
external requests and no source maps. The Interactive composer story provides
idle, multiline, streaming/stop, question, attachments, 375px, light/dark, photo,
and reduced-motion switches, working selectors and attachment removal.

Measured evidence (isolated stub/static runs; no owner data): five states with
0px horizontal overflow, 8px gap, all five narrow targets ≥44px, 0 external
requests, preserved editor identity across theme/photo/motion changes, and
composition Enter guarded against Send. Composer refresh: 38 typed characters,
238 frames, height drift 0px, unchanged model/context renders 0, usage requests
0, one real work-status refresh, full submitted text verified. This is bounded
active-composer evidence, **not** the proposed owner-scale/three-window idle
campaign. Physical Korean IME candidate windows and mobile keyboard/safe-area
behavior remain for the owner's Monday walkthrough.

Validation details and any remaining harness/environment limits are reported
with the delivered branch. The shared git metadata is sandbox-denied in this
runner: research files were extracted verbatim before editing this record;
actual merge/commit/push must be completed by the coordinator if still denied.


Closeout snapshot:
- `bun run check`: pass (959 pass, 22 pre-existing skips in the verbose run);
  focused composer tests: 31 pass. The unchanged invalid-hook fixture found
  while exercising Stop is corrected without changing assertions, tracked in #479.
- DS lint, motion lint, CSS lint, typecheck, cargo fmt and source-check pass.
  No Rust crate changed, so touched-crate clippy does not apply.
- Caret (7 cases), question/decision panels (8 combinations each), DS question
  interactions (20 renders), conversation stories, DS navigation, app DS smoke,
  focused overflow (10 pages) and overlay motion trace pass. Six 375px DS renders
  were generated for secondary visual review.
- Full app layout smoke stopped at `tests/smoke/app-layout-smoke.ts:1232`
  (inspector closing animation: visible width remained 432px). Full mobile
  viewer smoke timed out at `tests/support/ds-viewer-mobile-checks.ts:171` while
  navigating the component gallery. These broad runs are not reported green;
  their baseline status was not established. No timeout or assertion was weakened.
- Static artifact: 272 files, 10,023,988 bytes (9.56 MiB), no source maps.
  Static leak/font checks pass; the subfolder interaction smoke observes no
  external or API requests.
- Git merge/fetch/stage/commit were denied at ORIG_HEAD/FETCH_HEAD/index.lock.
  No commit, push, PR, tag, or merge was produced. Base HEAD remains
  `10b68356da71fafdd3c5551ef7cb62d51ee35da3`; the runner must merge the research
  branch, commit this worktree and push `codex/composer-pill`.

- Refresh qualification limit: the seed-reply wait at
  `tests/smoke/app-composer-refresh-smoke.ts:56` also timed out in two runs.
  A diagnostic run (without changing that wait or the render assertions)
  completed with 239 frames and zero extra renders; it did not reproduce the
  seed timeout. The cause and baseline status remain unverified, so the overall
  refresh harness is not claimed consistently green. Failure diagnostics now
  retain only stub call counts and message roles/statuses, never draft text.
- Isolated Ledger closeout could not run because this worktree has no initialized
  Ledger; the owner's real Ledger was not accessed. Repository design updates
  remain review artifacts for the coordinator.

- Final revision: caret 7/7 and refresh passed (38 characters, 238 frames,
  0px height drift, 0 unchanged control renders, 0 usage requests). The earlier
  seed-reply timeouts remain recorded above; this pass does not establish their
  cause. Pending-panel folded editors are inert; an already focused/composing
  editor stays expanded. More is omitted when no secondary control applies.
