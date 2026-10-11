# ArtifactPreview

ArtifactPreview frames generated artifact content inside Butler panels.

Use it for in-app previews of text, markdown, images, or embedded documents when
the surrounding feature owns loading and error states, but the visual frame must
stay consistent with Butler surfaces.

`ArtifactPreviewFrame` fills the preview width by default. Pass `intrinsicSize`
(CSS pixels) when the content must show at its own size, such as a scrap's
clipped part: the frame takes exactly that size and the preview scrolls when
it is larger.
