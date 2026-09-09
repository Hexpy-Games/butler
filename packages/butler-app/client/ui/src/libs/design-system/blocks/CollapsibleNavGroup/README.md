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
- Default child rows keep the same width and horizontal alignment as the group row
- Use `indented` for an explicitly hierarchical tree: each child level is inset
  by `--nav-tree-indent` (defaults to `--space-lg`, 16px). Supplied header actions remain visible in this mode.
- Smooth expand/collapse animation
- Optional `stickyDepth` pins a header inside its branch, stacking below that
  many ancestor rows. Use a shared scrolling list outside the groups. This mode
  removes intermediate overflow clipping and uses immediate collapse so native
  sticky positioning works; existing non-sticky groups retain their animation.
  Inside SidebarShell's sticky layout, the shell measures the declared child
  boundary and clips it below this header. This permits a transparent
  `--nav-sticky-surface` without overlapping text or losing native vibrancy.
  Outside that shell, use an opaque sticky surface to occlude scrolling content.

## Wrong use cases

- Do not use for non-navigation collapsible content; use Accordion or details/summary
- Do not nest more than 2 levels deep
- Do not use when all groups should always be visible

## Tags

navigation, collapsible, expandable, hierarchy, tree
