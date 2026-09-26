import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Collapsible } from "../../components/Collapsible";
import { Wrench } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { DisclosureRow } from "./DisclosureRow";

// #region recipe: Expandable tool call
function ToolCall() {
  const [open, setOpen] = useState(false);
  return (
    <DisclosureRow icon={<Wrench size="md" />} title="Search" description="Project files" open={open} onToggle={() => setOpen(!open)}>
      <Typo.Caption>Read-only file search completed: 14 matches in 6 files.</Typo.Caption>
    </DisclosureRow>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A row with title, description and meta that expands details below it with the reveal motion.",
  whenToUse: ["Tool calls, changed files, source details and log entries that expand"],
  whenNotToUse: [
    { when: "A sidebar folder", use: "CollapsibleNavGroup" },
    { when: "Expanding arbitrary content without a row", use: "Collapsible" },
  ],
  recipes: [{ name: "Expandable tool call", description: "The caller owns open; surface=\"plain\" drops the selection fill.", render: () => <ToolCall /> }],
  doDont: [
    {
      do: { caption: "The row states what expands before it opens.", render: () => <ToolCall /> },
      dont: { caption: "A bare Collapsible gives no title or icon alignment.", render: () => <Collapsible open><Typo.Caption>Details with no row</Typo.Caption></Collapsible> },
    },
  ],
  content: ["Title is the object (Search, file path); meta is a short count (+12 −3)."],
  accessibility: ["The trigger has aria-expanded and aria-controls (controlsId)."],
  tokens: ["--selection", "--motion-base", "--icon-size-md"],
};
