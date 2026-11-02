# ComposerControl

## What is this component
A compact pill command for composer toolbars.

## When to use this component
Use it for model, access, mode, or reasoning controls in a prompt composer.

## Where to use this component
Use it inside composer toolbars and dense inline command rows.

## Why to use this component
It keeps composer controls visually consistent and responsive.

## How to use this component
Pass an icon, label, optional detail, active state, and click handler.

## Who can use this component
Product UI containers and design-system blocks.

## Best practice
Pass `tone="danger"` for an error state (for example a model that failed to
load); pair it with an alert icon and a tooltip that explains the error.
Keep labels short and move domain formatting into the caller.
In a narrow composer, `compact="icon"` keeps a square touch target and centers
the icon on both axes. Hide the whole text slot from layout while retaining its
accessible label; no empty text gap or icon-plus-text padding should remain.
The circle holds as a Popover or Menu trigger (`asChild` renames `data-slot`).
On touch widths the pill keeps its visual control height
(`--control-height-md`); a transparent hit area extends it to
`--control-hit-target` (44px) so the toolbar does not grow taller.

## Wrong use cases
Do not use it for destructive or page-level actions. Use `Button` instead.

## Tags
composer, toolbar, pill, action
