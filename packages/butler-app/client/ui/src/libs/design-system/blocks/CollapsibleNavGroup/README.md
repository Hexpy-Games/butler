# CollapsibleNavGroup

## What is this block

CollapsibleNavGroup is a Butler design-system block for expandable/collapsible navigation groups like project folders with sessions.

## When to use this block

Use CollapsibleNavGroup for hierarchical navigation like projects containing sessions, folders containing files, or any expandable nav structure.

## Container vs Presenter

**CollapsibleNavGroup is a presenter block.** It owns expansion state rendering, animation, and layout. It must not import Butler domain data or stores.

**Container responsibilities:** Domain components manage expanded state (via useState or store), provide toggle handler, map child items, and supply group labels.

## Similar blocks

- Use **NavSection** for non-collapsible section grouping
- Use **NavRow** for simple flat navigation items
- Do not confuse with Accordion primitive (for content, not navigation)

## Usage

```tsx
import { CollapsibleNavGroup, NavRow } from "@/butler-ds";

const [expanded, setExpanded] = useState(true);

<CollapsibleNavGroup
  icon={<Folder />}
  label="My Project"
  expanded={expanded}
  onToggle={() => setExpanded(!expanded)}
>
  <NavRow label="Session 1" />
  <NavRow label="Session 2" />
</CollapsibleNavGroup>
```

## Accessibility

- Uses aria-hidden for collapsed content
- Header is keyboard accessible
- Expansion state is screen-reader friendly

## Responsive behavior

- Adapts to sidebar width
- Child rows keep the same width and horizontal alignment as the group row
- Smooth expand/collapse animation

## Wrong use cases

- Do not use for non-navigation collapsible content; use Accordion or details/summary
- Do not nest more than 2 levels deep
- Do not use when all groups should always be visible

## Tags

navigation, collapsible, expandable, hierarchy, tree
