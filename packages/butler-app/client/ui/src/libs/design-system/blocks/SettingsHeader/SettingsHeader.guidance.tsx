import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { Typo } from "../../components/Typo";
import { SettingsHeader } from "./SettingsHeader";

// #region recipe: Settings page header
function AppearanceHeader() {
  return <SettingsHeader title="Appearance" description="Choose a theme and density that fits your workspace." />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The settings detail header: page title, description and, on a subpage, its breadcrumb as the secondary line. Settings pages put no action in it.",
  whenToUse: ["The top of a settings detail page"],
  whenNotToUse: [
    { when: "A dashboard or management page title", use: "DashboardHeader" },
    { when: "A section inside the page", use: "FormSection" },
    { when: "An add, refresh or filter control (section actions)", use: "SettingsSection" },
  ],
  recipes: [{ name: "Settings page header", description: "Title and description only; actions belong to the section they act on.", render: () => <AppearanceHeader /> }],
  doDont: [
    {
      do: { caption: "Title and description once, at the top.", render: () => <AppearanceHeader /> },
      dont: { caption: "A document heading for a settings page is too loud.", render: () => <Typo.H1>Appearance</Typo.H1> },
    },
    {
      do: { caption: "The header names the page; actions sit in the section header they act on.", render: () => <AppearanceHeader /> },
      dont: {
        caption: "A page-level button in the header: settings pages do not use the action slot.",
        render: () => <SettingsHeader title="Appearance" description="Choose a theme and density that fits your workspace." action={<Button size="sm" variant="outline" text="Reset" />} />,
      },
    },
  ],
  content: ["The description says what the page configures, in one sentence."],
  accessibility: ["The title is the page heading (h2); section titles below it are h3."],
  tokens: ["--typo-app-title-size", "--text-secondary", "--space-sm"],
};
