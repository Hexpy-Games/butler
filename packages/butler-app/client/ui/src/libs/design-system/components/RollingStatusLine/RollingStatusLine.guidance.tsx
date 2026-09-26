import type { ShowcaseGuidance } from "../../showcase";
import { Spinner } from "../Spinner";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { RollingStatusLine } from "./RollingStatusLine";

// #region recipe: Live status line
function LiveStatus() {
  return (
    <RollingStatusLine aria-live="polite" title="Reading the settings pages">
      <Stack align="row" gap="sm" cross="center">
        <Spinner size={14} />
        <Typo.Body as="p">Reading the settings pages</Typo.Body>
      </Stack>
    </RollingStatusLine>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A one-line live status that truncates long text and keeps its height stable.",
  whenToUse: ["Show what the assistant is doing right now in one line"],
  whenNotToUse: [
    { when: "Replacing the status with an animated swap", use: "RollingSwap" },
    { when: "A list of finished steps", use: "ActivityFeed" },
  ],
  recipes: [{ name: "Live status line", description: "Polite live region; the full text stays available in title.", render: () => <LiveStatus /> }],
  doDont: [
    {
      do: { caption: "One line, truncated, with the full text in title.", render: () => <LiveStatus /> },
      dont: { caption: "A wrapping paragraph makes the status jump in height.", render: () => <Typo.Body>Reading the settings pages, the design-system tokens and three failing layout tests before suggesting a fix</Typo.Body> },
    },
  ],
  content: ["Present progressive, no trailing period: Reading the settings pages."],
  accessibility: ["aria-live=\"polite\" announces changes without interrupting."],
  tokens: ["--typo-body-size", "--line-height-body"],
};
