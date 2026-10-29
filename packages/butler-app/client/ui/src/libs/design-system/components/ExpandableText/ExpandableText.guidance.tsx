import type { ShowcaseGuidance } from "../../showcase";
import { DisclosureRow } from "../../blocks/DisclosureRow";
import { IconButton } from "../IconButton";
import { Trash2 } from "../Icons";
import { Stack } from "../Stack";
import { ExpandableText } from "./ExpandableText";

const instruction = "Answer in short paragraphs, put code in fenced blocks, and when a task touches files list each changed path at the end, so I can review the diff first.";

// #region recipe: List row with a trailing action
function InstructionRow() {
  return (
    <Stack align="row" cross="start" gap="md">
      <Stack.Item grow minWidth="0">
        <ExpandableText id="instruction-1" meta="All chats · Expires in 5 days">{instruction}</ExpandableText>
      </Stack.Item>
      <IconButton label="Delete" aria-describedby="instruction-1"><Trash2 size="md" /></IconButton>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "User text clamped to one to three lines that opens in place, only when it really overflows.",
  whenToUse: ["A list of user-written text (instructions, notes) where most entries are short", "Long text beside a trailing action that must not move"],
  whenNotToUse: [
    { when: "A row that reveals other content or controls", use: "DisclosureRow" },
    { when: "A section that hides a group of fields", use: "Collapsible" },
  ],
  recipes: [{ name: "List row with a trailing action", description: "The text grows; the action stays at the row top.", render: () => <InstructionRow /> }],
  doDont: [
    {
      do: { caption: "The first line and the caption stay put; the text grows below them.", render: () => <InstructionRow /> },
      dont: {
        caption: "A disclosure row swaps the title for a body, so the first line jumps.",
        render: () => <DisclosureRow title={instruction.slice(0, 40)}>{instruction}</DisclosureRow>,
      },
    },
  ],
  content: [
    "children is plain text; line breaks are kept and long words or URLs wrap anywhere.",
    "meta is one short caption (\"All chats · Expires in 5 days\"); it truncates with an ellipsis, never wraps.",
  ],
  accessibility: [
    "Only overflowing text is interactive: role=button, tabIndex 0, aria-expanded, aria-controls, Enter/Space.",
    "Text that fits has no role and no tab stop; its chevron slot stays empty.",
    "The focus ring is the DS default and fits in --focus-ring-room, so a ScrollArea never clips it.",
    "Reduced motion opens and closes instantly.",
  ],
  tokens: [
    "--typo-body-size", "--typo-body-line-height", "--typo-caption-size", "--typo-caption-line-height", "--text-secondary", "--text-tertiary",
    "--motion-base", "--motion-exit-base", "--motion-fast", "--motion-ease-standard", "--motion-ease-accelerate", "--focus-ring-room",
  ],
};
