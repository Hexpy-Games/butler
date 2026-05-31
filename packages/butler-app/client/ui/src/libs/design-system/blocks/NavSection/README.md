# NavSection

## What is this block

NavSection is a Butler design-system block for grouping navigation items under a titled section with optional actions.

## When to use this block

Use NavSection for sidebar sections like "Projects", "Chats", or "Settings" that group related navigation items.

## Container vs Presenter

**NavSection is a presenter block.** It owns section layout, title display, and action positioning. It must not import Butler domain data, stores, or app copy.

**Container responsibilities:** Domain components provide section title from app copy, fetch and map child nav items, and supply action handlers.

## Similar blocks

- Use **FormSection** for form field groupings, not navigation
- Use **Section** primitive for general content sections without navigation semantics
- Use **Stack** when you need simple stacking without section semantics

## Usage

```tsx
import { NavSection, NavRow } from "@/butler-ds";

<NavSection title="Projects" actions={<CreateButton />}>
  <NavRow label="Project 1" />
  <NavRow label="Project 2" />
</NavSection>
```

## Accessibility

- Uses semantic `<section>` element
- Title uses SectionTitle typography for visual hierarchy
- Actions are keyboard accessible

## Responsive behavior

- Adapts to sidebar width
- Title and actions stack responsively
- Child items inherit section width

## Wrong use cases

- Do not use NavSection for form sections; use FormSection
- Do not use NavSection for non-navigation content grouping
- Do not nest NavSections deeply (max 1 level recommended)

## Tags

navigation, section, sidebar, grouping
