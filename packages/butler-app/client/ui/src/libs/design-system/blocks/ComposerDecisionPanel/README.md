# ComposerDecisionPanel

## What is this component
The composer's decision state. A subject row (decision icon in the secondary
tone, the title as a two-line clickable label that opens the source, an
optional `aside`), optional `details` under the title, an optional `error`
announced as an alert, and the `actions` row aligned to the end. Buttons in
the actions row take `--adaptive-composer-radius` so they echo the composer
shape.

## Props

| Prop | Values |
| --- | --- |
| `icon` | Decision-kind icon at `size="lg"`, drawn in the secondary tone |
| `title` | What is being decided; two lines at most, opens the source |
| `onOpen` | Opens the plan or the request's source |
| `details` | Short lines under the title (examples, a "+N more" line), each one truncated line in the secondary caption style, aligned to the title text |
| `aside` | Trailing subject-row content: a status `Tag`, a pending count, a compose-later button |
| `error` | A failed decision, announced with `role="alert"` |
| `actions` | The decision buttons, usually a `ButtonContainer justify="end"` |

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

<ComposerDecisionPanel icon={<Folder aria-hidden="true" size="lg" />} title="Edit 24 files in your Desktop folder?"
  onOpen={openSource} details={["a.png", "b.png", "c.png", "+21 more"]}
  aside={<Tag tone="warning">Medium risk</Tag>}
  actions={<ButtonContainer size="sm" justify="end">…</ButtonContainer>} />
```
Pass `data-test-class` for smokes; `details` for up to three examples and a
"+N more" line; `aside` for a status Tag, a pending count or a compose-later
button; `error` after a failed decision.

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
