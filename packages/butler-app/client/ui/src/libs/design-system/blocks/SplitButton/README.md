# SplitButton

## What is this block
`SplitButton` joins a primary action to a menu of related actions: the left
half runs the action, the right half (a chevron) opens a `DropdownMenu`.
Both halves are DS `Button`s sharing one outline.

## When to use this block
Use it when one action is the common choice and a few close variants exist
("Allow once" / "Allow for this conversation", "Run now" / "Run later").

## Props
`text`, `onClick`, `size` (`sm | default`), `variant` (`primary | outline`),
`disabled`, `menuLabel` (accessible name of the arrow), `menuSide`
(`top | bottom`), `items[{ key, label, description?, onSelect, disabled? }]`.
The arrow disables itself when every item is disabled.

## Container vs Presenter
The product passes copy, the actions and whether each item is available;
the block owns the joined shape, the menu and its item layout.

## Similar blocks
- `ButtonContainer`: spacing for independent buttons (host a SplitButton in it).
- `OverflowActionMenu`: a menu without a primary action.

## Usage

```tsx
import { Button, ButtonContainer, SplitButton } from "@/butler-ds";

<ButtonContainer size="sm" justify="end">
  <Button size="sm" variant="secondary" text={copy.deny} onClick={deny} />
  <SplitButton size="sm" text={copy.allowOnce} onClick={allow} menuLabel={copy.allowScope}
    menuSide="top" disabled={pending}
    items={[{ key: "conversation", label: copy.allowConversation,
      description: [scope.description, copy.allowDescription], onSelect: allowConversation }]} />
</ButtonContainer>
```

## Accessibility
The halves sit in a `role="group"`; the arrow needs `menuLabel` because it
shows only a chevron. The menu is a Radix menu (arrow keys, Escape).

## Responsive behavior
The arrow is at least the control hit target wide (44px on coarse pointers);
the menu is capped at the viewport width.

## Wrong use cases
- Do not use it for two equal actions; use two Buttons in a ButtonContainer.
- Do not restyle the halves from product CSS.

## Tags
action, button, menu, split, approval
