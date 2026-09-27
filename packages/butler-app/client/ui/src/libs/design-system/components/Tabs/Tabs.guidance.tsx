import type { ShowcaseGuidance } from "../../showcase";
import { SegmentedControl } from "../SegmentedControl";
import { FileText, ListChecks } from "../Icons";
import { Typo } from "../Typo";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";

// #region recipe: Line tabs over panels
function DocumentTabs() {
  return (
    <Tabs defaultValue="plans">
      <TabsList variant="line">
        <TabsTrigger value="plans"><ListChecks />Plans</TabsTrigger>
        <TabsTrigger value="specs"><FileText />Specs</TabsTrigger>
      </TabsList>
      <TabsContent value="plans"><Typo.Caption>3 open plans</Typo.Caption></TabsContent>
      <TabsContent value="specs"><Typo.Caption>12 specs</Typo.Caption></TabsContent>
    </Tabs>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Switches between sibling panels of content in the same place.",
  whenToUse: ["Inspector sections (Summary, Files, Workers)", "Page sections with the line variant"],
  whenNotToUse: [
    { when: "Filtering or changing what one panel shows", use: "SegmentedControl" },
    { when: "Navigating to another page", use: "NavRow" },
  ],
  recipes: [{ name: "Line tabs over panels", description: "The line indicator slides between triggers; each trigger owns one TabsContent.", render: () => <DocumentTabs /> }],
  doDont: [
    {
      do: { caption: "Each tab shows its own panel.", render: () => <DocumentTabs /> },
      dont: {
        caption: "Tabs as a period filter: use SegmentedControl.",
        render: () => <SegmentedControl ariaLabel="Period" value="7" onValueChange={() => undefined} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} />,
      },
    },
  ],
  content: ["One or two words per tab; icons support, never replace, the label."],
  accessibility: ["Radix tabs: arrow keys move between triggers; panels are labelled by their trigger."],
  tokens: ["--selection", "--radius-control", "--tabs-line-indicator-gap", "--motion-fast"],
};
