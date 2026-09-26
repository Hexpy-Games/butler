import type { ShowcaseGuidance } from "../../showcase";
import { Spinner } from "../Spinner";
import { ButlerThinkingMark } from "./ButlerThinkingMark";

// #region recipe: Butler status mark
function StatusMark({ busy }: { busy: boolean }) {
  // One mounted mark: flipping state morphs in place and settles back to the logo.
  return <ButlerThinkingMark state={busy ? "working" : "idle"} size="lg" />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Butler's identity mark and its thinking animation: the filled logo at rest, a riso halftone moon while Butler works.",
  whenToUse: [
    "Butler itself is thinking or working (assistant status label, active work capsules)",
    "The Butler identity next to an assistant turn, idle once the turn is done",
  ],
  whenNotToUse: [
    { when: "Generic indeterminate loading of data or a control", use: "Spinner" },
    { when: "A task row or step whose success replaces the loader", use: "LoadingIndicator" },
    { when: "Confirming that an action finished", use: "SuccessCheck" },
    { when: "Layout placeholders while content loads", use: "Skeleton" },
  ],
  recipes: [{ name: "Butler status mark", description: "Keep the mark mounted and flip state; done is the settle back to the logo.", render: () => <StatusMark busy /> }],
  doDont: [
    {
      do: { caption: "Flip state on one mounted mark so idle and working animate in place.", render: () => <StatusMark busy={false} /> },
      dont: { caption: "Do not use a Spinner (or a second ring around the mark) for Butler's own thinking.", render: () => <Spinner size={20} /> },
    },
  ],
  content: ["Keep the visible status text (Thinking, Worked for 12s) next to the mark; the mark never carries the status alone."],
  accessibility: [
    "Decorative (aria-hidden); announce state through visible text or a status region.",
    "Reduced motion (OS or the DS scope) stops the canvas loop; the still logo breathes in CSS on the Spinner's reduced pulse. Offscreen or hidden marks stop drawing.",
  ],
  tokens: ["--pulse-duration", "--spinner-easing", "--motion-slow", "--motion-ease-standard", "--icon-size-sm", "--icon-size-xl"],
};
