import type { ShowcaseGuidance } from "../../showcase";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { Folder, LayoutDashboard, MessageSquarePlus } from "../../components/Icons";
import { NavRow } from "../NavRow";
import { RowActionCluster } from "./RowActionCluster";

// #region recipe: Project row actions
function ProjectRow() {
  return (
    <NavRow icon={<Folder size="md" />} label="butler" onClick={() => undefined} actionsVisibility="hover" actions={(
      <RowActionCluster>
        <IconButton label="Project dashboard"><LayoutDashboard size="md" /></IconButton>
        <IconButton label="New chat in project"><MessageSquarePlus size="sm" /></IconButton>
      </RowActionCluster>
    )} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Trailing icon actions for a row, sized to the row's action target and isolated from row clicks.",
  whenToUse: ["Two or three icon actions at the end of a navigation row"],
  whenNotToUse: [
    { when: "Buttons with text", use: "ButtonContainer" },
    { when: "More than three actions", use: "OverflowActionMenu" },
  ],
  recipes: [{ name: "Project row actions", description: "Buttons follow --sidebar-action-size; clicks never reach the row.", render: () => <ProjectRow /> }],
  doDont: [
    {
      do: { caption: "The cluster stops propagation for every action.", render: () => <ProjectRow /> },
      dont: {
        caption: "A plain ButtonContainer lets clicks select the row too.",
        render: () => <NavRow label="butler" onClick={() => undefined} actions={<ButtonContainer size="icon-sm"><IconButton label="Project dashboard"><LayoutDashboard size="md" /></IconButton></ButtonContainer>} />,
      },
    },
  ],
  content: ["Each IconButton label names its action and object."],
  accessibility: ["Keep the actions reachable by keyboard (hover-only visibility still shows on focus)."],
  tokens: ["--sidebar-action-size", "--space-xs"],
};
