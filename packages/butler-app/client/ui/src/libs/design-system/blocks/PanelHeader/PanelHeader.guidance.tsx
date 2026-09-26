import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { ArrowLeft } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { PanelHeader } from "./PanelHeader";

// #region recipe: Artifact viewer header
function ArtifactHeader() {
  return (
    <PanelHeader title="release-notes.md" description="Markdown · 4.2 KB · updated 3 minutes ago"
      actions={<Button iconStart={<ArrowLeft size="sm" />} size="xs" text="All artifacts" variant="borderless" />} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The header of a side panel: compact title, one-line description and trailing actions.",
  whenToUse: ["Top of an inspector or artifact viewer panel"],
  whenNotToUse: [
    { when: "A page title", use: "DashboardHeader" },
    { when: "A settings page title", use: "SettingsHeader" },
    { when: "A titled group inside a panel", use: "Section" },
  ],
  recipes: [{ name: "Artifact viewer header", description: "Back action on the right; meta in the description.", render: () => <ArtifactHeader /> }],
  doDont: [
    {
      do: { caption: "The compact panel title scale.", render: () => <ArtifactHeader /> },
      dont: { caption: "A document heading in a narrow panel wraps and dominates.", render: () => <Stack><Typo.H2>release-notes.md</Typo.H2></Stack> },
    },
  ],
  content: ["Title is the object name; description is metadata, not a sentence."],
  accessibility: ["The title is not a heading element by default; pair the panel with an aria-label when needed."],
  tokens: ["--typo-panel-title-size", "--text-secondary", "--space-sm"],
};
