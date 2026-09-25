# Layout

## What is this component
`Layout` holds the shared layout item props (`LayoutItemProps`) that describe how an element sits inside its `Stack` or `Grid` parent. It has no visual of its own.

## Props

| Prop | Values | Effect |
| --- | --- | --- |
| `grow` | `boolean` | `flex-grow: 1` |
| `shrink` | `boolean` | `false` keeps the item from shrinking |
| `basis` | `auto`, `content`, `0`, `xs`, `sm`, `md`, `lg` | Flex basis; named sizes use `--layout-basis-*` (160/200/260/460px) |
| `minWidth` | `0`, `auto` | `0` lets a flex item shrink below its content (truncation) |
| `alignSelf` | `start`, `center`, `end`, `stretch`, `baseline` | Cross-axis alignment of this item |
| `span` | `1`, `2`, `3`, `full` | Grid children only: columns to span |

## How to use this component
`Stack`, `Inline` and every `Typo` variant accept the props directly. Wrap anything else in `Stack.Item` or `Grid.Item`:

```tsx
<Stack align="row" justify="between" gap="md" wrap>
  <Stack gap="xs" grow basis="md" minWidth="0">{details}</Stack>
  <Typo.Body align="end" numeric="tabular" wrap="nowrap">{total}</Typo.Body>
</Stack>
<Stack.Item shrink={false}>{action}</Stack.Item>
<Grid.Item span="full">{summary}</Grid.Item>
```

## Wrong use cases
- Do not write `style={{ flex: "1 1 260px", minWidth: 0 }}` or a CSS module class for flex item rules; use the props.
- Do not use `span` outside a Grid.

## Tags
layout, item-props, grow, basis, span
