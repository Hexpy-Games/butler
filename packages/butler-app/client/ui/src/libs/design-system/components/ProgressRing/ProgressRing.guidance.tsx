import type { ShowcaseGuidance } from "../../showcase";
import { NavRow } from "../../blocks/NavRow";
import { ProgressMeter } from "../../blocks/ProgressMeter";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { ProgressRing } from "./ProgressRing";

// #region recipe: Sidebar progress row
function UpdateRow() {
  return (
    <NavRow
      icon={<ProgressRing size="sidebar" value={0.42} aria-hidden="true" />}
      label="Downloading update"
      ariaLabel="Downloading update 42%"
      badge="42%"
      onClick={() => undefined}
    />
  );
}
// #endregion

// #region recipe: Status line
function PreparingLine() {
  return (
    <Stack align="row" gap="sm" cross="center">
      <ProgressRing size="sm" indeterminate aria-label="Preparing update" />
      <Typo.Caption>Preparing update</Typo.Caption>
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A non-interactive ring that shows progress, known or not, in an icon-sized square.",
  whenToUse: [
    "Progress in an icon slot (a sidebar row, a status line)",
    "A download or update whose size may not be known yet",
  ],
  whenNotToUse: [
    { when: "A labelled progress bar with room for its own row", use: "ProgressMeter" },
    { when: "Context usage that opens details on click", use: "ContextDonutButton" },
    { when: "Busy with no progress to report, next to a verb", use: "Spinner" },
    { when: "Loading that ends in a success check in the same slot", use: "LoadingIndicator" },
  ],
  recipes: [
    { name: "Sidebar progress row", description: "size=\"sidebar\" follows the row density; the row names itself, so the ring is aria-hidden.", render: () => <UpdateRow /> },
    { name: "Status line", description: "Indeterminate until the size is known; the ring is the named progressbar.", render: () => <PreparingLine /> },
  ],
  doDont: [
    {
      do: { caption: "A ring in the row's icon slot, the percent in the badge.", render: () => <UpdateRow /> },
      dont: { caption: "A full progress bar squeezed into a sidebar row.", render: () => <ProgressMeter value={42} label="Downloading update" meta="42%" /> },
    },
  ],
  content: [
    "Show the percent as text next to it (badge or caption) when it matters; the ring alone is approximate.",
    "Use tone=\"success\" once complete and tone=\"danger\" for a failure that keeps the ring; otherwise swap in a status icon.",
  ],
  accessibility: [
    "role=\"progressbar\" with aria-valuenow 0-100; name it with aria-label (aria-valuetext for richer text such as 12 of 40 MB).",
    "Indeterminate omits aria-valuenow. Under reduced motion (OS or data-motion=\"reduced\") it is a static quarter arc.",
    "Inside a control or row that already says the percent, pass aria-hidden so it is not announced twice.",
  ],
  tokens: ["--context-track-bg", "--accent", "--color-success", "--color-danger", "--icon-size-md", "--sidebar-icon-size", "--motion-fast", "--spinner-duration"],
};
