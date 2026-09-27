import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Tabs, TabsList, TabsTrigger } from "../Tabs";
import { SegmentedControl } from "./SegmentedControl";

// #region recipe: Chart period
function ChartPeriod() {
  const [period, setPeriod] = useState("30");
  return (
    <SegmentedControl ariaLabel="Period" value={period} onValueChange={setPeriod} options={[
      { value: "7", label: "7 days" },
      { value: "30", label: "30 days" },
      { value: "90", label: "90 days" },
    ]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A compact single-choice radiogroup that changes what one panel shows.",
  whenToUse: ["Switch a chart period or dataset", "Pick a mode among two to five short options"],
  whenNotToUse: [
    { when: "Switching between panels of content", use: "Tabs" },
    { when: "More than five options or long labels", use: "Select" },
    { when: "An on/off setting", use: "Switch" },
  ],
  recipes: [{ name: "Chart period", description: "The value changes the data of the panel it sits in.", render: () => <ChartPeriod /> }],
  doDont: [
    {
      do: { caption: "Short, parallel labels; one is always selected.", render: () => <ChartPeriod /> },
      dont: {
        caption: "Tabs used as a filter imply separate panels.",
        render: () => <Tabs defaultValue="7"><TabsList><TabsTrigger value="7">7 days</TabsTrigger><TabsTrigger value="30">30 days</TabsTrigger></TabsList></Tabs>,
      },
    },
  ],
  content: ["One or two words per option; keep Korean options the same length where possible."],
  accessibility: ["role=radiogroup with arrow-key roving focus; pass ariaLabel naming the choice."],
  tokens: ["--selection", "--radius-control", "--motion-fast", "--control-height-sm"],
};
