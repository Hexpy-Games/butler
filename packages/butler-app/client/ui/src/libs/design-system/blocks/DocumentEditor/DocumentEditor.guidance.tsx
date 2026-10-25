import type { ShowcaseGuidance } from "../../showcase";
import { IconButton } from "../../components/IconButton";
import { Download, History, X } from "../../components/Icons";
import { Inline } from "../../components/Inline";
import { Typo } from "../../components/Typo";
import { DocumentEditor, documentEditorClasses } from "./DocumentEditor";

// #region recipe: An editable document
function Editable() {
  return (
    <DocumentEditor title={<Typo.H2>October budget</Typo.H2>} note="Saved">
      <div className={documentEditorClasses.root} contentEditable suppressContentEditableWarning>
        <p>Spending rose 8% this month.</p>
      </div>
    </DocumentEditor>
  );
}
// #endregion

// #region recipe: Title line
function TitleLine() {
  return (
    <DocumentEditor title={<Typo.PanelTitle as="h2" truncate>October budget</Typo.PanelTitle>} note="Saved"
      actions={<Inline gap="xs" wrap={false}><IconButton label="Versions"><History size="sm" /></IconButton><IconButton label="Export"><Download size="sm" /></IconButton></Inline>}
      menuActions={[{ icon: <History size="sm" />, label: "Versions", onSelect: () => {} }, { icon: <Download size="sm" />, label: "Export as Markdown", onSelect: () => {} }]}
      menuLabel="More" controls={<IconButton label="Close"><X size="sm" /></IconButton>}>
      <div className={documentEditorClasses.root} contentEditable suppressContentEditableWarning>
        <p>Spending rose 8% this month.</p>
      </div>
    </DocumentEditor>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "An editable document page: title row, one status line, header actions and the editable body in MarkdownContent's document typography, with block embeds and Butler's editing highlight.",
  whenToUse: ["A 버틀러 document the user edits (서랍 문서, the side panel next to the chat)"],
  whenNotToUse: [
    { when: "Reading a file or artifact", use: "DocumentReader" },
    { when: "Writing a message", use: "ComposerCard" },
  ],
  recipes: [{ name: "An editable document", description: "The caller's editor engine renders into the page; `documentEditorClasses` names its node classes.", render: () => <Editable /> },
    { name: "Title line", description: "The title line is one control tall (--control-height-md; --control-hit-target wherever controls grow to the touch target), and the title is centred on it with the actions at every width. The status line is a row under the title, so it never moves them. Below a 30rem title line, the document actions fold into ⋯ (menuActions, the same actions as flat items) and `controls` (close) stay; wider lines keep them inline.", render: () => <TitleLine /> },
  ],
  doDont: [
    {
      do: { caption: "One status line: who is editing or when it was saved.", render: () => <Editable /> },
      dont: { caption: "A banner over the page for saving state.", render: () => <Typo.Body>Your document was saved successfully!</Typo.Body> },
    },
    {
      do: { caption: "Title and actions centred on one control-tall line; the status line under the title.", render: () => <TitleLine /> },
      dont: { caption: "Wrapping the title in a custom row to line it up with the actions: the block already centres them.", render: () => <Typo.Body>Title with a hand-tuned top margin</Typo.Body> },
    },
  ],
  content: ["⋯ items name the action in full, one item per choice: 버전 기록, 원래 대화, Markdown으로 내보내기, PDF로 내보내기.", "Status is a few words: 저장됨, 버틀러가 수정 중.", "Paragraphs Butler is changing take data-butler-editing=\"true\"; set it back to \"false\" when the change lands so the wash fades out."],
  accessibility: ["An item that opens a popover anchors it to ⋯ (menuRef) and returns focus to the ⋯ trigger when it closes.", "The editable root is the field: give it an accessible name (aria-label) and role=\"textbox\" with aria-multiline from the editor engine.", "Block embeds are one unit in the text: not editable as text, selectable with the arrow keys."],
  tokens: ["--control-height-md", "--control-hit-target", "--butler-ink-blue", "--butler-ink-purple", "--accent", "--radius-control", "--motion-slow"],
};
