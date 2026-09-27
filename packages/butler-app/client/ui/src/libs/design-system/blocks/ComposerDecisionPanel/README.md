# ComposerDecisionPanel

## What is this component
The composer's decision state. A subject row (decision icon in the secondary
tone, the title as a two-line clickable label that opens the source, an
optional `aside`), an optional `error` announced as an alert, and the
`actions` row aligned to the end. Buttons in the actions row take
`--adaptive-composer-radius` so they echo the composer shape.

## When to use this component
Use it when a pending decision replaces the composer input: a plan waiting
for acceptance, or an authority (permission) request.

## Where to use this component
Inside the composer (`ComposerPlanDecisionSurface`,
`ComposerAuthorityDecisionSurface`).

## Why to use this component
Both decisions share one layout; the padding, icon tone and button radius
live in the DS instead of a product CSS module.

## How to use this component
```tsx
<ComposerDecisionPanel icon={<ListChecks aria-hidden="true" size="lg" />} title={plan.title} onOpen={openPlan}
  actions={<ButtonContainer size="sm" justify="end">…</ButtonContainer>} />
```
Pass `data-test-class` for smokes; `aside` for a pending count or a
compose-later button; `error` after a failed decision.

## Who can use this component
Composer containers that own the decision state and actions.

## Best practice
Keep domain actions (accept, deny, allow scope) in the product container;
pass them as `actions`.

## Wrong use cases
Do not use it for conversation notices; use `Notice`. Do not use it for modal
confirmations; use `Dialog`.

## Tags
composer, decision, approval, plan, authority
