import type { ShowcaseGuidance } from "../../showcase";
import { MetricCard } from "../MetricCard";
import { BlockColumns } from "./BlockColumns";

// #region recipe: Compare two numbers
function Compare() {
  return (
    <BlockColumns>
      <MetricCard label="This month" value="1.24M" />
      <MetricCard label="Last month" value="1.15M" />
    </BlockColumns>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Two or three content blocks side by side that stack when their own space is narrow: the `columns` answer-block container.",
  whenToUse: ["Two or three answer, scrap or document blocks read together", "Blocks that also appear in a narrow side panel or 서랍 card"],
  whenNotToUse: [
    { when: "A page layout keyed to the window", use: "Grid" },
    { when: "A row of metrics only", use: "MetricGrid" },
    { when: "Blocks the reader picks one of", use: "BlockTabs" },
  ],
  recipes: [{ name: "Compare two numbers", description: "Side by side from 30rem of its own width, stacked below.", render: () => <Compare /> }],
  doDont: [
    {
      do: { caption: "Each column holds one leaf block.", render: () => <Compare /> },
      dont: { caption: "Columns inside columns or tabs: containers never nest.", render: () => <BlockColumns><BlockColumns><MetricCard label="A" value="1" /><MetricCard label="B" value="2" /></BlockColumns><MetricCard label="C" value="3" /></BlockColumns> },
    },
  ],
  content: ["Two columns from 30rem, three from 40rem of the block's own width; one column below."],
  accessibility: ["Columns read in DOM order, left to right, the same order they stack in."],
  tokens: ["--space-md"],
};
