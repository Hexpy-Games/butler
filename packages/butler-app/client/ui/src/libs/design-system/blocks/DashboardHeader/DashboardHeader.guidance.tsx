import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { MessageSquarePlus } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { DashboardHeader } from "./DashboardHeader";

// #region recipe: Project dashboard header
function ProjectHeader() {
  return (
    <DashboardHeader title="butler" meta="12 project chats"
      action={<Button variant="outline"><MessageSquarePlus size="md" /> New chat</Button>} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The header of a dashboard or management page: dashboard title, description, meta and the primary action.",
  whenToUse: ["Top of the project dashboard or the automations page"],
  whenNotToUse: [
    { when: "A settings page", use: "SettingsHeader" },
    { when: "A side panel", use: "PanelHeader" },
  ],
  recipes: [{ name: "Project dashboard header", description: "One primary action on the right; meta counts what the page holds.", render: () => <ProjectHeader /> }],
  doDont: [
    {
      do: { caption: "The dashboard title role and one action.", render: () => <ProjectHeader /> },
      dont: { caption: "A Stack of H1 and buttons skips the responsive header layout.", render: () => <Stack align="row" justify="between"><Typo.H1>butler</Typo.H1><Button text="New chat" /></Stack> },
    },
  ],
  content: ["Title is the project or page name; meta is a count."],
  accessibility: ["The title is the page heading; the action is a labelled button."],
  tokens: ["--typo-dashboard-title-size", "--typo-dashboard-title-weight", "--space-md"],
};
