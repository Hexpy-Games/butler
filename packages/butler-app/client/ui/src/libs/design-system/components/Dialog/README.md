# Dialog

## What is this component
Dialog is a Butler design-system component for building consistent client UI without reaching into domain components or raw implementation details.

## When to use this component
Use Dialog when the interface needs the behavior implied by its name and when a shared Butler token, spacing, interaction, or accessibility contract should stay consistent across the app.

## Where to use this component
Use it in app-client domain components, routes, visual harnesses, and feature surfaces through `@/butler-ds`. Keep direct imports from this component directory inside the design-system package only.

## Why to use this component
It centralizes the visual contract, responsive behavior, and accessibility defaults so agents can build new UI without inventing parallel styles.

## How to use this component
Import from the public design-system alias:

```tsx
import { Dialog } from "@/butler-ds";
```

Prefer token-backed spacing and responsive composition. Check its showcase and usage guidance in the DS Viewer before using it in a domain flow.

## Who can use this component
Product engineers, design-system maintainers, and coding agents can use it when building Butler client UI. Design-system maintainers own changes to its API and visual contract.

## Best practice
- All modals use Composer-radius TintedGlass by default, including confirmation
  alerts and command dialogs. Popovers retain their separate surface contract.
- Placement belongs to DialogContent: centered in the viewport at every width,
  with safe-area bounds. Do not add mobile sheet offsets or per-dialog transforms.
- Size with props, never styles: `size` (`sm` default 380px, `md`, `lg`, `xl`
  880px, `full`; `--dialog-width-*`), `layout="scroll-body"` (header, one
  `ScrollArea fill` body, `DialogFooter`; the dialog does not scroll),
  `maxHeight="3/5"` and `height="full"`. `DialogTitle visuallyHidden` replaces
  an `sr-only` class.
- A dialog is as tall as its content up to its cap (`--dialog-max-height`: the
  viewport inside the safe area, 60% with `maxHeight="3/5"`, or the container).
  `height="full"` makes the cap its height, so a `scroll-body` whose body is
  short or empty (an empty task graph) fills it instead of collapsing to a strip.
  Without it nothing changes.
- A dialog that is only a header and its actions (a confirmation) is never
  shorter than a confirmation with one line of description: a title-only header
  keeps the height of a title, `--space-2` and one `--typo-body-line-height`
  line, with the title centred in it. A header with a description already fills
  it and renders unchanged. Do not add spacers or padding to make a short
  confirm taller.
- Use ScrollArea for independently scrolling bodies. Do not mask the entire
  modal surface, which would also fade its border, header and shadow.
- A dialog reserves no scrollbar gutter. When one that scrolls itself
  overflows, a classic scrollbar takes its width out of the inline-end padding
  and the content gives it back, so the form keeps its width and centre when
  content starts or stops scrolling, and a dialog that fits shows no empty
  lane. Overlay scrollbars change nothing.
- Compose it with other `@/butler-ds` components before adding bespoke CSS.
- Keep layout fluid; do not assume a fixed desktop width.
- Check at iPhone-width mobile, tablet-ish, and desktop viewports.
- Keep domain data, app state, and business decisions outside this component.

## Wrong use cases
- Do not use Dialog as a domain-specific component with embedded feature logic; create a domain component under `src/components` and compose this component instead.
- Do not import from `@/butler-ds/shadcn/ui` in app code; import from `@/butler-ds` so the public API remains stable.
- Do not lock dimensions to pixel-perfect desktop-only widths. Use responsive containers, intrinsic sizing, and tokens.

## Anchored in a container
`DialogContent container={element}` anchors the dialog inside that element
(a PageCard's `contentRef`): it sits near the container's top and the scrim
covers only the container. Use it with `<Dialog modal={false}>` so the rest
of the window stays usable; outside clicks do not dismiss it.

## Tags
overlay, confirmation, focused-task
