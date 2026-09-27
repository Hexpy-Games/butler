import type { ShowcaseGuidance } from "../../showcase";
import { FileText } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { DocumentTile } from "../DocumentTile";
import { NavRow } from "../NavRow";
import { SplitBrowser } from "./SplitBrowser";

// #region recipe: Spec categories
function SpecCategories() {
  return (
    <SplitBrowser nav={<>
      <NavRow label="Design" badge={2} active onClick={() => undefined} />
      <NavRow label="Runtime" badge={3} onClick={() => undefined} />
    </>}>
      <DocumentTile icon={<FileText size="md" />} title="Design system" meta="specs/" actionLabel="Open" onOpen={() => undefined} />
      <DocumentTile icon={<FileText size="md" />} title="Tokens" meta="specs/" actionLabel="Open" onOpen={() => undefined} />
    </SplitBrowser>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Categories on the start side and the selected category's items on the end side, in one surface.",
  whenToUse: ["Browse documents grouped by category (specs by area)"],
  whenNotToUse: [
    { when: "Items grouped by status", use: "KanbanBoard" },
    { when: "Settings pages", use: "SettingsShell" },
  ],
  recipes: [{ name: "Spec categories", description: "nav holds NavRows (active + badge counts); children hold DocumentTiles.", render: () => <SpecCategories /> }],
  doDont: [
    {
      do: { caption: "Both panes scroll at one height; the divider separates them.", render: () => <SpecCategories /> },
      dont: { caption: "One long list hides the categories.", render: () => <Stack gap="sm"><DocumentTile icon={<FileText size="md" />} title="Design system" meta="specs/" actionLabel="Open" onOpen={() => undefined} /></Stack> },
    },
  ],
  content: ["Category names are short; badges count items."],
  accessibility: ["The active NavRow carries aria-current; items follow in reading order."],
  tokens: ["--split-browser-height", "--space-md", "--line"],
};
