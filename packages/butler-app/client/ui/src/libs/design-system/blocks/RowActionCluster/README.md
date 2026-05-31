# RowActionCluster

## What is this block

RowActionCluster is a Butler design-system block for grouping inline action buttons within navigation or list rows. It delegates spacing to `ButtonContainer`.

## When to use this block

Use RowActionCluster when row actions need click isolation. Use `ButtonContainer` directly for adjacent buttons that do not need row-click isolation.

## Container vs Presenter

**RowActionCluster is a presenter block.** It owns click event isolation and uses `ButtonContainer` for action rhythm. It must not import Butler domain handlers or stores.

**Container responsibilities:** Domain components supply IconButton or Button elements with domain-specific handlers and labels.

## Similar blocks

- Use **OverflowActionMenu** when actions should be in a dropdown menu
- Use **ButtonContainer** for non-row adjacent button groups
- Compose with NavRow or ListRow for complete row pattern

## Usage

```tsx
import { RowActionCluster } from "@/butler-ds";

<NavRow
  label="Project"
  actions={
    <RowActionCluster size="icon-sm">
      <IconButton label="Edit" onClick={handleEdit}>
        <Edit />
      </IconButton>
      <IconButton label="Delete" onClick={handleDelete}>
        <Trash />
      </IconButton>
    </RowActionCluster>
  }
/>;
```

## Accessibility

- Wraps accessible IconButton elements
- Stops click propagation to prevent row activation
- Each action has its own label and keyboard access

## Responsive behavior

- Compact horizontal layout
- Works with hover-visibility patterns
- Actions remain accessible on touch devices

## Wrong use cases

- Do not use for toolbar actions; use toolbar-specific layouts
- Do not use when a menu would be more appropriate (3+ actions)
- Do not nest interactive elements beyond one level

## Tags

actions, buttons, row, inline, cluster
