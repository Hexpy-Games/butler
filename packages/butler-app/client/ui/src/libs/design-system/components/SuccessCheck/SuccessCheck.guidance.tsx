import type { ShowcaseGuidance } from "../../showcase";
import { CheckIcon, ICON_SIZE } from "../Icons";
import { SuccessCheck } from "./SuccessCheck";

// #region recipe: Confirm a finished action in place
function SavedMark({ run }: { run: number }) {
  // A new key per completion replays the draw.
  return <SuccessCheck key={run} size={ICON_SIZE.sm} label="Saved" />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The DS completion mark: a check (optionally in a ring) whose stroke draws in with a subtle pop.",
  whenToUse: ["Confirm that an action just finished, in the icon slot where it ran", "The done state after a Spinner (use LoadingIndicator)"],
  whenNotToUse: [
    { when: "A spinner that resolves into done", use: "LoadingIndicator" },
    { when: "A static done status in a list of history", use: "Icons" },
    { when: "A confirmation with no on-screen place", use: "Toast" },
  ],
  recipes: [{ name: "Confirm a finished action in place", description: "Mount on completion; a new key replays it.", render: () => <SavedMark run={1} /> }],
  doDont: [
    {
      do: { caption: "Draw once, where the work finished.", render: () => <SuccessCheck size={ICON_SIZE.md} /> },
      dont: { caption: "Do not animate checks for rows that were already done on load.", render: () => <CheckIcon size="md" /> },
    },
  ],
  content: ["Pair with past-tense text (Saved, Copied) or pass label."],
  accessibility: ["Decorative unless label is set (role=\"img\"); announce the result through visible text or a status region."],
  tokens: ["--motion-slow", "--motion-base", "--motion-menu", "--motion-ease-standard", "--motion-scale-check"],
};
