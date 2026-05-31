# Butler Design System

Butler Design System is the client UI foundation for reusable primitives, tokens, documentation, fixtures, and agent-facing guidance.

## Boundaries

- App code imports public components from `@/butler-ds`.
- Design-system code lives under `packages/butler-app/client/ui/src/libs/design-system`.
- Domain components stay under `packages/butler-app/client/ui/src/components` and compose design-system components.
- `tokens.css` is the source stylesheet for shared tokens and shadcn-compatible variables.
- Raw shadcn files live under `shadcn/ui`; app code should not import that path directly.

## Responsive Contract

Design system components must be fluid by default. Use intrinsic sizing, `auto-fit` grids, clamp-based padding where needed, and mobile checks around iPhone viewport widths before treating a component as ready.

## Agent Usage

Copy or install `skills/butler-design-system` into a Codex or Butler skills directory, then follow its `SKILL.md` before creating UI components.

```sh
node packages/butler-app/client/ui/src/libs/design-system/scripts/install-design-system-skill.mjs
```

## Visual Check

Run the UI and open:

```text
/?visual=design-system
```

Or capture component fixtures directly:

```sh
bun run render Button NavRow CollapsibleNavGroup
bun run render Button NavRow --viewport=iphone
bun run render Button NavRow --viewport=mobile
bun run render all --viewport=all
```
