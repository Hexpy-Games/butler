# Switch

## What is this component
Switch is a Butler design-system component for building consistent client UI without reaching into domain components or raw implementation details.

## When to use this component
Use Switch when the interface needs the behavior implied by its name and when a shared Butler token, spacing, interaction, or accessibility contract should stay consistent across the app.

## Where to use this component
Use it in app-client domain components, routes, visual harnesses, and feature surfaces through `@/butler-ds`. Keep direct imports from this component directory inside the design-system package only.

## Why to use this component
It centralizes the visual contract, responsive behavior, and accessibility defaults so agents can build new UI without inventing parallel styles.

## How to use this component
Import from the public design-system alias:

```tsx
import { Switch } from "@/butler-ds";
```

Prefer token-backed spacing and responsive composition. Check its showcase and usage guidance in the DS Viewer before using it in a domain flow.

### Placement

- **Stacked (the default).** Like an input: the label, its description,
  then the switch underneath, left-aligned. Every desktop settings field and
  form: `SettingsField` in settings, a vertical `Field` elsewhere.
- **Row (the exception).** `Field orientation="horizontal"` with
  `FieldContent` first: the label and the switch on one row, the switch at the
  row end, the description under the label. Only on a phone layout, or for a
  list item inside a closed container (a card, a list row) where the width has
  to be used.
- Never put a switch before its label. A trailing toggle that is a list row's
  own action (a `CardListItem` `actions` slot) stays at the row end.

`bun run lint:ds` (`switch-field-layout`) flags a `Switch` beside a label in a
`Stack` or `Inline` row in product code; the row layout goes through
`Field orientation="horizontal"`.

### Usage

- An immediate on/off setting that applies as soon as it is flipped, with no
  save step.
- Selections, or choices confirmed with a submit button: a checkbox
  (`CheckCard`).
- More than two states: `SegmentedControl`.
- A disabled switch carries its reason in a tooltip (`disabledReason`).

### Unavailable with a reason

Pass `disabledReason` (a few words, localized) when the setting cannot be
changed right now and the user should learn why:

```tsx
<Switch id="reduce-motion" checked={system} disabledReason={copy.followsSystem} onCheckedChange={save} />
```

The switch looks disabled but stays focusable and hoverable
(`aria-disabled="true"`, not `disabled`), ignores clicks and Space/Enter,
and shows the reason in a `Tooltip` on hover and keyboard focus. It wins
over `disabled`. Use plain `disabled` only when no reason is worth showing.

The reason opens to the **right** of the switch by default
(`disabledReasonSide="right"`, `disabledReasonAlign="center"`). A switch sits
under its label and description (stacked), or at the row end (row layout),
so its right side is the one place the tooltip covers neither. Without room
there it flips (see Tooltip "Placement"). Pass another side only when the
layout puts something the reader needs to the right of the switch:

```tsx
<Switch aria-label={copy.sync} disabledReason={copy.offline} disabledReasonSide="top" disabledReasonAlign="start" />
```

On touch screens a tap does not open the tooltip yet.

## Who can use this component
Product engineers, design-system maintainers, and coding agents can use it when building Butler client UI. Design-system maintainers own changes to its API and visual contract.

## Best practice
- Compose it with other `@/butler-ds` components before adding bespoke CSS.
- Keep layout fluid; do not assume a fixed desktop width.
- Check at iPhone-width mobile, tablet-ish, and desktop viewports.
- Keep domain data, app state, and business decisions outside this component.

## Wrong use cases
- Do not use Switch as a domain-specific component with embedded feature logic; create a domain component under `src/components` and compose this component instead.
- Do not import from `@/butler-ds/shadcn/ui` in app code; import from `@/butler-ds` so the public API remains stable.
- Do not lock dimensions to pixel-perfect desktop-only widths. Use responsive containers, intrinsic sizing, and tokens.

## Tags
form, toggle, settings
