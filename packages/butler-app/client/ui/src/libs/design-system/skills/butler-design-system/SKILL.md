# Butler Design System Skill

Use this skill when building, refactoring, reviewing, or documenting Butler Butler app UI components.

This skill is a component-selection and quality-gate guide, not a style
description. It should make a new agent faster while preventing one-off CSS,
domain-coupled blocks, or visually inconsistent UI.

## First Principles

- Treat `packages/butler-app/client/ui/src/libs/design-system` as the design-system subrepo.
- Import public design-system APIs from `@/butler-ds`.
- Keep domain components in `packages/butler-app/client/ui/src/components`.
- Prefer existing shadcn-backed primitives and Butler design-system components before creating new UI.
- Keep every component responsive from the start; validate at iPhone-width mobile, tablet-ish, and desktop viewports.
- Preserve Butler's visual language: compact glass-influenced surfaces, 30px
  controls where appropriate, quiet hairline borders, flat active selection, and
  fast subtle motion.
- Active navigation states are flat backgrounds. Do not add outline, shadow,
  inset border, or glow treatments to active rows.
- Consecutive buttons must be wrapped in `ButtonContainer`. Pass the intended
  button `size` to the container and use the same size on every button inside it
  so inter-button spacing is consistent across the app.

## Before Creating UI

1. Read `references/component-map.md` and choose the smallest component set that fits the job.
2. Search `packages/butler-app/client/ui/src/libs/design-system/components` for the chosen component.
3. Search `packages/butler-app/client/ui/src/libs/design-system/blocks` when the UI is a
   repeated composition such as a row, section, panel, metric, empty state, or
   composer control.
4. Read the component or block README before using it.
5. Check `registry.tsx` and `fixtures/DesignSystemWorkbench.tsx` for rendered
   examples in DS Viewer.
6. If a primitive exists in `shadcn/ui`, expose it through a component directory
   and the public barrel before using it in app code.

## Decision Loop

Use this loop for every UI change:

1. **Intent**: classify the job as layout, typography, action, form,
   navigation, overlay, data, status, shell, or feedback.
2. **Primitive first**: use a primitive when one component expresses the
   behavior and shape.
3. **Block second**: use a block when the UI is a reusable composition of
   primitives.
4. **Container last**: keep domain data, store selectors, IPC, routing, app copy,
   and persistence in `packages/butler-app/client/ui/src/components`.
5. **Create only when needed**: add a new DS component only when the need is
   reusable, domain-neutral, fixture-renderable, documented, and responsive.

## Component Contract

Each design-system component directory should contain:

- `<Component>.tsx`
- `<Component>.module.css`
- `<Component>.fixtures.tsx`
- `README.md`
- `index.ts`

The README must describe what the component is, when and where to use it, why it exists, how to use it, who owns/uses it, best practices, wrong use cases with alternatives, and tags for search.

## Container / Presenter Contract

Blocks are presenters. They own visual layout, states, responsive behavior, and
accessibility. They must not import domain data, stores, app API modules,
product components, app copy, routing, or `window.butlerApp`.

Domain components are containers. They select or fetch data, map domain records
to final UI props, provide localized/product copy, and execute app commands.
When a mixed component contains both logic and reusable UI, split it first:

```tsx
// Product container
function ProjectSessionRowContainer({ sessionId }: { sessionId: string }) {
  const session = useSessionSummary(sessionId);
  const active = useIsActiveSession(sessionId);

  return (
    <NavRow
      label={session.title}
      active={active}
      meta={session.updatedLabel}
      onClick={() => openSession(sessionId)}
    />
  );
}
```

The presenter stays in the design system only if it remains domain-neutral and
can render from static fixtures.

## Responsive Rules

- Do not design against a fixed desktop width.
- Use token-backed spacing, typography, colors, borders, and radii.
- Prefer `minmax(0, 1fr)`, `auto-fit`, intrinsic sizing, and wrapping controls.
- Make labels wrap cleanly; do not let text overlap controls.
- Avoid viewport-scaled font sizes.
- Validate narrow widths at 320, 375, 390, and 430px plus desktop regression.
- Default controls should size to content. Add a `stretch` prop only when the
  component intentionally fills its parent.

## Styling Rules

- Use `tokens.css` only for tokens, reset, theme classes, native root behavior,
  and shared helpers such as `.sr-only`, `.drag-region`, and `.no-drag`.
- Do not add component selectors, app-domain classes, or coupling styles to
  `tokens.css`.
- Put primitive styles beside the owning primitive.
- Put reusable block styles beside the owning block.
- Product components under `src/components` should not own reusable CSS modules
  after the visual structure has moved into the design system.
- Do not import `@/styles/components` or bridge style maps from new product UI.

## Import Rules

Use:

```tsx
import { Button, ButtonContainer, Stack, Typo } from "@/butler-ds";
```

Avoid in app/domain code:

```tsx
import { Button } from "@/butler-ds/shadcn/ui/button";
import { Button } from "@/components/ui/button";
```

## shadcn Policy

Use shadcn components as the implementation base when they fit the component semantics. Keep raw shadcn files in `shadcn/ui`, then create a public design-system component directory that documents and exports the stable Butler-facing API.

## DS Viewer And Render

The fixture surface is **DS Viewer** (`디자인시스템뷰어` in Korean project
notes). It is the visual QA surface for agents.

Use it manually:

```text
/?visual=design-system
```

Use it from the command line for component screenshots:

```sh
bun run render Button NavRow CollapsibleNavGroup
bun run render Button NavRow --viewport=iphone
bun run render Button NavRow --viewport=mobile
bun run render all --viewport=all
```

The render command builds the UI, opens DS Viewer, captures requested component
fixtures into `.tmp/ds-viewer`, and fails on unknown component names. Use
`--viewport=iphone` for the canonical 390px iPhone check, `--viewport=mobile`
for 320/375/390/430px checks, and `--viewport=all` before claiming visual
completion for responsive primitive or block changes.

## Wrong-Turn Guardrails

- Do not create raw HTML plus local styles inside a block when primitives can
  express the same structure.
- Do not create a block that imports domain models, stores, app commands, or app
  copy.
- Do not add product-specific props to primitives to absorb deleted legacy CSS.
- Do not add component internals to `tokens.css`.
- Do not use `Button` as a row container when nested buttons are required; use
  `Clickable` or a component with an `as`/composition API.
- Do not use document headings for dense app chrome; use `Typo` app variants.
- Do not use `DropdownMenu` as a form select; use `Select` or `NativeSelect`.

## Validation

Before reporting completion:

1. Run `bun test tests/unit/app-client-design.test.ts`.
2. Run `npm --prefix packages/butler-app/client/ui run --silent typecheck`.
3. Run `bun run lint:design`.
4. Run `bun run lint:css` when CSS changed.
5. Run `bun run render <ComponentName...>` when rendered DS output changed.
6. Open `/?visual=design-system` and check mobile and desktop widths when UI rendering changed.
7. Run `bun run render <ComponentName...> --viewport=mobile` for responsive component changes.
8. Run `packages/project-ledger/bin/project-ledger check --project "$PWD" --silent` for project closeout.
