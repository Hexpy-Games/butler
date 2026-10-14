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
  (`IconButton`s, a save `DoneIconButton` and a `CopyButton`, set in a
  `ButtonContainer size="icon-sm"`)

## Orientation
The card's own width decides (a container query on the article, not the
viewport): below 340px it stacks (picture on top) and the footer shows only the
read time beside closer-set actions, so a short time stays whole down to a
168px card; at 340px and up it is a row with a 112px picture on the start
side, the footer across the full width, the text whole and the site icon and
name added to the source line. Cards in one grid row share
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
      actions={<><DoneIconButton icon={<Scrap size="sm" />} label={t("save")} doneLabel={t("saved")} onAction={() => save(item)} /><CopyButton label={t("copy")} copiedLabel={t("copied")} text={copyText(item)} /></>}
      onOpen={() => openLink(item.url)} />
  ))}
</Grid>
```

## Hit areas
With `onOpen` the whole card opens the item: the title's target stretches over
the card and the card shows the hover. With `onMediaOpen` the picture is its
own target (a zoom-in cursor) that opens the image viewer. The source line,
Show more and the actions sit above the card target and keep their own
actions; the card's hover drops while the pointer is on one of them.

## Loading: ItemCardSkeleton
`ItemCardSkeleton` is the loading shape of a card, built on the same `Card`,
grid tracks and container query: the picture box at the set's aspect
(`media`, default `1:1`; `null` for cards without a picture), three text lines
(subtitle, title, facts, each exactly its role's line height) and the footer
line, held at the actions' height by one invisible `IconButton`, so it
follows the hit-target sizes on phones and coarse pointers. It is the exact
box of a card with a subtitle, a one-line title, facts and a footer, in the
vertical and the row orientation: swapping it for that card shifts nothing.
The sheen stops under reduced motion. It is `aria-hidden`; `label` makes it
a `role="status"` that announces loading once.

```tsx
<Grid ref={gridRef} columns={columns} cross={settled ? "stretch" : "start"} gap="sm">
  {items.map((item) => <AnswerCard key={item.key} item={item} />)}
  {open ? <ItemCardSkeleton media={block.media} /> : null}
</Grid>
```

While a list streams in, one skeleton holds the next slot and the grid uses
`cross="start"`, so a taller new card never stretches earlier ones. When the
list closes, `settleGrid` (see `Grid`) applies the final columns and
`cross="stretch"` once: a column change dips the grid's opacity briefly and
the height eases to its new size.

## Accessibility
The article is labelled by the title. The title is the card's one tab stop
that opens the item. With `onMediaOpen` the picture is a second tab stop named
by `mediaLabel`; without it the picture opens the item for the pointer only.
The source line is a button named by `source.label`.

## Responsive behavior
Fills its grid cell; orientation follows its own width (340px).

## Wrong use cases
- Do not add subject-specific props or variants (a price card, a paper card).
- Do not pass markdown or HTML as text; it is plain.
- Do not pre-crop pictures; `MediaFrame` contains them.

## Tags
item, card, answer, result, picture, value, source, provenance
