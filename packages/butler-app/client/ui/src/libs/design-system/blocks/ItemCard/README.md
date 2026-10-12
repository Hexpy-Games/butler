# ItemCard

## What is this block
`ItemCard` is one found item of any subject (a paper, a place, a recipe, a
product, a code library) on a `Card padding="sm"` inside an `article`:

- `media`: a `MediaFrame` (the container picks one aspect for the set)
- `eyebrow` (an accent `Tag`: rank or reason), `subtitle`, `title` (2 lines)
- `value`: `amount`, a struck-through `was` (with `wasLabel` for screen
  readers) and a `note` line
- `facts`: one dot-separated line that wraps
- `text`: plain text, clamped to four lines on a vertical card; with
  `showMoreLabel` and `showLessLabel` an inline button reveals the rest
- footer: `source` (favicon, “site · read time”, opens the page) and `actions`
  (`IconButton`s and `CopyButton`s, set in a `ButtonContainer size="icon-sm"`)

## Orientation
The card's own width decides (a container query on the article, not the
viewport): below 340px it stacks (picture on top); at 340px and up it is a row
with a 112px picture on the start side, the footer across the full width, the
text whole and the site added to the source line. Cards in one grid row share
the height and their footers line up.

## When to use this block
Answer cards and any set of results the user compares or chooses between, in a
`Grid` the container sizes (one column on phones).

## Container vs Presenter
The block has no domain props. The container maps records to props, formats
values (currency, units, times) and owns open, save and copy. Nothing about one
subject (prices, citations, ratings) is built in.

## Usage

```tsx
<Grid columns={{ base: "3", compact: "1" }} gap="md">
  {items.map((item) => (
    <ItemCard key={item.key} title={item.title} eyebrow={item.label} subtitle={item.sub}
      media={<MediaFrame aspect="4:5" src={item.imageUrl} alt={item.alt} />}
      value={item.value && { amount: format(item.value), was: item.value.was && format(item.value, item.value.was), wasLabel: t("before"), note: item.value.note }}
      facts={item.facts} text={item.text} showMoreLabel={t("more")} showLessLabel={t("less")}
      source={item.url ? { site: host(item.url), checked: checkedLabel(item.checked), label: sourceLabel(item), onOpen: () => openLink(item.url) } : undefined}
      actions={<><IconButton label={t("save")} onClick={() => save(item)}><Scrap size="sm" /></IconButton><CopyButton label={t("copy")} copiedLabel={t("copied")} text={copyText(item)} /></>}
      onOpen={() => openLink(item.url)} />
  ))}
</Grid>
```

## Accessibility
The article is labelled by the title. The title is the one tab stop that opens
the item; the picture opens it for the pointer only. The source line is a
button named by `source.label`.

## Responsive behavior
Fills its grid cell; orientation follows its own width (340px).

## Wrong use cases
- Do not add subject-specific props or variants (a price card, a paper card).
- Do not pass markdown or HTML as text; it is plain.
- Do not pre-crop pictures; `MediaFrame` contains them.

## Tags
item, card, answer, result, picture, value, source, provenance
