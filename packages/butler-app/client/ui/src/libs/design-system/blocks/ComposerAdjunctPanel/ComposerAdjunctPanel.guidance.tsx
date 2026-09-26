import type { ShowcaseGuidance } from "../../showcase";
import { ListChecks } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { Notice } from "../Notice";
import { ComposerAdjunctPanel } from "./ComposerAdjunctPanel";

// #region recipe: Collapsible panel above the composer
function StepsPanel() {
  return (
    <ComposerAdjunctPanel heading="Steps" icon={<ListChecks size="md" />} collapsedSummary="3 of 5 steps done">
      <Typo.Body>Inspect the settings pages, then fix the card insets.</Typo.Body>
    </ComposerAdjunctPanel>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The collapsible shell attached above the composer (the adjunct slot) with a one-line collapsed summary.",
  whenToUse: ["Build a new composer-attached panel type"],
  whenNotToUse: [
    { when: "Plan steps", use: "TodoProgressPanel" },
    { when: "Worker activity", use: "WorkerActivityPanel" },
    { when: "A warning about the composer", use: "Notice" },
  ],
  recipes: [{ name: "Collapsible panel above the composer", description: "Pass it as ComposerCard adjunct; collapsedSummary shows when folded.", render: () => <StepsPanel /> }],
  doDont: [
    {
      do: { caption: "Adjunct panels fold to one summary line.", render: () => <StepsPanel /> },
      dont: { caption: "A notice for ongoing progress cannot fold away.", render: () => <Notice tone="info" message="3 of 5 steps done" /> },
    },
  ],
  content: ["Summaries are counts or the current step, under one line."],
  accessibility: ["The header toggles with aria-expanded; content stays in reading order before the composer."],
  tokens: ["--composer-glass-bg", "--radius-composer", "--motion-base"],
};
