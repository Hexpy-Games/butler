import type { ShowcaseGuidance } from "../../showcase";
import { Bold, Heading, ListBullet, Plus } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";
import { Inline } from "../../components/Inline";
import { DocumentFormatBar } from "./DocumentFormatBar";

const ACTIONS = [
  { id: "bold", label: "Bold", icon: <Bold size="sm" />, pressed: true, onPress: () => undefined },
  { id: "heading", label: "Heading", icon: <Heading size="sm" />, onPress: () => undefined },
  { id: "list", label: "List", icon: <ListBullet size="sm" />, onPress: () => undefined },
  { id: "block", label: "Add block", icon: <Plus size="sm" />, onPress: () => undefined },
];

// #region recipe: Over a selection
function OverSelection() {
  return <div style={{ height: 72 }}><DocumentFormatBar label="Format" anchor={{ top: 120, bottom: 140, left: 120, width: 120 }} actions={ACTIONS} /></div>;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The floating format bar over a document selection: 굵게, 제목, 목록, 블록 추가, centred above the selection and kept on screen.",
  whenToUse: ["Formatting a selection in a DocumentEditor"],
  whenNotToUse: [
    { when: "Actions on a whole block", use: "BlockActionFrame" },
    { when: "Composer formatting", use: "ComposerCard" },
  ],
  recipes: [{ name: "Over a selection", description: "Pass the selection's viewport box; a format that is on is pressed.", render: () => <OverSelection /> }],
  doDont: [
    {
      do: { caption: "Four short actions that float over the selection.", render: () => <OverSelection /> },
      dont: { caption: "A fixed toolbar row above the page takes room from the text.", render: () => <Inline>{ACTIONS.map((action) => <IconButton key={action.id} label={action.label}>{action.icon}</IconButton>)}</Inline> },
    },
  ],
  content: ["Four actions at most; each label is one word or two.", "A format that is on for the selection is pressed."],
  accessibility: ["role=\"toolbar\" with a label; pressing a button keeps the text selection (mouse-down does not take focus).", "Keyboard users format with the editor's shortcuts; the bar is a pointer aid."],
  tokens: ["--z-popover", "--radius-pill", "--space-xs", "--motion-fast", "--motion-distance-sm"],
};
