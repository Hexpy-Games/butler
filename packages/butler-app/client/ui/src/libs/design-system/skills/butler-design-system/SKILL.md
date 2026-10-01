---
name: butler-design-system
description: Build, change or review Butler app UI by assembling it only from the Butler design system (@/butler-ds). Use for any work under packages/butler-app/client/ui.
---

# Butler Design System Skill

Use this skill when building, refactoring, reviewing, or documenting Butler app
UI. It applies to every agent (Claude, Codex, Butler workers) and to humans.

This skill is a component-selection and quality-gate guide, not a style
description. It should make a new agent faster while preventing one-off CSS,
domain-coupled blocks, or visually inconsistent UI.

## Hard Rules

Product UI is assembled only from the design system. The type system and the
lints below enforce most of this; the rest is review.

1. **Pick, don't build.** Look the need up in `references/catalog.md` (the
   decision guide: "I need X → use Y") and the DS Viewer before writing JSX.
   If a component or block exists, use it: never create a new component that
   duplicates one.
2. **No new CSS.** Product code adds no CSS modules outside the frozen
   allowlist, no Tailwind or other utility classes, no global class names.
3. **No className and no inline style on DS components (enforced by types).**
   Public DS props are `DsBaseProps` (`className`/`style` omitted; they exist
   only as DS-private slots typed `DsClassName`/`DsStyle`, minted by
   `dsClass()`/`dsStyle()` from `lib/internal`, which ESLint blocks outside
   the DS). `tsc` rejects `className="…"` or `style={{…}}` on a DS
   component. Style through props (`variant`, `size`, `tone`, `gap`, layout
   item props, `windowDrag`, `permissionTone`, `theme`, …). Data-driven
   geometry (resizable panel widths) goes through `UNSAFE_style`
   (width/height/min/max, transform, inset, `--*` only) on the few
   components that offer it (`Stack`, `AdaptiveShell`); every product use is
   allowlisted per file. Virtualized rows use `MessageRow offsetY`. No
   `style={{…}}` on raw elements in product code either.
4. **No raw interactive or typography elements.** Use `Button`, `IconButton`,
   `Clickable`, `Input`, `Textarea`, `Select`, `NativeSelect`, `Switch`,
   `Slider` instead of `<button>`, `<input>`, `<select>`, `<textarea>`; use
   `Typo` instead of `<p>`, `<span>` or `<h1-6>` with classes.
5. **Tokens only.** Color, spacing, radius, z-index, typography and motion
   come from `tokens.css` (`var(--…)`), inside the DS. Text is Pretendard
   Variable (`--font-body`) and code IBM Plex Mono (`--font-family-code`),
   both bundled; never name another font family.
6. **Motion only via the DS.** Product code never declares transitions,
   animations, keyframes or `element.animate()`; DS components own motion on
   `--motion-*` tokens and honor reduced motion.

## First Principles

- Treat `packages/butler-app/client/ui/src/libs/design-system` as the design-system subrepo.
- Import public design-system APIs from `@/butler-ds`.
- Keep domain components in `packages/butler-app/client/ui/src/components`.
- Keep every component responsive from the start; validate at iPhone-width mobile, tablet-ish, and desktop viewports.
- Preserve Butler's visual language: compact glass-influenced surfaces, 30px
  controls where appropriate, quiet hairline borders, flat active selection, and
  fast subtle motion.
- Active navigation states are flat backgrounds. Do not add outline, shadow,
  inset border, or glow treatments to active rows.
- Consecutive buttons must be wrapped in `ButtonContainer`. Pass the intended
  button `size` to the container and use the same size on every button inside it
  so inter-button spacing is consistent across the app.

## Decision Loop

1. **Intent**: classify the job as layout, typography, action, form,
   navigation, overlay, data, status, shell, or feedback.
2. **Look it up**: `references/catalog.md` (generated from every component's
   guidance) or the DS Viewer decision guide and Cmd+K search.
3. **Primitive first**: use a primitive when one component expresses the
   behavior and shape.
4. **Block second**: use a block when the UI is a reusable composition of
   primitives. Start from a "Build a screen" recipe for whole screens.
5. **Container last**: keep domain data, store selectors, IPC, routing, app copy,
   and persistence in `packages/butler-app/client/ui/src/components`.
6. **Missing capability**: follow "Adding A DS Capability" below; never work
   around it in product CSS.

`references/component-map.md` keeps the longer intent index, CSS ownership map
and quality gates.

## Recipes

Every item page in the DS Viewer shows composition recipes with their exact JSX
(from `<Name>.guidance.tsx` `#region recipe:` blocks). Whole screens (settings
page, conversation turn, sidebar, project dashboard, dialog form,
empty/loading/error states; no CSS files, no className, and no inline style
except Skeleton sizing, which has no size props yet) are
under "Build a screen" in the viewer and at the
end of `references/catalog.md`. A settings page renders only `SettingsSection`s
(each owns its loading, error and empty states), and `SettingsField` throws
outside a section in dev builds. For example:

```tsx
import { SettingsField, SettingsPage, SettingsSection, Switch } from "@/butler-ds";

<SettingsPage>
  <SettingsSection id="appearance" kind="form" title="Appearance" description="Applies to every window.">
    <SettingsField id="translucent" label="Translucent sidebar" description="Show the desktop behind the sidebar."
      control={<Switch id="translucent" defaultChecked />} />
  </SettingsSection>
</SettingsPage>
```

## Input variants

Use `Input` with `variant="default"` for boxed form fields and
`variant="underline"` for in-place entry where a row label becomes editable.
Underline has zero horizontal padding and an inset token keyboard-focus outline
(the focus foundation's clipping-container rule); never suppress its ring.
`compact` independently selects the short toolbar field size. Both variants
support invalid, disabled and read-only states. See the Input viewer matrix.

## Container / Presenter Contract

Blocks are presenters. They own visual layout, states, responsive behavior, and
accessibility. They must not import domain data, stores, app API modules,
product components, app copy, routing, or `window.butlerApp`.

Domain components are containers. They select or fetch data, map domain records
to final UI props, provide localized/product copy, and execute app commands:

```tsx
function ProjectSessionRowContainer({ sessionId }: { sessionId: string }) {
  const session = useSessionSummary(sessionId);
  const active = useIsActiveSession(sessionId);
  return <NavRow label={session.title} active={active} meta={session.updatedLabel} onClick={() => openSession(sessionId)} />;
}
```

## Styling Rules

- Use `tokens.css` only for tokens, reset, theme classes, native root behavior,
  and shared helpers such as `.sr-only`, `.drag-region`, and `.no-drag`.
- Do not add component selectors, app-domain classes, or coupling styles to
  `tokens.css`.
- Put primitive styles beside the owning primitive and block styles beside the
  owning block; product components under `src/components` own no CSS modules.
- Do not import `@/styles/components` or bridge style maps from new product UI.
- Responsive: no fixed desktop widths, token spacing, `minmax(0, 1fr)`,
  intrinsic sizing; validate 320, 375, 390, and 430px plus desktop.

## Lint Gates

| Command | What it enforces |
| --- | --- |
| `bun run typecheck` | The first gate: DS component types have no public `className`/`style`; `UNSAFE_style` accepts geometry only. |
| `bun run lint:ds` | Product-code ratchet (per-file baselines only shrink): `no-classname-on-ds`, `no-inline-style`, `no-raw-interactive`, `no-raw-typography`, `unsafe-style-allowlist` (`baseline/unsafe-style.json`), `no-new-css-module`, `token-only-values`, `no-ds-internal-selector`, `no-ds-custom-prop-override`; warning `no-raw-length-custom-prop`. |
| `eslint` (`no-restricted-imports`) | `lib/internal` (`dsClass`, `dsStyle`) is importable only inside `libs/design-system`. |
| `packages/butler-app/scripts/codemods/ds-unsafe-style.ts` | Dry run fails on any `className`/`style` left on a DS component; `--write` renames geometry-only `style` to `UNSAFE_style`. |
| `bun run lint:motion` | `motion-outside-ds`, `keyword-easing` (tokens, not `ease`/`linear`), `transition-property` (compositor and paint properties only), `waapi-outside-helper`. |
| `bun run lint:design` | Token lint (no raw colors or font values), DS rules (focus ring, z-index tokens, control heights), copy lint, 160-line component limit, CSS module globals, prop boundaries, then `lint:ds` and `lint:motion`. |
| `bun run lint:css` | Prettier format check and stylelint for every UI stylesheet. |
| `tests/unit/ds-showcase-coverage.test.ts` | Every DS folder has a showcase, `<Name>.guidance.tsx` and README, is exported from the barrel, shows every exported component, and interactive items have a states matrix. |

Baselines are shrink-only: never pass `--allow-growth` or re-baseline upward.

## Adding A DS Capability

When the catalog has nothing that fits:

1. **Spec**: update the design-system spec in Project Ledger (existing `butler`
   project) with the API and the product need.
2. **Tests first**: add unit tests for the component contract.
3. **DS component**: props extend `DsBaseProps<…>` (never a public
   `className`/`style`); DS code composing other DS components passes classes
   with `className={dsClass(styles.x)}`. `components/<Name>/` or `blocks/<Name>/` with
   `<Name>.tsx`, CSS module, `index.ts`, `README.md`, `<Name>.showcase.tsx`
   (stories mirroring real usage, en/ko, states matrix when interactive) and
   `<Name>.guidance.tsx` (purpose, when/when not, recipes, do/don't, content,
   accessibility, tokens); export it from `index.ts`.
4. **Migrate** product usages to it and shrink any lint baselines it frees.
5. Regenerate the skill catalog: `bun run ds:skill-catalog`.

## DS Viewer And Render

The DS Viewer (`디자인시스템뷰어`) is the visual QA surface, lazy-loaded at:

```text
/?visual=design-system
/?visual=design-system&page=components/Button&theme=side-by-side&locale=ko&width=375&motion=reduced
```

It has Overview, a decision guide, Build-a-screen recipes, Foundations (token
pages generated from `tokens.css`, light and dark side by side), Motion,
Components, Blocks, Patterns and Icons; item pages show examples, a forced
states matrix, usage guidance and the README. `/` filters the sidebar; Cmd+K
searches everything. Every page is a deep link (`page`, `theme`, `locale`,
`width`, `motion`).

Screenshots from the command line:

```sh
bun run render Button NavRow CollapsibleNavGroup
bun run render Button NavRow --viewport=iphone
bun run render Button NavRow --viewport=mobile
bun run render all --viewport=all
bun run render Button --theme=all
```

Viewer pages render too: pass a page id with a slash or a `page:` prefix
(`bun run render page:overview foundations/color patterns/tinted-glass`), alone
or beside `all`. The render command builds the UI, opens each item or page by
deep link and writes `.tmp/ds-viewer`; unknown names fail.

## Wrong-Turn Guardrails

- Do not create raw HTML plus local styles inside a block when primitives can
  express the same structure.
- Do not create a block that imports domain models, stores, app commands, or app
  copy.
- Do not add product-specific props to primitives to absorb deleted legacy CSS.
- Do not use `Button` as a row container when nested buttons are required; use
  `Clickable` or a component with an `as`/composition API.
- Do not use document headings for dense app chrome; use `Typo` app variants.
- Do not use `DropdownMenu` as a form select; use `Select` or `NativeSelect`.

## Testing And Model Cost

UI work never needs real model calls. Run tests and smokes with isolated data
(`BUTLER_DATA`, `CODEX_HOME` in a temp dir) and stubbed providers. If a real
call is unavoidable, use only `luna` with low reasoning; never `xhigh`, `sol`
or `astra`.

## Validation

Before reporting completion:

1. `npm --prefix packages/butler-app/client/ui run --silent typecheck`.
2. `bun run lint:design` and `bun run lint:css` when CSS changed.
3. `bun test tests/unit/ds-showcase-coverage.test.ts tests/unit/app-client-design.test.ts`.
4. `bun run app:design-system:smoke` (bundle check, navigation, viewer, cell overflow audit and motion trace) and `bun run app:layout:smoke` for layout changes.
5. `bun run render <ComponentName...>` (add `--viewport=mobile`) when rendered DS output changed.
6. Run `packages/project-ledger/bin/project-ledger check --project "$PWD" --silent` for project closeout.
