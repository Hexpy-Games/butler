import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { Typo } from "../../components/Typo";
import { SettingsHeader } from "./SettingsHeader";

// #region recipe: Settings page header with an action
function AppearanceHeader() {
  return <SettingsHeader title="Appearance" description="Choose a theme and density that fits your workspace." action={<Button size="sm" variant="outline" text="Reset" />} />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The settings detail header: page title, description, a secondary line and one action slot.",
  whenToUse: ["The top of a settings detail page"],
  whenNotToUse: [
    { when: "A dashboard or management page title", use: "DashboardHeader" },
    { when: "A section inside the page", use: "FormSection" },
  ],
  recipes: [{ name: "Settings page header with an action", description: "One action at most; save results can appear in the action slot.", render: () => <AppearanceHeader /> }],
  doDont: [
    {
      do: { caption: "Title and description once, at the top.", render: () => <AppearanceHeader /> },
      dont: { caption: "A document heading for a settings page is too loud.", render: () => <Typo.H1>Appearance</Typo.H1> },
    },
  ],
  content: ["The description says what the page configures, in one sentence."],
  accessibility: ["The title is the page heading; the action is a labelled button."],
  tokens: ["--typo-app-title-size", "--text-secondary", "--space-sm"],
};
