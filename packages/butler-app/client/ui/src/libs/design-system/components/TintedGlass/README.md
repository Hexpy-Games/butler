# TintedGlass

## What is this component
TintedGlass is the Butler design-system primitive for translucent glass
containers that need stable fixed-edge tinting and backdrop blur.

## When to use this component
Use TintedGlass for compact app surfaces that should inherit the Butler glass
language: composer-like containers, popovers, menus, select content, tooltips,
and small floating panels.

## Where to use this component
Use the component for normal app containers. For Radix-owned content elements,
apply `tintedGlassSurfaceClassName` to the existing content element so the
surface does not gain extra wrapper DOM.

## Why to use this component
It keeps the glass treatment consistent and avoids percent-based gradient stops
that stretch when a container gets taller. The top and bottom fade zones stay
20px while the center remains an opaque tokenized tint over the translucent
glass base.

## How to use this component
Import from the public design-system alias:

```tsx
import { TintedGlass, tintedGlassSurfaceClassName } from "@/butler-ds";
```

Use the component for owned containers:

```tsx
<TintedGlass radius="composer" padding="lg">
  Composer content
</TintedGlass>
```

Use the class export for components that already own their content DOM:

```tsx
<SelectContent className={cn(tintedGlassSurfaceClassName, className)} />
```

## Who can use this component
Product engineers, design-system maintainers, and coding agents can use it when
building Butler client UI. Design-system maintainers own changes to the tint,
edge, and blur contract.

## Best practice
- Keep the component on compact app surfaces rather than full-window panels.
- Prefer the class export when another primitive already owns the accessible
  content element.
- Keep child content independent; the glass effect belongs to the outer surface.
- Validate changes in DS Viewer over visible background text or marks.

## Wrong use cases
- Do not wrap Radix select, popover, menu, or dialog content with an extra
  TintedGlass element just for styling.
- Do not use TintedGlass as a decorative page section or landing-page card.
- Do not override the edge fade with percent stops; use the fixed tokenized edge
  size.

## Tags
surface, glass, overlay, container, blur
