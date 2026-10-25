# ArtifactPreview

ArtifactPreview frames generated artifact content inside Butler panels.

Use it for in-app previews of text, markdown, images, or embedded documents when
the surrounding feature owns loading and error states, but the visual frame must
stay consistent with Butler surfaces.

`ArtifactPreviewFrame` fills the preview width by default. Pass `intrinsicSize`
(CSS pixels) when the content must show at its own size, such as a scrap's
clipped part: the frame takes exactly that size and the preview scrolls when
it is larger.

## Surfaces

- `surface="card"` (default): a bordered box with its own scroll and height
  bounds, for a preview inside a panel or dialog.
- `surface="page"`: no border, background, padding, inner scroll or height
  bounds. The content flows in the host's scroll as a reading page, and an
  image sits frameless with its own corner radius. Use it when the host is
  itself the reading surface, such as a file viewer docked in
  `AdaptiveShellSplit`'s right slot.

The host gives the reading width and insets. A docked viewer composes it as:

```tsx
<AdaptiveShellCard aria-label="Files">
  <Stack fill gap="none">
    {/* file header, then <Separator space="none" /> */}
    <ScrollArea fill>
      <PageContainer width="narrow" gutter="2xl">
        <Box paddingY="2xl">
          <Box padding="2xl">
            <ArtifactPreview surface="page">{/* MarkdownContent, ArtifactPreviewPre or ArtifactPreviewImage */}</ArtifactPreview>
          </Box>
        </Box>
      </PageContainer>
    </ScrollArea>
  </Stack>
</AdaptiveShellCard>
```

`PageContainer width="narrow"` caps the page at the 760px reading width; its
`2xl` gutter plus the inner `Box padding="2xl"` put the text 48px in from the
viewer's sides, and the two `2xl` paddings put it 48px under the header line
and above the page end.
