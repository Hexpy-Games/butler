import type { ShowcaseGuidance } from "../../showcase";
import { Box } from "../../components/Box";
import { Button } from "../../components/Button";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { DashboardHeader } from "../DashboardHeader";
import { ListRow } from "../ListRow";
import { Wallpaper } from "../Wallpaper";
import { ManagementPage, ManagementPagePanel } from "./ManagementPage";

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

// #region recipe: Dashboard over a wallpaper
function WallpaperDashboard() {
  return (
    <ManagementPage background={<Wallpaper scope="container" source={{ kind: "live", module: "butler.silk" }} />}>
      <ManagementPagePanel>
        <DashboardHeader title="Butler" description="Desktop client and gateway." action={<Button variant="outline" text="New conversation" />} />
      </ManagementPagePanel>
      <ManagementPagePanel>
        <ListRow title="Wallpaper upgrade" description="P3 · dashboard" meta="open" />
      </ManagementPagePanel>
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
    { when: "A wallpaper behind the new-chat prompt", use: "PromptSuggestionList" },
  ],
  recipes: [
    { name: "Automations page", description: "Header first, then the list; the footer can overlay with a reserve.", render: () => <AutomationsPage /> },
    {
      name: "Dashboard over a wallpaper",
      description: "A container-scope Wallpaper as the page background (calm veil by default); content groups go in ManagementPagePanel, which turns into TintedGlass.",
      render: () => <WallpaperDashboard />,
    },
  ],
  doDont: [
    {
      do: { caption: "ManagementPage owns scroll, width and gutters.", render: () => <AutomationsPage /> },
      dont: { caption: "A padded Box as a page forgets the adaptive gutter and scroll edges.", render: () => <Box padding="2xl"><Typo.H2>Automations</Typo.H2></Box> },
    },
    {
      do: { caption: "Over a background, group text in ManagementPagePanel so it sits on glass.", render: () => <WallpaperDashboard /> },
      dont: {
        caption: "Text straight on the wallpaper loses contrast wherever the wallpaper is busy.",
        render: () => (
          <ManagementPage background={<Wallpaper scope="container" source={{ kind: "live", module: "butler.silk" }} />} backgroundTreatment="none">
            <DashboardHeader title="Butler" description="Desktop client and gateway." />
          </ManagementPage>
        ),
      },
    },
  ],
  content: [
    "The header title is the page name; meta counts what is listed.",
    "A background is decoration: keep the calm treatment unless the page shows no text over it.",
  ],
  accessibility: [
    "as=\"form\" when the page is an editor; the footer stays reachable by keyboard.",
    "The background layer is aria-hidden and takes no pointer input; text over it sits on TintedGlass panels.",
  ],
  tokens: ["--page-max-width-wide", "--adaptive-page-gutter", "--space-2xl", "--management-page-veil", "--tinted-glass-bg"],
};
