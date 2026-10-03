# ContextDonutButton

## What is this component
ContextDonutButton renders the compact circular context-usage trigger used in the composer.

## When to use this component
Use it when context usage needs to be available without consuming toolbar width.

## Where to use this component
Use it in composer control clusters and similar dense action bars.

## Why to use this component
It keeps the donut geometry, hover behavior, and ratio styling in the design system.

## How to use this component
Pass a normalized ratio from 0 to 1 and provide an accessible label.

`surface="plain"` (default) preserves the existing transparent 30px trigger.
Use `surface="glass"` alongside composer pills. It composes `PillButton`
internally, sharing its glass surface, height, padding, hit area, and
hover/focus/pressed/disabled states without duplicating styles. Both surfaces
keep the same 18px ring, 20×20 viewBox, radius 8, and ratio geometry.

```tsx
<ContextDonutButton ratio={0.42} surface="glass" aria-label="Context 42% used" />
```

## Who can use this component
Composer containers and design-system fixtures.

## Best practice
Pair it with Popover content that exposes exact token counts.

## Wrong use cases
Do not use it for detailed analytics. Use ProgressMeter or Chart for inspectable data.

## Tags
composer, context, usage, button, dense
