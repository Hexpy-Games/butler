# SetupWizardShell

## What is this component
A full-screen setup wizard shell with the fluid background, flat progress, and
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
The shell sits in a `narrow` PageContainer. The title and stepper share the body's inline inset (`--setup-wizard-inset` plus the hairline border), and the scroll area fills the glass body to its bottom edge with the inset inside the scrolling content. Pass `tone="dark"` when the resolved appearance theme is dark so the fluid backdrop is dark.
