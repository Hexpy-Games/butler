# DocumentEditor

## What is this block
An editable document page: a title row with header actions, one status line,
and the editable body in MarkdownContent's document typography, so a document
reads the same while it is edited as when it is read. The caller owns the
editor engine (Lexical in the app) and renders it into the page.

| Export | Props |
| --- | --- |
| `DocumentEditor` | `title`, `note` (the status line), `actions`, `children` (the editable root), `formatBar` |
| `documentEditorClasses` | Class names for the engine's nodes: `root`, `bold`, `italic`, `blockEmbed` |
| `DocumentBlockEmbed` | A block in the text (`selected` outlines it): not editable as text, one unit |

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
