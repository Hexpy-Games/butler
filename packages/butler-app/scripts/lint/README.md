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
  `no-inline-style`, `no-raw-interactive`, `no-raw-typography`.
- Stylelint rules (`butler-ds/stylelint-plugin.ts`): `token-only-values`,
  `no-ds-internal-selector`, `no-ds-custom-prop-override`.
- `no-new-css-module`: product `*.module.css` files are frozen to the
  allowlist in `butler-ds/baseline/no-new-css-module.json`.

Existing violations live in `butler-ds/baseline/<rule>.json` as per-file
counts. The check fails when a file's count grows or a new file appears, and
also when a count shrinks without the baseline being updated, so the baseline
only shrinks. After removing violations run `bun run lint:ds:baseline`; it
refuses to record increases (`--allow-growth` is reserved for owner-approved
changes). Inline `eslint-disable` / `stylelint-disable` comments are ignored.

`token-only-values` exceptions: `0`, `auto`, percentages, global keywords,
`calc()`/`env()` around tokens, `1px` hairline offsets in spacing (no hairline
token exists), `linear` easing for loops, and `line-height: 1 | normal`.

## Boundaries

These checks protect Butler App UI quality contracts. Agent runtime behavior
and package-neutral validation belong outside this folder.

## Related Specs

- `SPEC-BUTLER-DEDICATED-CLIENT-APP-EXPERIENCE` - Butler Dedicated Client App Experience
- `SPEC-BUTLER-DEDICATED-CLIENT-DESIGN-SYSTEM` - Butler Dedicated Client Design System
