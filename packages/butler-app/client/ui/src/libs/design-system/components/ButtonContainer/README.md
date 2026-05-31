# ButtonContainer

## What It Is

`ButtonContainer` is the required primitive for adjacent Butler buttons. It
applies the canonical gap for the button size so repeated actions do not drift
between screens.

## When To Use

Use it whenever two or more `Button` or `IconButton` controls are placed next
to each other.

```tsx
<ButtonContainer size="sm">
  <Button size="sm" variant="outline">
    Import
  </Button>
  <Button size="sm">Create</Button>
</ButtonContainer>
```

## Rules

- Pass the intended button `size` to `ButtonContainer`.
- Use the same `size` on every contained button.
- Use `justify`, `cross`, `wrap`, and `align` props for layout, as with
  `Stack`.

## Wrong Use Cases

- Do not place adjacent buttons directly in `Stack`.
- Do not mix `sm` and `default` buttons in the same container.
- For row action clusters that need row-click propagation isolation, use
  `RowActionCluster`; it delegates spacing to `ButtonContainer`.

## Tags

buttons, actions, spacing, layout
