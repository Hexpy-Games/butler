# ComposerAdjunctPanel

`ComposerAdjunctPanel` is the shared inner structure for panels attached to the
`ComposerCard` adjunct slot.

Use it for composer-owned panels such as workers and todo progress. It keeps the
panel title on the default body text scale, applies the subdued title opacity,
and draws the shared divider between the title and panel content.
The title row is also the collapse control. Clicking it hides or reveals the
panel body while leaving the title row visible.

Do not use it as a standalone card or page section.
