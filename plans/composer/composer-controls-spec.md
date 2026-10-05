# Composer controls: implementation spec (#473)

Status: design approved for implementation, 2026-10-05. Design: Opus (ui-designer). Implementation: Codex.
Proposal page: DS site `?proposal=composer-controls` (branch `design/composer-controls`,
`packages/butler-app/client/ui/ds-site/proposals/composer-controls/`). Recommended variant: **A · Split**.

## Outcome

- The composer card stays exactly as it ships today: same radius, padding, editor, toolbar row height,
  divider, send/stop size and position. Measured real app vs proposal (equal):

  | Measure | Desktop (pane 826px) | 375px |
  |---|---|---|
  | Card w × h | 738 × 94 | 351 × 103 |
  | Radius / border | 30 / 1px | 28 / 1px |
  | Editor padding, font, height | 12px 16px, 14/21, 45 | 12px 16px, 16/24, 48 |
  | Placeholder text offset (left, top) | 17, 15 | 17, 15 |
  | Toolbar height / padding / divider | 47 / 8px / 1px | 53 / 4px / 1px |
  | Send size, offset (right, bottom) | 30×30, 9, 9 | 44×44, 5, 5 |
  | Side gap | `--adaptive-composer-inset` 44 | 12 |

- The bottom control row (attach, access, workspace, Plan, context, model) moves out of the card into the
  space directly below it. Send/stop stays in the card, in today's position.
- The pill row is **always visible**: idle, empty, typing, streaming, question/plan/approval surfaces.
- **The composer never folds.** The fold (idle/engaged presentation) is deleted; the card is always
  expanded (owner decision 2026-10-05: with the controls outside the card the fold has no purpose).

## Remove the fold (product)

Delete, do not stub. Line numbers are at main `ec138feae`.

| File | Remove |
|---|---|
| `packages/butler-app/client/ui/src/components/conversation/hooks/useComposerPresentation.ts` | Whole file (engaged/protectedExpanded, outside-pointer collapse, focus/blur capture). |
| `.../conversation/Composer.tsx` | `:5` `useSpaceDrag` import and `:30` `referenceDragging` (only fed `protectedExpanded`); `:15` import; `:121-125` `presentation`; `:130` the `expanded={...}` prop (ComposerCard defaults to expanded); `:143-145` `onPointerDownCapture` / `onFocusCapture` / `onBlurCapture`. Keep `:142` `onPointerDown={handlers.focusDraftFromComposerChrome}`. |
| `.../conversation/ComposerCompactPreview.tsx` | Whole file. |
| `.../conversation/ComposerToolbar.tsx` | `:6` `ComposerCardExpandedControls` and `:17` `ComposerCompactPreview` imports; `:36` `<ComposerCompactPreview />`; the `ComposerCardExpandedControls` wrappers at `:37`/`:44` (those controls move to the row) and `:58`/`:64` (idle send renders bare). |
| `.../conversation/ComposerInputSurface.tsx` | `:4` `ComposerCardExpandedBody` import and the `:40`/`:48` wrapper: render `ComposerDecisionAttachment` / `ComposerPlanInstructionContext`, `ComposerTextArea`, `ComposerAttachments` directly (measured: card geometry unchanged). |
| `.../conversation/composerStore.ts` | `:37-38` `engaged`, `setEngaged`. |
| `.../conversation/composerStoreContract.ts` | `:36-37` `engaged`, `setEngaged`. |
| `.../conversation/useComposerPlanDecision.ts` | `:93` `setEngaged` selector and the `setEngaged(true)` call at `:130` (keep the `focusComposer` rAF). |
| `.../pages/VisualHarness.tsx` | `:227-233` the `ss03Surface` effect that calls `setEngaged(true)`. |
| `.../pages/VisualHarness.behavior.test.tsx` | `:25`, `:32`, `:69`, `:86` engaged setup/assertions. |

Smokes and tests asserting fold behaviour:

| File | Change |
|---|---|
| `tests/smoke/app-composer-caret-smoke.ts` | `:13` initial preview click → click the editor; `:17-23` `padding()` helper: drop the preview branch, click card chrome only. |
| `tests/smoke/app-composer-refresh-smoke.ts` | `:51`, `:57` preview clicks → editor click / nothing; `:30`/`:93` keep `expanded === "true"` (now always true) or drop the field. |
| `tests/smoke/app-onboarding-visual-smoke.ts` | `:52` preview click → editor click. |
| `tests/smoke/app-layout-smoke.ts` | `:162-165` "outside click folded the composer" re-expand; `:390-393` preview click; `:3369-3409` desktop idle/engaged assertion; `:3415-3482` compact idle → engaged → collapsed-draft morph assertion and its follow-up preview click. Replace with one assertion: after an outside click and blur the card height, radius and `data-expanded="true"` are unchanged and the pill row is visible, at 1280 and 390. |
| `tests/unit/app-responsive-design.test.ts` | `:188-260` "provides animated composer idle and engaged states at every width": delete; if a guard is wanted, assert `Composer.tsx` has no `useComposerPresentation` and `ComposerToolbar.tsx` no `ComposerCardExpandedControls` / `ComposerCompactPreview`. |

DS cleanup (frozen; owner approval, then in the same slice as the DS changes below). These become dead
once the product stops folding:

- `blocks/ComposerCard/ComposerCard.tsx`: `expanded` prop `:18`, `:32`, `data-expanded` `:50`,
  `ComposerExpandedContext` `:21`, `:59`; `ComposerCardExpandedBody` `:87-94`;
  `ComposerCardExpandedControls` `:96-98`; `ComposerCardCompactPreview` `:100-115`; their exports in
  `index.ts:3-5`.
- `blocks/ComposerCard/ComposerCard.module.css`: `.expandedBody` `:64-66`, `.compactPreview` `:139-156`,
  `.expandedControls` `:158-160`, folded rules `:219-234`.
- Consumers to migrate: `ComposerCard.showcase.tsx:10-14, 60-77, 95-102`, `ComposerCard.guidance.tsx:6, 13-15`,
  `ComposerCard.test.tsx:11`, FoundationHeroMotion heroes (`focus/Composer.tsx`, `layers/LayersPage.tsx:81-89`,
  `layout/LayoutShell.tsx:60-63`, `motion/CompactComposer.tsx`, `motion/DraftComposer.tsx`,
  `radius/Composer.tsx`, `typography/ProductBoard.tsx`), README `:9-11` "idle and engaged" paragraph.

## DS changes (owner approval required for each)

1. `blocks/ComposerCard/ComposerCard.tsx`: `controls?: ReactNode`, rendered after `</form>` inside `.wrap`
   (shares the `composer` container, floating position, `pointer-events: auto`, height reservation via
   `containerRef`). Floating bottom offset (34px desktop large, 18px + safe area on phones) applies to the
   pills' visible bottom edge; the card is lifted by the row (8px gap + pill height).
2. `blocks/ScrollArea`: x-axis flush option. Today the content is padded by the fade size (14px) so items
   rest inset; the option lets items rest flush with the parent's start/end edges and puts the fades just
   outside (the mock widens the frame by `2 × --scroll-fade-size`, centered). Also: no unfaded 10px
   scrollbar lane for this use, and vertical room for pill shadows/focus rings.
3. `components/PillButton`: an icon-only glass circle size. The glass floor is 32px but Button has no 32px
   icon size; pick one row height: `lg` (34px, used by the mock) with `icon-lg` circles, or add a 32px icon
   size. Touch: 44px everywhere.
4. `blocks/ComposerControl/ComposerControl.tsx:20,38` and `ComposerSelectControl`: typed `surface` (and
   `size`) forwarded to PillButton. `ComposerControl.module.css:93`: key the touch rule on its own
   attribute, not `data-slot` (Radix triggers overwrite it).
5. `blocks/ContextDonutButton/ContextDonutButton.tsx:7,21`: `surface="glass"` composing PillButton at the
   row's circle size; same 18px ring.

## Product changes

- `ComposerToolbar.tsx` splits in two:
  - Card toolbar (inside the card, unchanged geometry): `ComposerCardToolbarSpacer` + the existing
    send/stop branch (agent notice / reconnecting / stop / send with `disabledReason`), byte-identical.
  - `ComposerControlRow` (new, `components/conversation`), passed to `ComposerCard controls`:
    `ScrollArea orientation="x"` (flush) → `ButtonContainer size="sm" wrap={false} grow role="group"
    aria-label={appCopy.composer.controls}` with, in order: `ComposerAttachmentMenu`, `AccessModeMenu`,
    `ComposerWorkspaceSelect`, `ComposerPlanModeBadge`, `<Box grow aria-hidden />`, `ComposerContextControl`,
    `ModelMenu`.
- `Composer.tsx`: pass `controls={<ComposerControlRow />}`; it is mounted outside `ComposerInputSurface`'s
  early returns, so the row stays during question, plan and approval surfaces.
- Triggers (bodies, menus, handlers, copy keys unchanged):
  - `ComposerAttachmentMenu`: `IconButton` → `PillButton surface="glass"` icon-only circle, `aria-label` +
    `title` = `featureDrawer`.
  - `AccessModeMenu`, `ModelMenu`, `ComposerModelStatusButton`: `ComposerControl surface="glass"`.
  - `ComposerWorkspaceSelect`: `ComposerSelectControl surface="glass"`.
  - `ComposerPlanModeBadge`: `Tag` → `PillButton surface="glass"` (icon `ListChecks` xs, label + `X` xs);
    click turns Plan off; `aria-label` = `${plan} ${cancel}`.
  - `ComposerContextControl`: `ContextDonutButton surface="glass"`.
- i18n (`packages/butler-i18n`): new `composer.controls` — en "Composer controls", ko "입력 옵션".
- Migrate every `ComposerCard` consumer (`QuickFixesHarness.tsx:74`, dashboard composer, showcases).

## Layout and tokens

- Row width = card width. At rest the first pill's start edge = card start edge and the last pill's end
  edge = card end edge (variant A; the spacer takes the free space).
- Pill gap `--space-sm` (`ButtonContainer size="sm"`). Card → pill visual gap 8px (`--space-xs` stack gap +
  `--space-xs` row padding).
- Pill height: desktop `--control-height-lg` (34px) or the new 32px icon size (DS decision 3); touch
  `--control-hit-target` (44px). `+` and context are circles of the same size (measured 34×34 / 44×44).
- Fades: `--scroll-fade-size` (14px), outside the card edges, only on an edge while content is clipped there.
- Card: unchanged values (table above). Width `calc(pane - 2 × --adaptive-composer-inset)`, capped at
  `--conversation-content-width`.

## 375px

- Card 351px (12px gutters), unchanged. The row is one line, never wraps; it scrolls horizontally.
- At rest: first pill flush left; overflow on the right fades just beyond the card edge. Scrolled to the
  end: last pill flush right. Measured fades: start 0/14, middle 14/14, end 14/0.
- Access shows its icon only (`compact="icon"`), model detail hidden: both need the row inside
  `ComposerCard`'s `.wrap` (`@container composer (width <= 520px)`).
- The row never widens the page (no horizontal page scroll).

## States to cover (smokes, real composer, stub provider)

- Idle empty (send disabled), multi-line typing (send enabled), streaming (stop), reconnecting / agent
  restarting (busy send), blocked image (send `aria-disabled` + tooltip).
- Plan on/off, attachment present, workspace pill only in Git projects, model loading / unavailable / error.
- Question panel open and collapsed, plan decision, approval decision: card content changes, row stays.
- Outside click / blur: card geometry and the row unchanged (no fold).
- All five menus open from the row; Esc closes and returns focus to the opener; Tab order: editor,
  attachment removes, row controls in order, send/stop.
- Light/dark over photo (clouds, daisies) and scene (bloom) wallpapers; text never on the wallpaper
  without a surface.
- Widths 320, 375, 390, 430, 768, 1280 (with and without sidebar).
