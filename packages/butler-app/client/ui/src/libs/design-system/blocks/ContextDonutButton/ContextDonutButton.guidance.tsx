import type { ShowcaseGuidance } from "../../showcase";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/Popover";
import { Typo } from "../../components/Typo";
import { ProgressMeter } from "../ProgressMeter";
import { ContextDonutButton } from "./ContextDonutButton";

// #region recipe: Context usage popover
function ContextUsage() {
  return (
    <Popover>
      <PopoverTrigger asChild><ContextDonutButton aria-label="Context 42% used" ratio={0.42} /></PopoverTrigger>
      <PopoverContent side="top" sideOffset={10}><Typo.Body>42% of the context window is used.</Typo.Body></PopoverContent>
    </Popover>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A small donut button that shows how full the context window is and opens its details.",
  whenToUse: ["Context usage in the composer toolbar"],
  whenNotToUse: [
    { when: "A labelled progress bar in a panel", use: "ProgressMeter" },
    { when: "A breakdown of usage by category", use: "KeyValueRow" },
  ],
  recipes: [{ name: "Context usage popover", description: "The donut is the trigger; the popover holds the breakdown.", render: () => <ContextUsage /> }],
  doDont: [
    {
      do: { caption: "A compact donut in the toolbar, details on demand.", render: () => <ContextUsage /> },
      dont: { caption: "A full progress bar in the composer toolbar takes the row.", render: () => <ProgressMeter value={42} label="Context" meta="42%" /> },
    },
  ],
  content: ["The aria-label states the percentage (Context 42% used)."],
  accessibility: ["It is a button; the ratio is not conveyed by color alone because the label carries it."],
  tokens: ["--context-chart-1", "--context-track-bg", "--control-height-sm"],
};
