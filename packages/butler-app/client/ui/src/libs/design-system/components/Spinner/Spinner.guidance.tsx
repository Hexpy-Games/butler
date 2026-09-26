import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../Button";
import { ICON_SIZE } from "../Icons";
import { Skeleton } from "../Skeleton";
import { Spinner } from "./Spinner";

// #region recipe: Busy button
function SyncingButton() {
  return (
    <Button size="sm" disabled aria-busy>
      <Spinner size={ICON_SIZE.sm} />
      Syncing
    </Button>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Butler's indeterminate traveling-gap indicator, sized to the icon scale.",
  whenToUse: ["Something is running with no known duration", "Replace an icon while its row is busy"],
  whenNotToUse: [
    { when: "The shape of loading content is known", use: "Skeleton" },
    { when: "Progress with a known fraction", use: "ProgressMeter" },
  ],
  recipes: [{ name: "Busy button", description: "The spinner takes the icon slot; the button is disabled and aria-busy.", render: () => <SyncingButton /> }],
  doDont: [
    {
      do: { caption: "Size to ICON_SIZE so it sits in icon slots.", render: () => <SyncingButton /> },
      dont: { caption: "A spinner for a full list of known rows.", render: () => <Skeleton height="row" width="full" /> },
    },
  ],
  content: ["Pair with a verb in progress (Syncing, Running)."],
  accessibility: ["Pass label to announce it (role=\"status\"); otherwise it is hidden and the text carries meaning."],
  tokens: ["--spinner-duration", "--spinner-rotate-duration", "--spinner-easing", "--icon-size-sm"],
};
