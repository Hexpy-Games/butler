# OverflowActionMenu

## What is this block

OverflowActionMenu is a Butler design-system block for dropdown menus containing overflow actions accessed via a "more" button.

## When to use this block

Use OverflowActionMenu for row actions that don't fit inline, secondary commands, or when you have 3+ actions on a single item.

## Container vs Presenter

**OverflowActionMenu is a presenter block.** It owns menu rendering and item layout. It must not import Butler domain logic or stores.

**Container responsibilities:** Domain components supply menu items array with labels from app copy and domain-specific onSelect handlers.

## Similar blocks

- Use **RowActionCluster** for 1-2 inline actions that should always be visible
- Use **DropdownMenu** primitive when you need full control over menu structure
- Use **ContextMenu** for right-click actions

## Usage

```tsx
import { OverflowActionMenu } from "@/butler-ds";

<OverflowActionMenu
  items={[
    { icon: <Edit />, label: "Rename", onSelect: handleRename },
    { icon: <Trash />, label: "Delete", onSelect: handleDelete, variant: "destructive" },
  ]}
/>
```

## Accessibility

- Trigger has accessible label
- Keyboard navigable menu
- Supports destructive action variants

## Responsive behavior

- Compact trigger button
- Menu positioned to avoid overflow
- Works on touch devices

## Wrong use cases

- Do not use for primary actions; use Button
- Do not use for form selection; use Select
- Do not use when all actions fit inline comfortably

## Tags

menu, overflow, actions, dropdown, more
