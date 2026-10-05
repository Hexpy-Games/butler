# Composer controls: implementation spec (#473)

Status: design approved for implementation, 2026-10-05. Design: Opus (ui-designer). Implementation: Codex.
Proposal page: DS site `?proposal=composer-controls` (branch `design/composer-controls`,
`packages/butler-app/client/ui/ds-site/proposals/composer-controls/`). Recommended variant: **A · Split**.

## Outcome

- The card keeps the product's exact radius, border, text inset, font and send/stop size. The in-card
  toolbar row is **removed entirely** (no empty row, no divider). Empty, the card is **one line**: the
  editor line with send/stop inline at the end of that line. The card grows as text wraps; send stays
  bottom-right, centered on the last text line. The question panel (and adjunct) render above the editor
  and attachments below it, inside the card, in today's order.
- Measured, real app (today) vs proposal:

  | Measure | Desktop real | Desktop proposal | 375 real | 375 proposal |
  |---|---|---|---|---|
  | Card width | 738 (pane 826) | 738 (pane 826) | 351 | 351 |
  | Card height, empty | 94 (editor + toolbar row) | **47** = 45 editor line + 2 border | 103 | **50** = 48 + 2 |
  | Card height, 3 lines | 136 | 89 | 151 | 98 |
  | Radius / border | 30 / 1px | 30 / 1px | 28 / 1px | 28 / 1px |
  | Editor padding, font, one-line height | 12px 16px, 14/21, 45 | same | 12px 16px, 16/24, 48 | same |
  | Placeholder / first-line text offset (left, top) | 17, 15 | 17, 15 | 17, 15 | 17, 15 |
  | Send size | 30×30 | 30×30 | 44×44 | 44×44 |
  | Send end offset | 9 | 9 | 5 | 5 |
  | Send vs last text line (center Δ) | n/a (toolbar) | −0.5px | n/a | −0.5px |
  | Side gap | inset 44 | 44 | 12 | 12 |

  (The real 3-line heights are the editor plus today's 47 / 53 px toolbar row.)
- The controls (attach, access, workspace, Plan, context, model) move out of the card into the space
  directly below it. Send/stop stays in the card.
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
| `.../conversation/ComposerToolbar.tsx` | `:6` `ComposerCardExpandedControls` and `:17` `ComposerCompactPreview` imports; `:36` `<ComposerCompactPreview />`; the `ComposerCardExpandedControls` wrappers at `:37`/`:44` (those controls move to the row) and `:58`/`:64` (idle send renders bare). The in-card `ComposerCardToolbar` row itself goes too (see Product changes). |
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

0. `blocks/ComposerCard`: **`ComposerCardInlineAction`** (new, exported). Layout: one row
   `[editor column (grow, min-width 0) | action]`, cross-axis end. The action slot is exactly one editor
   line tall (`1.5em + 2 × --composer-inner-padding-block`, i.e. 45px desktop / 48px compact) with the
   button centered in it, so send/stop centers on the last text line at every height; its end inset is
   today's toolbar inset (`--space-2` / `--space-xs` in `@container composer (width <= 520px)`), giving
   the product's send end offset (9px / 5px with the border). The empty card is then one line
   (border + one editor line: 47px / 50px). The editor keeps its padding and placeholder position. Owns the
   `ComposerSendButton` slot only; attachments render after it, the question panel / adjunct before it.
   `ComposerCardToolbar` / `ComposerCardToolbarSpacer` are no longer used by the product (keep for
   showcases or delete in the cleanup).
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

- The in-card toolbar row is removed. `ComposerToolbar.tsx` becomes two pieces:
  - `ComposerSendAction`: the existing send/stop branch (agent notice / reconnecting / stop / send with
    `disabledReason`), byte-identical, rendered as the action of `ComposerCardInlineAction`.
  - `ComposerControlRow` (new, `components/conversation`), passed to `ComposerCard controls`:
    `ScrollArea orientation="x"` (flush) → `ButtonContainer size="sm" wrap={false} grow role="group"
    aria-label={appCopy.composer.controls}` with, in order: `ComposerAttachmentMenu`, `AccessModeMenu`,
    `ComposerWorkspaceSelect`, `ComposerPlanModeBadge`, `<Box grow aria-hidden />`, `ComposerContextControl`,
    `ModelMenu`.
- `ComposerInputSurface.tsx`: `<ComposerCardInlineAction action={<ComposerSendAction />}>` around the
  editor (`ComposerDecisionAttachment` / `ComposerPlanInstructionContext` + `ComposerTextArea`), then
  `ComposerAttachments`, then `ComposerFileInput`; the question panel stays first. Decision surfaces
  (authority / plan) keep their own actions.
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

- Row width = card width minus `2 × --composer-controls-inset`. At rest the first pill's start edge = card
  start edge + inset and the last pill's end edge = card end edge − inset (variant A; the spacer takes the
  free space).
- **`--composer-controls-inset`** (new DS token): the row's symmetric horizontal inset from the card edges.
  The review page has a slider "컨트롤 좌우 여백" (0–32px, step 2, default 0, URL `inset=`); **the owner
  picks the final value**, which becomes this token. The ScrollArea flush option must keep the resting
  alignment at any inset (fades stay just outside the inset edges).
- Pill gap `--space-sm` (`ButtonContainer size="sm"`). Card → pill visual gap 8px (`--space-xs` stack gap +
  `--space-xs` row padding).
- Pill height: desktop `--control-height-lg` (34px) or the new 32px icon size (DS decision 3); touch
  `--control-hit-target` (44px). `+` and context are circles of the same size (measured 34×34 / 44×44).
- Fades: `--scroll-fade-size` (14px), outside the card edges, only on an edge while content is clipped there.
- Card: product radius, border, text inset, font and send size (table above); no toolbar row. Width `calc(pane - 2 × --adaptive-composer-inset)`, capped at
  `--conversation-content-width`.

## 375px

- Card 351px (12px gutters); empty 50px tall (one 48px editor line + border), send 44×44 inline, end
  offset 5px. The row is one line, never wraps; it scrolls horizontally.
- At rest: first pill flush left; overflow on the right fades just beyond the card edge. Scrolled to the
  end: last pill flush right. Measured fades: start 0/14, middle 14/14, end 14/0.
- Access shows its icon only (`compact="icon"`), model detail hidden: both need the row inside
  `ComposerCard`'s `.wrap` (`@container composer (width <= 520px)`).
- The row never widens the page (no horizontal page scroll).

## States to cover (smokes, real composer, stub provider)

- Idle empty: card is one line (47px desktop / 50px compact), send inline (disabled); typing grows the
  card line by line with send on the last line; 8+ lines scroll inside the editor with send fixed at the
  bottom.
- Idle empty (send disabled), multi-line typing (send enabled), streaming (stop), reconnecting / agent
  restarting (busy send), blocked image (send `aria-disabled` + tooltip).
- Plan on/off, attachment present, workspace pill only in Git projects, model loading / unavailable / error.
- Question panel open and collapsed, plan decision, approval decision: card content changes, row stays.
- Outside click / blur: card geometry and the row unchanged (no fold).
- All five menus open from the row; Esc closes and returns focus to the opener; Tab order: question panel,
  editor, send/stop, attachment removes, row controls in order.
- Light/dark over photo (clouds, daisies) and scene (bloom) wallpapers; text never on the wallpaper
  without a surface.
- Widths 320, 375, 390, 430, 768, 1280 (with and without sidebar).
