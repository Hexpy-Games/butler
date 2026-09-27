import type { ShowcaseGuidance } from "../../showcase";
import { Box } from "../../components/Box";
import { Button } from "../../components/Button";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { DashboardHeader } from "../DashboardHeader";
import { ListRow } from "../ListRow";
import { ManagementPage } from "./ManagementPage";

// #region recipe: Automations page
function AutomationsPage() {
  return (
    <ManagementPage>
      <DashboardHeader title="Automations" meta="3 scheduled" action={<Button variant="outline" text="New automation" />} />
      <Stack gap="xs">
        <ListRow title="Nightly release notes" description="butler · main" meta="active / Every day 07:00" />
        <ListRow title="Dependency audit" description="butler-app" meta="paused / Every Monday" />
      </Stack>
    </ManagementPage>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A scrolling management page (automations, project dashboard) with page width, gutters and an optional footer.",
  whenToUse: ["A full page that lists and manages things in the workspace"],
  whenNotToUse: [
    { when: "A settings page", use: "SettingsShell" },
    { when: "Only a width cap", use: "PageContainer" },
  ],
  recipes: [{ name: "Automations page", description: "Header first, then the list; the footer can overlay with a reserve.", render: () => <AutomationsPage /> }],
  doDont: [
    {
      do: { caption: "ManagementPage owns scroll, width and gutters.", render: () => <AutomationsPage /> },
      dont: { caption: "A padded Box as a page forgets the adaptive gutter and scroll edges.", render: () => <Box padding="2xl"><Typo.H2>Automations</Typo.H2></Box> },
    },
  ],
  content: ["The header title is the page name; meta counts what is listed."],
  accessibility: ["as=\"form\" when the page is an editor; the footer stays reachable by keyboard."],
  tokens: ["--page-max-width-wide", "--adaptive-page-gutter", "--space-2xl"],
};
