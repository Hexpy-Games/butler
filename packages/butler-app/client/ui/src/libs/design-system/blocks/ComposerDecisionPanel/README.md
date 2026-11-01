# ComposerDecisionPanel

## What is this component
The composer's decision state. A subject row (decision icon in the secondary
tone, eyebrow and a fully wrapping clickable title that opens the source, an
optional `aside`), optional `details` under the title, an optional `error`
announced as an alert, and the `actions` row aligned to the end. Buttons in
the actions row take `--adaptive-composer-radius` so they echo the composer
shape.

`placement="conversation"` shows the same panel in the transcript, where
Butler asked: inside a flat bordered `Card radius="lg"` (12px, no shadow, no
TintedGlass), with a 12px content inset and control-radius (8px) buttons.
The header row stays icon, small label and title. The default
`placement="composer"` is unchanged.

## Props

| Prop | Values |
| --- | --- |
| `icon` | Decision-kind icon, sized to `sm` by the shared header, drawn in the secondary tone |
| `eyebrow` | Localized decision category (Plan / Permission) |
| `title` | What is being decided; wraps in full, opens the source |
| `renderText` | Optional display formatter `(text, as)` for title and details; `as` is `"code"` for a `{ code }` detail. Original strings remain available in titles and accessible labels |
| `literal` | The title and details are the exact action (commands, paths, URLs): Typo `literal` draws their own characters, so `2876x6` never shows as `2876×6` and `->` never as an arrow. Approval requests set it |
| `onOpen` | Opens the plan or the request's source |
| `details` | Lines under the title (examples, a "+N more" line) in the secondary caption style, aligned to the title text. Every line wraps in full: what is being decided is never cut. A `{ code }` item is a command body in a code frame (the markdown code frame look: hairline border, panel radius, raised surface, code font): its own spaces, indentation and line breaks; a long line scrolls sideways under the edge fade instead of wrapping. The frame is never taller than the part of the details scroll area its fades leave clear (a taller script scrolls inside it), so keyboard focus always shows its whole inset ring |
| `detailsShowMoreLabel`, `detailsShowLessLabel` | With both, details longer than four lines clamp behind an inline Show more / Show less button (the QueuedMessage pattern); without them details always show in full. Overflow is measured against the clamped block's real height, so several detail lines (a short line followed by a long reviewed input) still get the button when a later line is hidden |
| `aside` | Trailing subject-row content: a status `Tag`, a pending count, non-interactive metadata |
| `error` | A failed decision, announced with `role="alert"` |
| `actions` | Decision buttons, or `(complete) => buttons` to run a decision after the shared exit motion |
| `placement` | `composer` (default): in place of the composer input, inside ComposerCard. `conversation`: in the transcript, inside its own flat `Card radius="lg"` with a 12px inset and control-radius buttons; the media keeps its narrow layout under 420px |
| `media` | `{ content, label, onOpen? }`: a 16:10 page thumbnail (a `LiveTabFrame` of the tab the decision acts on) beside the title and details, top-aligned at the row's end, 144px wide, 112px in a composer under 600px. In a composer under 420px it sits under the details in the text column (the title's inset), as wide as that column, 12px under the text, and shows the top of the page: 16:10 up to `--decision-media-narrow-height` (140px), then cropped from the top (never letterboxed or stretched). `onOpen` opens the tab; without it (no in-app browser) the thumbnail is a plain image with no open affordance. `label` names the target |

## When to use this component
Use it when a pending decision replaces the composer input: a plan waiting
for acceptance, or an authority (permission) request.

## Where to use this component
Inside the composer (`ComposerPlanDecisionSurface`,
`ComposerAuthorityDecisionSurface`), or in the conversation where the
decision was asked (`placement="conversation"`, without a ComposerCard).

## Why to use this component
Both decisions share one layout; the padding, icon tone, detail indent and
button radius live in the DS instead of a product CSS module.

## How to use this component
```tsx
<ComposerDecisionPanel icon={<ListChecks aria-hidden="true" size="lg" />} title={plan.title} onOpen={openPlan}
  actions={<ButtonContainer size="sm" justify="end">…</ButtonContainer>} />

<ComposerDecisionPanel icon={<Folder aria-hidden="true" size="lg" />} title="Edit 24 files in 'Desktop'?"
  onOpen={openSource} details={["a.png", "b.png", "c.png", "+21 more"]}
  aside={<Tag tone="warning">Medium risk</Tag>}
  actions={<ButtonContainer size="sm" justify="end">…</ButtonContainer>} />
```
Browser approvals and hand-offs pass the tab's frame as `media`. The page is
static while the decision waits, so it costs no frames. Pass a masked still
when the tab is vault-filled:

```tsx
<ComposerDecisionPanel icon={<Lock aria-hidden="true" size="lg" />} eyebrow={handoff.eyebrow} title={handoff.title}
  onOpen={openSource} details={[detail, handoff.inTab]}
  media={{ content: <LiveTabFrame frame={frame} favicon={tab.favicon} />, label: tab.title, onOpen: () => openHandoffTab(tab.id) }}
  actions={<ButtonContainer size="sm" justify="end">…</ButtonContainer>} />
```

A command body (a script, a multi-line command) goes in as `{ code }`, so its
indentation and line breaks stay as written:

```tsx
<ComposerDecisionPanel icon={<Terminal aria-hidden="true" size="lg" />} title="Run a command in 'garden'?" onOpen={openSource}
  details={[{ code: command }, "garden"]} literal renderText={(text, as) => as === "code" ? escapeDeceptive(text) : escapeLine(text)}
  actions={<ButtonContainer size="sm" justify="end">…</ButtonContainer>} />
```

Approval cards that show a complete reviewed input (a memory text, a schedule's
prompt, a browser step's fields, an MCP call's arguments) pass the input as a
later detail line with both Show more/less labels: the first lines stay
visible and the full input is one click away.

Pass `data-test-class` for smokes; `details` (with the Show more/less labels) for up to three examples and a
"+N more" line; `aside` for a status Tag, a pending count; `error` after a failed decision.

## Who can use this component
Composer containers that own the decision state and actions.

## Best practice
Keep domain actions (accept, deny, allow scope) and the wording in the product
container; pass them as `title`, `details` and `actions`. Show risk with a
`Tag` tone (`neutral`, `warning`, `danger`), not a new color.

## Wrong use cases
Do not use it for conversation notices; use `Notice`. Do not wrap the
conversation placement in another Card or ComposerCard; it brings its own. Do not use it for modal
confirmations; use `Dialog`. Do not pack examples into the title; use
`details`.

## Tags
composer, decision, approval, plan, authority, risk, media, thumbnail, browser, command, code

## Shared composition and keyboard
The private `composerPanel` frame, header, scroll body and footer are shared
with ComposerQuestionPanel. The enclosing ComposerCard supplies the surface;
both panels share its radius, first-line icon alignment, insets, inset focus
rings and end-aligned divided footer. ScrollArea fades only overflowing edges
and follows scroll position. `useComposerPanelTransition` owns tokenized enter
and exit motion, including reduced motion. Call `complete(action)` only for
explicit decision actions; source/instruction navigation stays immediate.

Number keys focus the corresponding available action (excluding scope-menu
triggers); Enter executes the focused action, or the primary action from the
frame. Escape keeps approvals visible and never approves or denies. No Skip
or Later control belongs on an approval. Denial reasons require an existing
API reason field; the current denial API has none.
