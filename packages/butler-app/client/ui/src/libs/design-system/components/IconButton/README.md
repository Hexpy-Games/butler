# Icon Button

## What is this component
Icon Button is a Butler design-system component for building consistent client UI without reaching into domain components or raw implementation details.

## When to use this component
Use Icon Button when the interface needs the behavior implied by its name and when a shared Butler token, spacing, interaction, or accessibility contract should stay consistent across the app.

## Where to use this component
Use it in app-client domain components, routes, visual harnesses, and feature surfaces through `@/butler-ds`. Keep direct imports from this component directory inside the design-system package only.

## Why to use this component
It centralizes the visual contract, responsive behavior, and accessibility defaults so agents can build new UI without inventing parallel styles.

## How to use this component
Import from the public design-system alias:

```tsx
import { IconButton } from "@/butler-ds";
```

Prefer token-backed spacing and responsive composition. Check its showcase and usage guidance in the DS Viewer before using it in a domain flow.

## Who can use this component
Product engineers, design-system maintainers, and coding agents can use it when building Butler client UI. Design-system maintainers own changes to its API and visual contract.

## Best practice
- A container may set `--icon-button-surface` to a token-backed background shorthand
  (for example a centered radial gradient). This changes hover/selected paint only;
  the button hit target, focus ring and accessible name remain unchanged.
- Compose it with other `@/butler-ds` components before adding bespoke CSS.
- Keep layout fluid; do not assume a fixed desktop width.
- Check at iPhone-width mobile, tablet-ish, and desktop viewports.
- Keep domain data, app state, and business decisions outside this component.

## Wrong use cases
- Do not use Icon Button as a domain-specific component with embedded feature logic; create a domain component under `src/components` and compose this component instead.
- Do not import from `@/butler-ds/shadcn/ui` in app code; import from `@/butler-ds` so the public API remains stable.
- Do not lock dimensions to pixel-perfect desktop-only widths. Use responsive containers, intrinsic sizing, and tokens.

## Tone, indicator, badge and pressed
- `tone`: `default`, `butler` (the icon in `--butler-ink-blue`) or `riso` (the
  icon stroked with the riso ink gradient). Colour only: a tone never paints a
  fill. The focus ring is the same in every tone.
- `indicator`: a riso dot at the top-end corner (Butler is acting on what the
  button shows, e.g. browsing while the pane is closed).
- `badge`: a count at the top-end corner (hidden at 0, `99+` above 99). Put
  the count in `label` as well.
- `pressed`: sets `aria-pressed` for toggles. Alone it paints no fill.
- `pane`: the pane a title-bar toggle opens. While `pressed`, the button fills
  with that pane's own surface, made opaque (`rgb(from <token> r g b / 1)`),
  so the toggle reads as joined to the pane it opened:

  | `pane` | Pane | Surface token |
  | --- | --- | --- |
  | `aside` | 세션 정보 (ConversationShell aside) | `--tinted-glass-tint`, the floating glass's solid body; the docked aside sits on the chat card of nearly the same tone |
  | `browser` | BrowserPane | `--browser-pane-bg` (the cards frame's override applies) |
  | `viewer` | A card pane in the split, such as the file viewer | `--shell-card-bg` (AdaptiveShellCard) |

  The token resolves where the button sits, so the shell's overrides apply.
  Hover lays `--selection` over the fill; the indicator's ring takes the fill.
  Product code only declares the pane:
  `<IconButton pane="browser" pressed={open} tone={open ? "butler" : "default"} …>`.
  A toggle that opens a dialog or a menu (the task graph, ⋯) declares no pane.

## Tags
action, icon-only, tooltip
