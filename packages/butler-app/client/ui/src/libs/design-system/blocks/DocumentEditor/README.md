# DocumentEditor

## What is this block
An editable document page: a title row with header actions, one status line,
and the editable body in MarkdownContent's document typography, so a document
reads the same while it is edited as when it is read. The caller owns the
editor engine (Lexical in the app) and renders it into the page.

| Export | Props |
| --- | --- |
| `DocumentEditor` | `title` (null inside a Dialog whose header shows it: no empty title row), `note` (the status line), `actions`, `menuActions`, `menuLabel`, `menuRef`, `controls`, `children` (the editable root), `formatBar` |
| `documentEditorClasses` | Class names for the engine's nodes: `root`, `bold`, `italic`, `blockEmbed` |
| `DocumentBlockEmbed` | A block in the text (`selected` outlines it): not editable as text, one unit |

## Title line
The title and the actions share one line, one control tall:
`--control-height-md`, rising to `--control-hit-target` wherever controls grow
to the touch target (a phone width or a coarse pointer, as IconButton does).
The title is centred on that line with the actions, at every width; a title
role taller than a control grows the line and the actions stay centred on it.
The status line (`note`) is a second row under the title, so showing or
hiding it never moves the title or the actions.

## Narrow title line
Pass `menuActions`, the same document actions as flat `OverflowActionMenu`
items, with `menuLabel`. When the title line is narrower than 30rem (a
container query on the header, not the viewport), the inline `actions` fold
into the ⋯ menu so the title keeps the width; wider lines keep them inline
and show no ⋯. `controls` (close) stay visible at every width, and a back
control belongs in `title` before the heading. An item that opens a popover
anchors it to ⋯ through `menuRef` (a `PopoverAnchor` `virtualRef`; at 640px
and narrower the Popover is its mobile sheet) and returns focus to the ⋯
trigger when it closes.

## In a dialog
Inside a Dialog whose header already shows the title and actions, pass
`title={null}` and no `actions`: the editor renders no title row (only the
note, when there is one), and the page's first block drops its top margin, so
the body starts at the dialog's body spacing.

## Butler editing
A paragraph Butler is changing takes `data-butler-editing="true"`: a wash of
the Butler inks with an ink rule at its start edge, fading in over
`--motion-slow`. Set it to `"false"` when the change lands and it fades out.

## When to use this block
- A 버틀러 document in the 서랍, in the side panel next to the chat, or full screen on a phone.
- Not for read-only files: use `DocumentReader` or `ArtifactPreview`.

## How to use this block
```tsx
import { DocumentEditor, documentEditorClasses, DocumentFormatBar } from "@/butler-ds";

<DocumentEditor title={<TitleField />} note="저장됨" actions={<HeaderActions />} formatBar={<DocumentFormatBar … />}>
  <ContentEditable className={documentEditorClasses.root} aria-label="문서" />
</DocumentEditor>
```

## Accessibility
- The editable root is the field: name it and expose it as a multi-line textbox.
- Block embeds are not editable as text; they are selected and moved as one unit.

## Tags
document, editor, markdown, butler editing
