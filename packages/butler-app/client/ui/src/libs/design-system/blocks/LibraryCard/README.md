# LibraryCard

## What is this block
`LibraryCard` is one library (서랍) item on a `Card` with a media slot: an image,
a quote or a document preview at 16:10, a kind tag, the title with its source
and a ⋯ menu.

## When to use this block
Use it in 3- or 4-column `Grid`s on the library page and the new-tab page.

## Container vs Presenter
The App maps saved items to media, title, meta and menu actions.

## Usage

```tsx
<Grid columns="4" gap="md">{items.map((item) => <LibraryCard key={item.id} media={item.media} title={item.title} meta={item.meta} tag={item.kind} menu={menu(item)} onOpen={() => open(item)} />)}</Grid>
```

## Accessibility
Media and title are one button named by the title; the menu is its own
button.

## Responsive behavior
The card fills its grid cell; the media keeps 16:10.

## Wrong use cases
- Do not make the whole card a button with the menu inside it.

## Tags
library, scrap, card, grid
