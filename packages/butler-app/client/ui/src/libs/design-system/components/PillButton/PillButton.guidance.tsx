import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { Plus, Sparkles } from "../Icons";
import { Stack } from "../Stack";
import { PillButton } from "./PillButton";

// #region recipe: Composer capsules
function ComposerCapsules() {
  return (
    <Stack align="row" gap="sm" justify="center" wrap>
      <PillButton surface="glass" icon={<Sparkles size="md" />}>Preparing report</PillButton>
      <PillButton icon={<Plus size="md" />}>Add context</PillButton>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A rounded borderless chip for compact, frequent actions around the composer.",
  whenToUse: ["A capsule above the composer (progress, report)", "A chip-like action with an icon and a short label"],
  whenNotToUse: [
    { when: "A form or dialog action", use: "Button" },
    { when: "A composer toolbar control with label and detail", use: "ComposerControl" },
    { when: "A status label that is not clickable", use: "Tag" },
  ],
  recipes: [{ name: "Composer capsules", description: "Glass capsules float over the conversation; plain ones sit on surfaces.", render: () => <ComposerCapsules /> }],
  doDont: [
    {
      do: { caption: "Intrinsic width; stretch only when the row asks for it.", render: () => <PillButton icon={<Plus size="md" />}>Add context</PillButton> },
      dont: { caption: "A regular Button pretending to be a pill in the composer.", render: () => <Button shape="pill" variant="outline" text="Add context" /> },
    },
  ],
  content: [
    "For icon-only glass controls, use size=\"icon-lg\" and an aria-label: 34px circles on desktop and 44px on touch.", "One to three words; long capsule text truncates (task · activity · progress)."],
  accessibility: ["Give an aria-label that includes the truncated parts when the label is a composite."],
  tokens: ["--radius-pill", "--tinted-glass-bg", "--control-height-sm"],
};
