# SurfacePanel

## What is this block

SurfacePanel is a Butler design-system block for card/panel containers with elevation and padding.

## When to use this block

Use SurfacePanel for inspector panels, dashboard cards, settings groups, or any surface that needs visual elevation.

## Container vs Presenter

**SurfacePanel is a presenter block.** It owns visual container styling. It must not import Butler domain content or state.

**Container responsibilities:** Domain components provide panel content and choose appropriate elevation level.

## Similar blocks

- Use **Section** primitive for content sections without card styling
- Use **Stack** for simple containers without elevation
- Compose with **PanelHeader** for titled panels

## Usage

```tsx
import { SurfacePanel, PanelHeader } from "@/butler-ds";

<SurfacePanel elevation="medium">
  <PanelHeader title="Usage Stats" />
  <StatContent />
</SurfacePanel>
```

## Accessibility

- Standard div container
- No special ARIA needed
- Content determines semantics

## Responsive behavior

- Full-width layout
- Padding scales with viewport
- Works at all breakpoints

## Wrong use cases

- Do not use for inline content without separation
- Do not nest deeply (2 levels max recommended)
- Do not use when simple background suffices

## Tags

panel, card, surface, container, elevation
