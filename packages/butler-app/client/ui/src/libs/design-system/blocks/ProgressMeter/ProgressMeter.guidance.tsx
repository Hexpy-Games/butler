import type { ShowcaseGuidance } from "../../showcase";
import { Spinner } from "../../components/Spinner";
import { Stack } from "../../components/Stack";
import { ProgressMeter } from "./ProgressMeter";

// #region recipe: Labelled budget bar
function ContextBudget() {
  return (
    <Stack gap="sm">
      <ProgressMeter label="Context" meta="62%" value={62} />
      <ProgressMeter bare ariaLabel="Changes reviewed" value={80} tone="success" />
    </Stack>
  );
}
// #endregion

// #region recipe: Download with an unknown total
function UnknownTotal() {
  return <ProgressMeter indeterminate label="Downloading" meta="44 MB downloaded" />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A determinate progress bar (0–100) with a label row, tones and a bare track variant; indeterminate shows a spinner caption for an unknown total.",
  whenToUse: ["Show a known fraction: budget used, steps done", "A labelled transfer whose total is not known yet (indeterminate)"],
  whenNotToUse: [
    { when: "Unknown duration with no label (a busy button or row)", use: "Spinner" },
    { when: "Context usage in the composer toolbar", use: "ContextDonutButton" },
    { when: "Progress in an icon slot (sidebar row, status line)", use: "ProgressRing" },
  ],
  recipes: [
    { name: "Labelled budget bar", description: "label and meta above the track; bare needs ariaLabel.", render: () => <ContextBudget /> },
    { name: "Download with an unknown total", description: "indeterminate: spinner and one caption line, no track; switch to value once the total is known.", render: () => <UnknownTotal /> },
  ],
  doDont: [
    {
      do: { caption: "A known fraction shows as a bar with a number.", render: () => <ContextBudget /> },
      dont: { caption: "A spinner for work whose progress is known.", render: () => <Spinner size={16} label="Loading" /> },
    },
  ],
  content: ["Meta shows the number (62%, 3/5).", "Use indeterminate for an unknown total: a spinner caption with optional received amount, no bar."],
  accessibility: ["role=progressbar with aria-valuenow; tone never replaces the number.", "Indeterminate is role=status (no aria-valuenow); the Spinner breathes instead of rotating under reduced motion."],
  tokens: ["--accent", "--color-success", "--selection", "--motion-deliberate", "--typo-caption-size", "--typo-caption-line-height"],
};
