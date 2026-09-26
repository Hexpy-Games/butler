import type { ShowcaseGuidance } from "../../showcase";
import { ICON_SIZE } from "../Icons";
import { Spinner } from "../Spinner";
import { LoadingIndicator } from "./LoadingIndicator";

// #region recipe: Status icon that completes
function RunStatusIcon({ running }: { running: boolean }) {
  // The same element across renders: running -> complete draws the check.
  return <LoadingIndicator state={running ? "loading" : "done"} size={ICON_SIZE.lg} />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One icon slot that shows the Spinner while work runs and draws the ringed SuccessCheck when it completes.",
  whenToUse: ["A running row, step or task whose success replaces the spinner", "A busy control that confirms completion in place"],
  whenNotToUse: [
    { when: "Work that can also fail or be cancelled with no success", use: "Spinner" },
    { when: "A plain completion mark without a loading phase", use: "SuccessCheck" },
  ],
  recipes: [{ name: "Status icon that completes", description: "Keep the element mounted across the change; failure states render their own icon.", render: () => <RunStatusIcon running={false} /> }],
  doDont: [
    {
      do: { caption: "Swap state on the same indicator so the check draws.", render: () => <RunStatusIcon running /> },
      dont: { caption: "Unmounting the spinner for a separate check icon skips the completion motion.", render: () => <Spinner size={ICON_SIZE.lg} /> },
    },
  ],
  content: ["The visible text says the state (Running / Complete); pass label and doneLabel only when it does not."],
  accessibility: ["label gives the spinner role=\"status\"; doneLabel names the check. Rows that mount already done do not animate."],
  tokens: ["--spinner-duration", "--motion-slow", "--motion-scale-check"],
};
