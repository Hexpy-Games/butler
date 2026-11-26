import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { Inline } from "../Inline";
import { Typo } from "../Typo";
import { Badge } from "./Badge";

// #region recipe: Feature that needs a plan
function FeatureThatNeedsAPlan() {
  return (
    <Inline gap="xs" cross="center">
      <Typo.Label>Connect from anywhere</Typo.Label>
      <Badge tooltip="Available on Plus and above.">Plus</Badge>
    </Inline>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A filled pill that names a plan: Plus, Pro or Enterprise.",
  whenToUse: ["Mark a feature that needs a plan, with a tooltip naming it", "Show the account's current paid plan"],
  whenNotToUse: [
    { when: "A status or category", use: "Tag" },
    { when: "A clickable action", use: "PillButton" },
  ],
  recipes: [
    { name: "Feature that needs a plan", description: "The tooltip explains which plans include the feature.", render: () => <FeatureThatNeedsAPlan /> },
  ],
  doDont: [
    {
      do: { caption: "A badge names a plan; it does not act.", render: () => <FeatureThatNeedsAPlan /> },
      dont: { caption: "A button styled as a badge hides that it acts.", render: () => <Button size="xs" variant="outline" shape="pill" text="Plus" /> },
    },
  ],
  content: ["Pass the plan name in its copy casing; CSS sets capitals.", "One badge per row; the current plan shows it without a tooltip."],
  accessibility: [
    "The text names the plan; color is not the only signal.",
    "With a tooltip it is a focus stop with the DS focus ring; it has no action.",
    "White on the light fill is 4.65:1 and navy on the dark fill is 5.55:1, the sheen included.",
  ],
  tokens: ["--badge-height", "--badge-bg", "--badge-fg", "--badge-sheen-peak", "--motion-sheen-lap", "--motion-sheen-pause", "--radius-pill", "--tag-height-sm"],
};
