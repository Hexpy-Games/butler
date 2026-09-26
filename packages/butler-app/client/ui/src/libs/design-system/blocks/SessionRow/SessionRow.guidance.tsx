import type { ShowcaseGuidance } from "../../showcase";
import { IconButton } from "../../components/IconButton";
import { MoreHorizontal } from "../../components/Icons";
import { NavRow } from "../NavRow";
import { SessionRow } from "./SessionRow";

// #region recipe: Recent session row
function RecentSession() {
  return (
    <SessionRow title="Release checklist review" description="butler · Desktop client polish" meta="5 min ago"
      actions={<IconButton label="Session menu" aria-haspopup="menu"><MoreHorizontal size="md" /></IconButton>} onSelect={() => undefined} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A session row with title, optional project line and time that swaps to actions on hover.",
  whenToUse: ["Recent or Running conversation lists with a second line and a time"],
  whenNotToUse: [
    { when: "Tree rows in the sidebar (the product uses NavRow today)", use: "NavRow" },
    { when: "A non-session data row", use: "ListRow" },
  ],
  recipes: [{ name: "Recent session row", description: "meta shows at rest; actions replace it on hover or focus.", render: () => <RecentSession /> }],
  doDont: [
    {
      do: { caption: "Time trails the title; the project line sits under it.", render: () => <RecentSession /> },
      dont: { caption: "Cramming project and time into a NavRow label truncates both.", render: () => <NavRow label="Release checklist review · butler · 5 min ago" /> },
    },
  ],
  content: ["Relative times (5 min ago / 5분 전); project line is Project · Folder."],
  accessibility: ["The row is one button (onSelect); actions are separate buttons that stop propagation."],
  tokens: ["--sidebar-row-height", "--selection-strong", "--text-tertiary"],
};
