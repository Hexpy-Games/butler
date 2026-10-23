import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Activity, Clock3, ListFilter } from "../Icons";
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

// #region recipe: List filter
function ListView() {
  const [view, setView] = useState("all");
  return (
    <SegmentedControl stretch ariaLabel="Conversation view" value={view} onValueChange={setView} options={[
      { value: "all", label: "All", icon: <ListFilter /> },
      { value: "recent", label: "Recent", icon: <Clock3 /> },
      { value: "running", label: "Running", icon: <Activity /> },
    ]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A compact single-choice radiogroup that changes what one panel shows.",
  whenToUse: ["Switch a chart period or dataset", "Pick a mode among two to five short options", "Filter a list in place (All, Recent, Running)"],
  whenNotToUse: [
    { when: "Switching between panels of content", use: "Tabs" },
    { when: "More than five options or long labels", use: "Select" },
    { when: "An on/off setting", use: "Switch" },
  ],
  recipes: [
    { name: "Chart period", description: "The value changes the data of the panel it sits in.", render: () => <ChartPeriod /> },
    { name: "List filter", description: "stretch fills the column; icons lead the labels.", render: () => <ListView /> },
  ],
  doDont: [
    {
      do: { caption: "Short, parallel labels; one is always selected.", render: () => <ChartPeriod /> },
      dont: {
        caption: "Tabs used as a filter imply separate panels.",
        render: () => <Tabs defaultValue="7"><TabsList><TabsTrigger value="7">7 days</TabsTrigger><TabsTrigger value="30">30 days</TabsTrigger></TabsList></Tabs>,
      },
    },
  ],
  content: ["One or two words per option; keep Korean options the same length where possible.", "Icons support, never replace, the label."],
  accessibility: [
    "role=radiogroup with arrow-key roving focus; pass ariaLabel naming the choice.",
    "The focused option shows the shared focus ring; the track's inset keeps it whole.",
  ],
  tokens: ["--selection", "--surface", "--line", "--radius-control", "--motion-fast", "--control-height-md", "--control-height-xs", "--control-hit-target", "--focus-ring"],
};
