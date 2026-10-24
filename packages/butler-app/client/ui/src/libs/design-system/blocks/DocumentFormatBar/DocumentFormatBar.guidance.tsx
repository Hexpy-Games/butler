import type { ShowcaseGuidance } from "../../showcase";

export const guidance: ShowcaseGuidance = {
  purpose: "The floating format bar over a document selection: 굵게, 제목, 목록, 블록 추가, centred above the selection and kept on screen.",
  whenToUse: ["Formatting a selection in a DocumentEditor"],
  whenNotToUse: [
    { when: "Actions on a whole block", use: "BlockActionFrame" },
    { when: "Composer formatting", use: "ComposerCard controls" },
  ],
  recipes: [],
  doDont: [],
  content: ["Four actions at most; each label is one word or two.", "A format that is on for the selection is pressed."],
  accessibility: ["role=\"toolbar\" with a label; pressing a button keeps the text selection (mouse-down does not take focus).", "Keyboard users format with the editor's shortcuts; the bar is a pointer aid."],
  tokens: ["--z-popover", "--radius-pill", "--space-xs", "--motion-fast", "--motion-distance-sm"],
};
