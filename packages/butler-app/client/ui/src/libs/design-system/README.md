# Butler Design System

Butler Design System is the client UI foundation for reusable primitives, tokens, documentation, showcases, and agent-facing guidance.

> Building or reviewing UI (human or agent)? Read
> [`skills/butler-design-system/SKILL.md`](skills/butler-design-system/SKILL.md)
> and pick components from its generated
> [catalog](skills/butler-design-system/references/catalog.md) (decision guide,
> every component, Build-a-screen recipes). Product UI is assembled only from
> this system.

## Boundaries

- App code imports public components from `@/butler-ds`.
- Design-system code lives under `packages/butler-app/client/ui/src/libs/design-system`.
- Domain components stay under `packages/butler-app/client/ui/src/components` and compose design-system components.
- `tokens.css` is the source stylesheet for shared tokens and shadcn-compatible variables.
- Raw shadcn files live under `shadcn/ui`; app code should not import that path directly.
- Use `Spinner` for indeterminate loading. It owns the official traveling-gap geometry, motion, and reduced-motion behavior; do not animate separate loading icons in product CSS. See [Spinner](components/Spinner/README.md).
- Use `ButlerThinkingMark` when Butler itself is thinking; it is the identity mark, not a generic loader. See [ButlerThinkingMark](components/ButlerThinkingMark/README.md).

## Motion

Motion lives in DS components and tokens (DS spec Motion Contract). Use the
`--motion-*` duration, exit, easing, distance and scale tokens in DS CSS, and
`animateMotion()` from `lib/motion.ts` instead of `element.animate()`.
Reduced motion zeroes `--motion-distance-*` and resets `--motion-scale-*`, so
token-driven animations become an opacity fade. JS-driven loops read timing
with `motionDuration()` and `easeProgress()` and follow reduced motion with
`subscribeReducedMotion()`; canvas engines and their
intrinsic simulation constants are allowlisted in `lint:motion`
(`CANVAS_MOTION_ENGINES`). App and viewer force reduction with
`setReducedMotionOverride(true)` on the app shell; `false` follows the OS.
Vite's `reduced-motion-css` PostCSS plugin generates `@scope` counterparts
from the existing OS media rules, so lazy CSS modules also honour the override.
This is shared by Electron and browser builds (CSS `@scope` support required);
`matchMedia` continues to report the OS and DS helpers report the effective preference.
Product code never declares
transitions, animations or keyframes (`bun run lint:motion`).

## Product Code Constraints

`bun run lint:ds` enforces the DS boundary in product code (everything under
`client/ui/src` except this folder, tests, fixtures and harness pages) in
ratchet mode: existing violations are baselined per file and may only shrink.

- Style DS components through their props (`variant`, `size`, `tone`, layout
  props). `className` and `style` are not part of the public DS types
  (`DsBaseProps`, `lib/dsProps.ts`): they are DS-private slots typed
  `DsClassName`/`DsStyle` that only `dsClass()`/`dsStyle()` in `lib/internal`
  mint, and ESLint blocks `lib/internal` outside this folder, so `tsc` rejects
  product styling. Data-driven geometry uses `UNSAFE_style` (width, height,
  min/max sizes, transform, inset and custom properties) on `Stack` and
  `AdaptiveShell` (resizable panel widths); product uses are counted by
  `butler-ds/unsafe-style-allowlist` against `baseline/unsafe-style.json`.
  Virtualized rows use `MessageRow offsetY`; a scroller floor uses
  `ScrollArea minHeight`.
- Use `Button`, `IconButton`, `Clickable`, `Input`, `Textarea`, `Select`,
  `NativeSelect`, `Switch` and `Slider` instead of raw `<button>`, `<input>`,
  `<select>`, `<textarea>` or an `<a onClick>` without `href`.
- Use `Typo` for text instead of `<p>`, `<span>` or `<h1-6>` with a
  `className`.
- Product CSS modules are frozen to the current allowlist; new layout goes
  through `Stack`, `Grid`, `Section`, `Space` and blocks.
- Product CSS uses tokens (`var(--...)`) for color, spacing, radius, z-index,
  motion and typography, never targets DS internals (element selectors,
  `[data-slot]`, `[data-state]`, `:global(.ds-class)`), and never sets DS
  custom properties such as `--clickable-*`, `--sidebar-*` or `--icon-button-*`.

When the DS cannot express what a screen needs, request a DS capability
instead of working around it: add a prop, variant or block here (with a
showcase story, README and tests) or record the gap against
`SPEC-BUTLER-DEDICATED-CLIENT-DESIGN-SYSTEM`, then migrate the product code
and run `bun run lint:ds:baseline` to shrink the baseline. See
`packages/butler-app/scripts/lint/README.md` for the rule details.

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

Every component and block folder owns `<Name>.showcase.tsx` (stories and an
optional states matrix) and `<Name>.guidance.tsx` (usage guidance); the viewer
collects both automatically.

Or capture item pages directly:

```sh
bun run render Button NavRow CollapsibleNavGroup
bun run render Button NavRow --viewport=iphone
bun run render Button NavRow --viewport=mobile
bun run render all --viewport=all
bun run render page:foundations/typography --full-page --locale=ko --theme=light,dark
```
