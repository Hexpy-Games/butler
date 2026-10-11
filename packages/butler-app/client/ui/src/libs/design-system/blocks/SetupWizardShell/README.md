# SetupWizardShell

## What is this component
A full-screen setup wizard shell with the bloom `Wallpaper`, flat progress, and
TintedGlass body.

## When to use this component
Use it for first-run, repair, import, and setup flows that block entry into a
larger workspace.

## Where to use this component
Use it from product setup containers that provide copy, state, and actions.

## Why to use this component
It keeps setup layout, glass treatment, and progress styling in the design
system instead of product CSS modules.

## How to use this component
Pass a title, ordered steps, active index, and setup content.

`variant="focus"` drops the visible title, the stepper and the glass body.
A narrow `PageContainer` holds one centered column on the backdrop
(`SetupWizardContent` 420px, `width="wide"` 520px). The column is
centered below the titlebar when it fits, and it scrolls with the window when taller.
Use `SetupWizardContent surface="solid"` for an opaque raised card over wallpaper: one `--space-lg` inline inset contains the title, description, fields, actions and status.
Page content stays opaque (Tinted glass pattern); wallpaper appears only around the card. The first run (welcome, then "Pick an AI")
uses it. `title` still names the region for assistive tech.

### Focus options
- `anchor="top"` puts the column at one top edge instead of the middle of the
  window: `clamp(titlebar + --space-lg, 20% of the window, 240px)` (phone floor
  header + 16px = 72px). An intro card and taller or shorter step cards share
  that edge, and the card's centre sits slightly above the window's centre.
- `stepKey` replaces the card when the key changes. When the card width
  changes (`SetupWizardContent` 420px and a 520px `SetupWizardStepCard`), the
  card **morphs**: one surface with the card paint moves its real edges over
  `--motion-deliberate` on `--motion-ease-emphasized` with the top edge fixed,
  and nothing is scaled, so the border, corners and text stay crisp. The old
  content leaves (`--motion-exit-base` forward, `--motion-exit-fast` back), the
  larger card's content is clipped to the moving edge, and the new card's rows
  rise in from `--motion-morph-rows` (150ms) every `--motion-stagger-row`
  (30ms) over `--motion-base` and `--motion-distance-sm`; forward ends at
  430ms, back at 370ms. While it runs the cards take no clicks (a second press
  is ignored); a resize or new copy (language change) jumps to the end; a
  hidden window pauses it. Focus is the new card's job: the step title going
  forward, the start action going back. At rest no surface, clip or animation
  remains. Cards of the same width keep the plain swap (the old copy fades out,
  the new card rises in). Under reduced motion the card swaps at once. Keep
  one key for all steps that share a card; the step card's `contentKey` fades
  its body between steps.
- `intro="rerun"` is the short re-run variant ("설정 다시 실행"): the first card
  appears with opacity and a 4px rise over `--motion-slow`, decelerating; under
  reduced motion it is there at once. The first-install ink intro joins this
  prop as `full`, drawn on the shell's wallpaper layer.
- `SetupWizardProgress` (the wizard stepper) is exported for step headers;
  `SetupWizardStepCard` renders it from its `steps`.

## Who can use this component
Any setup workflow that follows a short linear sequence.

## Best practice
Keep header copy flat and short. Put interaction controls inside
`SetupWizardContent`.

## Wrong use cases
Do not use it for normal workspace pages or dashboards.

## Tags
setup, wizard, progress, glass

## Layout and theme
The shell sits in a `narrow` PageContainer. The title and stepper share the body's inline inset (`--setup-wizard-inset` plus the hairline border), and the scroll area fills the glass body to its bottom edge with the inset inside the scrolling content. Pass `tone="dark"` when the resolved appearance theme is dark so the wallpaper backdrop is dark.

The solid content card composes the public Box raised-opaque surface and card elevation.
