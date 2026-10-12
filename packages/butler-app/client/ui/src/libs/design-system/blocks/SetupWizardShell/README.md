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
- `stepKey` replaces the card when the key changes; give every step its own
  key. When both cards are solid (`SetupWizardContent surface="solid"` or a
  `SetupWizardStepCard`), every change, forward or back, **morphs** the card:
  420px and 520px, or two 520px steps of different heights. One surface with
  the card paint moves its real edges over `--motion-deliberate` on
  `--motion-ease-emphasized` with the top edge fixed, and nothing is scaled,
  so the border, corners and text stay crisp. The old content leaves
  (`--motion-exit-base` when the card grows, `--motion-exit-fast` when it
  shrinks), the content of the larger card is clipped to the moving edge, and
  the rows of the new card rise in from `--motion-morph-rows` (150ms) every
  `--motion-stagger-row` (30ms) over `--motion-base` and
  `--motion-distance-sm`. While it runs the cards take no clicks (a second
  press is ignored); a window resize jumps to the end; the new card settling
  another size (content that loads in, new copy) retargets the moving edge
  from where it is; a hidden window pauses it. Focus is the new card's job: the
  step title going forward, the previous control going back. At rest no
  surface, clip or animation remains. A frame without a solid card keeps the
  plain swap (the old copy fades out, the new card rises in). Under reduced
  motion the card swaps at once. Rows enter in order only when they exist
  from the first render: keep a status that appears later inside one row that
  is always there, so it never shows before the card. Within one step the
  step card's `contentKey` fades its body (sub-views of a step).
- `intro="full"` is the first-install ink intro (intro spec Concept A rev 5),
  drawn on the shell wallpaper itself (one canvas): a purple drop blooms into
  the three riso plates, a pen writes the ring clockwise from 12 o'clock with
  the ink as its supply, the bow tie registers, and the printed mark glides
  into the `SetupWizardMark` slot of the welcome card (measured from the real
  card at every height). The DOM mark takes over at 2250ms, the card surface
  fades in around it and the lines follow 70ms apart (settled about 2.95s).
  A click or a key skips to the end; a hidden window pauses the print and the
  card together; reduced motion or software GL draws the dried print once and
  fades the card in (`--motion-base`); without WebGL2 a still ink wash stands
  in while the SVG ring draws (`--motion-intro-draw`) and the bow tie prints
  (`--motion-intro-print`). After the reveal nothing runs (0 frames); a fine
  pointer stirs the dried ink briefly. The first step change shifts the print
  with the card (600ms beat), then hands the canvas to the riso print, which
  dissolves in from the intro's last frame over its first 8s segment; the
  card stays the print's keep-out until the shell closes.
- `intro="rerun"` is the short re-run variant ("설정 다시 실행"): the dried print
  is drawn once (no reveal) and the first card appears with opacity and a 4px
  rise over `--motion-slow`, decelerating; under reduced motion it is there at
  once.
- `SetupWizardMark` is the plain Butler logo for the 64px slot of the welcome
  card: it stays still while Butler prepares (the preparation row shows the
  progress; no working mark on the intro).
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
