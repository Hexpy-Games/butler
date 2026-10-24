# TagColorSwatches

## What is this block
`TagColorSwatches` picks a Tag label tone (`gray`, `red`, `orange`, `yellow`,
`green`, `teal`, `blue`, `purple`). Each round swatch is a miniature of the Tag
it makes: the tone's fill and border with a dot in its text color, or a check
when chosen.

## When to use this block
Choosing the color of a user's tag when it is created or edited, next to a
preview `Tag`.

## Container vs Presenter
The App passes the stored tone (`value`), saves `onValueChange`, and supplies
every tone's name in its language (`labels`) plus the group name
(`ariaLabel`). The block holds no copy and no state.

## Usage

```tsx
<TagColorSwatches ariaLabel="색" labels={toneNames} value={tag.color} onValueChange={setColor} />
<Tag tone={tag.color}>{tag.name}</Tag>
```

## Accessibility
A `radiogroup`; each swatch is a `radio` named by its label, also shown as its
tooltip. Arrow keys move and select, Home/End jump; only the chosen swatch is
in the tab order. Selection is a ring plus a check. The selection and focus
rings draw inside each swatch's box, so a clipping container never cuts them.

## Responsive behavior
Swatches wrap. On touch each swatch grows to `--control-hit-target`.

## Wrong use cases
- Do not store a color value; store the tone name.
- Do not use it for arbitrary colors (use `ColorSwatchInput`).

## Tags
tag, color, swatch, tone, label, picker
