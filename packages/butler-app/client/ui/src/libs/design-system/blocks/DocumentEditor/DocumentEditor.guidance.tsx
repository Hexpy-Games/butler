import type { ShowcaseGuidance } from "../../showcase";
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

export const guidance: ShowcaseGuidance = {
  purpose: "An editable document page: title row, one status line, header actions and the editable body in MarkdownContent's document typography, with block embeds and Butler's editing highlight.",
  whenToUse: ["A 버틀러 document the user edits (서랍 문서, the side panel next to the chat)"],
  whenNotToUse: [
    { when: "Reading a file or artifact", use: "DocumentReader or ArtifactPreview" },
    { when: "Writing a message", use: "ComposerCard" },
  ],
  recipes: [{ name: "An editable document", description: "The caller's editor engine renders into the page; `documentEditorClasses` names its node classes.", render: () => <Editable /> }],
  doDont: [
    {
      do: { caption: "One status line: who is editing or when it was saved.", render: () => <Editable /> },
      dont: { caption: "A banner over the page for saving state.", render: () => <Typo.Body>Your document was saved successfully!</Typo.Body> },
    },
  ],
  content: ["Status is a few words: 저장됨, 버틀러가 수정 중.", "Paragraphs Butler is changing take data-butler-editing=\"true\"; set it back to \"false\" when the change lands so the wash fades out."],
  accessibility: ["The editable root is the field: give it an accessible name (aria-label) and role=\"textbox\" with aria-multiline from the editor engine.", "Block embeds are one unit in the text: not editable as text, selectable with the arrow keys."],
  tokens: ["--butler-ink-blue", "--butler-ink-purple", "--accent", "--radius-control", "--motion-slow"],
};
