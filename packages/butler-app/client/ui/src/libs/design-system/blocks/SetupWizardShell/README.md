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
