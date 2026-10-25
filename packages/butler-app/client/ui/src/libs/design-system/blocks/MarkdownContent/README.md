# MarkdownContent

## What is this component
MarkdownContent provides Butler document typography for rendered markdown.

## When to use this component
Use it when trusted markdown has already been rendered by the product container.

## Where to use this component
Use it in dialogs, inspectors, and dashboard document previews.

## Why to use this component
It keeps document rhythm, code styling, and scrolling behavior consistent without product-level CSS.

## How to use this component
Wrap the rendered markdown tree with MarkdownContent.

## Who can use this component
Any presentational or container component that displays rendered markdown.

## Best practice
Keep data fetching and markdown parsing outside this component.
Major headings following content have section spacing. Only the document's
first heading is flush with the container; nested first-child headings must
not accidentally lose their section margin.

While text streams, pass `useStreamingReveal(text, streaming)` as
react-markdown `rehypePlugins`: recently appended chunks are wrapped in spans
that fade in (opacity only, no layout shift) and settled text renders as
plain markdown.

Links: pass `MarkdownLink` as react-markdown `components.a` (beside
`table: MarkdownTable`) and the favicon resolver as `faviconSrc`:

```tsx
<MarkdownContent faviconSrc={appFaviconSrc}>
  <ReactMarkdown components={{ a: MarkdownLink, table: MarkdownTable }}>{text}</ReactMarkdown>
</MarkdownContent>
```

http(s) links render as an external `InlineReference` (favicon or globe,
title or domain, full URL in the tooltip, opened in the system browser).
mailto, fragment and relative links stay plain anchors as before. Without
`faviconSrc` every external link shows the globe.

Tables scroll inside their own frame with edge fades. A comparison table
built for `MarkdownTable` with row header cells (`<th scope="row">` in
`tbody`; GFM tables never have them) keeps the row labels quiet (secondary
text, no fill) and every cell on one line.

Images keep their natural size and never upscale; a larger one fills the
column width, capped at 60% of the window height (640px at most), aspect
ratio kept. Reply captures (`MessageInlineImage`) put the image in an
`ArtifactPreviewImage` with `onClick` (zoom-in cursor, opens the viewer) and
Open and Save under it. Small images such as badges stay inline in their
sentence.

## Density
`density="compact"` is for dense panes (a task description in a detail aside,
a card): body line height, block gaps one step down (8px, 4px after a heading),
headings at body size and semibold, tighter lists and code frames. The default
`document` keeps the reading rhythm of a reply or a document.

## Wrong use cases
Do not use it for chat message chrome or editable rich text. Use MessageRow or an editor-specific block instead.

## Tags
markdown, document, typography, dialog, dashboard
