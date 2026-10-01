# Icons

## Source and license
The icons come from the [Hugeicons free set](https://hugeicons.com), using
`@hugeicons/core-free-icons` 4.1.4 and `@hugeicons/react` 1.1.6. Both packages
are licensed under MIT.

## What is this component
Icons is a Butler design-system component for building consistent client UI without reaching into domain components or raw implementation details.

## When to use this component
Use Icons when the interface needs the behavior implied by its name and when a shared Butler token, spacing, interaction, or accessibility contract should stay consistent across the app.

## Where to use this component
Use it in app-client domain components, routes, visual harnesses, and feature surfaces through `@/butler-ds`. Keep direct imports from this component directory inside the design-system package only.

## Why to use this component
It centralizes the visual contract, responsive behavior, and accessibility defaults so agents can build new UI without inventing parallel styles.

## How to use this component
Import from the public design-system alias:

```tsx
import { Icons } from "@/butler-ds";
```

Size icons with the named scale, which mirrors `--icon-size-sm|md|lg` in
`tokens.css` and is exported as `ICON_SIZE`:

| Size | px | Use |
| --- | --- | --- |
| `xs` | 12 | Micro badges and chips (plan-mode badge, branch chip) |
| `sm` | 14 | Dense rows, inline badges, small buttons |
| `md` | 16 | Default for controls, menus, nav rows and toolbars |
| `lg` | 20 | Status marks, back arrows, prominent headers |
| `xl` | 24 | Resource tiles and summary illustrations |
| `2xl` | 32 | Empty-state illustrations |

```tsx
<Plus />            // md (16px) by default
<Search size="lg" />
```

Do not pass literal 11-32px sizes; pick the nearest named size. Numeric sizes
are reserved for artwork outside the icon scale.

Prefer token-backed spacing and responsive composition. Check its showcase and usage guidance in the DS Viewer before using it in a domain flow.

## Who can use this component
Product engineers, design-system maintainers, and coding agents can use it when building Butler client UI. Design-system maintainers own changes to its API and visual contract.

## Best practice
- Compose it with other `@/butler-ds` components before adding bespoke CSS.
- Keep layout fluid; do not assume a fixed desktop width.
- Check at iPhone-width mobile, tablet-ish, and desktop viewports.
- Keep domain data, app state, and business decisions outside this component.

## Wrong use cases
- Do not use Icons as a domain-specific component with embedded feature logic; create a domain component under `src/components` and compose this component instead.
- Do not import from `@/butler-ds/shadcn/ui` in app code; import from `@/butler-ds` so the public API remains stable.
- Do not lock dimensions to pixel-perfect desktop-only widths. Use responsive containers, intrinsic sizing, and tokens.

## Tags
`MessageSquare` is the plain speech bubble; `Notebook` is the note icon.
`GeneralChat` is the rounded conversation bubble for a default chat channel.
`Briefcase` identifies a project; `LayoutDashboard` opens its dashboard.
Use them to distinguish conversation kinds without adding an action symbol.

iconography, action, status
