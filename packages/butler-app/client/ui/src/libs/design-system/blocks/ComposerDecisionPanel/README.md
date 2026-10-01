# ComposerDecisionPanel

## What is this component
The composer's decision state. A subject row (decision icon in the secondary
tone, eyebrow and a fully wrapping clickable title that opens the source, an
optional `aside`), optional `details` under the title, an optional `error`
announced as an alert, and the `actions` row aligned to the end. Buttons in
the actions row take `--adaptive-composer-radius` so they echo the composer
shape.

## Props

| Prop | Values |
| --- | --- |
| `icon` | Decision-kind icon, sized to `sm` by the shared header, drawn in the secondary tone |
| `eyebrow` | Localized decision category (Plan / Permission) |
| `title` | What is being decided; wraps in full, opens the source |
| `onOpen` | Opens the plan or the request's source |
| `details` | Lines under the title (examples, a "+N more" line) in the secondary caption style, aligned to the title text. Every line wraps in full: what is being decided is never cut |
| `detailsShowMoreLabel`, `detailsShowLessLabel` | With both, details longer than four lines clamp behind an inline Show more / Show less button (the QueuedMessage pattern); without them details always show in full |
| `aside` | Trailing subject-row content: a status `Tag`, a pending count, non-interactive metadata |
| `error` | A failed decision, announced with `role="alert"` |
| `actions` | Decision buttons, or `(complete) => buttons` to run a decision after the shared exit motion |

## When to use this component
Use it when a pending decision replaces the composer input: a plan waiting
for acceptance, or an authority (permission) request.

## Where to use this component
Inside the composer (`ComposerPlanDecisionSurface`,
`ComposerAuthorityDecisionSurface`).

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
Pass `data-test-class` for smokes; `details` (with the Show more/less labels) for up to three examples and a
"+N more" line; `aside` for a status Tag, a pending count; `error` after a failed decision.

## Who can use this component
Composer containers that own the decision state and actions.

## Best practice
Keep domain actions (accept, deny, allow scope) and the wording in the product
container; pass them as `title`, `details` and `actions`. Show risk with a
`Tag` tone (`neutral`, `warning`, `danger`), not a new color.

## Wrong use cases
Do not use it for conversation notices; use `Notice`. Do not use it for modal
confirmations; use `Dialog`. Do not pack examples into the title; use
`details`.

## Tags
composer, decision, approval, plan, authority, risk

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
