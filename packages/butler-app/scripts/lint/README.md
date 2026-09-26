# Butler App Lint Scripts

`packages/butler-app/scripts/lint/` contains Butler App client lint checks for
component size, CSS module boundaries, design tokens, design-system rules
(focus ring, layering, menu sizing), visible copy, and frontend prop
boundaries.

## DS Constraint Lint (ratchet)

`ds-constraint-lint.ts` (`bun run lint:ds`, part of `lint:design`) runs the
`butler-ds/*` rules over product code: `client/ui/src` minus
`libs/design-system/**`, tests, `*.d.ts`, `app/fixtures.ts` and the
`pages/*Harness` pages (`butler-ds/scope.ts`).

- ESLint rules (`butler-ds/eslint-plugin.ts`): `no-classname-on-ds`,
  `no-inline-style`, `no-raw-interactive`, `no-raw-typography`,
  `unsafe-style-allowlist` (every `UNSAFE_style` is counted per file against
  `butler-ds/baseline/unsafe-style.json`; new uses need owner approval).
- Stylelint rules (`butler-ds/stylelint-plugin.ts`): `token-only-values`,
  `no-ds-internal-selector`, `no-ds-custom-prop-override`.
- `no-new-css-module`: product `*.module.css` files are frozen to the
  allowlist in `butler-ds/baseline/no-new-css-module.json`.

Types come first: DS component props are `DsBaseProps` (no public
`className`/`style`; DS code uses `dsClass()`/`dsStyle()` from
`libs/design-system/lib/internal`, which the root `eslint.config.js` blocks
outside the design system with `no-restricted-imports`), so `bun run
typecheck` rejects product styling of DS components before these rules run.
`packages/butler-app/scripts/codemods/ds-unsafe-style.ts` (ts-morph) renames
geometry-only `style` on DS components to `UNSAFE_style` (`--write`) and
fails while any `className`/`style` is left on a DS component.

Existing violations live in `butler-ds/baseline/<rule>.json` as per-file
counts. The check fails when a file's count grows or a new file appears, and
also when a count shrinks without the baseline being updated, so the baseline
only shrinks. After removing violations run `bun run lint:ds:baseline`; it
refuses to record increases (`--allow-growth` is reserved for owner-approved
changes). Inline `eslint-disable` / `stylelint-disable` comments are ignored.

`token-only-values` exceptions: `0`, `auto`, percentages, global keywords,
`calc()`/`env()` around tokens, `linear` easing for loops, and
`line-height: 1 | normal`. Hairline offsets use `var(--border-hairline)`.

`no-raw-length-custom-prop` is a warning rule: product CSS custom properties
whose values carry raw lengths are printed by `lint:ds` but not ratcheted yet.

## Motion Lint (ratchet)

`motion-lint.ts` (`bun run lint:motion`, part of `lint:design`) enforces the
DS spec Motion Contract over all of `client/ui/src` (design system included,
tests excluded) with shrink-only baselines in `motion/baseline/<rule>.json`
(`bun run lint:motion:baseline` records shrinkage and refuses growth).

- `motion-outside-ds`: `transition`, `animation` or `@keyframes` outside
  `libs/design-system` (`none` is allowed).
- `keyword-easing`: `ease`, `ease-in`, `ease-out`, `ease-in-out`, `linear`
  and step keywords in motion declarations; use `var(--motion-ease-*)`
  (`--motion-ease-linear` for loops). `linear()` curves pass.
- `transition-property`: transitions and keyframes may only move `opacity`,
  `transform`/`translate`/`scale`/`rotate`, `filter`, paint properties
  (`color`, `background(-color)`, `border-color`, `box-shadow`,
  `outline-color`, `stroke-dashoffset`), `visibility`, the registered
  `--scroll-fade-*` mask properties, and `display`/`overlay` with
  `allow-discrete`. `height`/`block-size` pass only in DS reveal components
  (`components/Collapsible`) that set `interpolate-size: allow-keywords`.
- `waapi-outside-helper`: `.animate(` and `startViewTransition` outside
  `libs/design-system/lib/motion.ts` (use `animateMotion`).

## Boundaries

These checks protect Butler App UI quality contracts. Agent runtime behavior
and package-neutral validation belong outside this folder.

## Related Specs

- `SPEC-BUTLER-DEDICATED-CLIENT-APP-EXPERIENCE` - Butler Dedicated Client App Experience
- `SPEC-BUTLER-DEDICATED-CLIENT-DESIGN-SYSTEM` - Butler Dedicated Client Design System
