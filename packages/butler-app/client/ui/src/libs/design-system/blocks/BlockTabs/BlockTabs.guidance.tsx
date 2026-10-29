import type { ShowcaseGuidance } from "../../showcase";
import { KeyValueRow } from "../KeyValueRow";
import { BlockColumns } from "../BlockColumns";
import { BlockTabs } from "./BlockTabs";

// #region recipe: One block per option
function Options() {
  return (
    <BlockTabs
      ariaLabel="Plans"
      tabs={[
        { label: "Basic", content: <KeyValueRow label="Price" value="₩9,900" /> },
        { label: "Family", content: <KeyValueRow label="Price" value="₩16,900" /> },
      ]}
    />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Content blocks split over line tabs, the first open: the `tabs` answer-block container.",
  whenToUse: ["Parallel options with the same blocks each (a city, a plan, a month)", "Long answers where the reader needs one part at a time"],
  whenNotToUse: [
    { when: "Blocks the reader compares at once", use: "BlockColumns" },
    { when: "Switching a page or panel view", use: "Tabs" },
    { when: "A filter of one list", use: "SegmentedControl" },
  ],
  recipes: [{ name: "One block per option", description: "Each tab holds one to four leaf blocks.", render: () => <Options /> }],
  doDont: [
    {
      do: { caption: "Tabs hold leaf blocks.", render: () => <Options /> },
      dont: { caption: "Columns inside a tab: containers never nest.", render: () => <BlockTabs ariaLabel="Plans" tabs={[{ label: "Basic", content: <BlockColumns><KeyValueRow label="Price" value="₩9,900" /><KeyValueRow label="Seats" value="1" /></BlockColumns> }, { label: "Family", content: null }]} /> },
    },
  ],
  content: ["Tab labels are a few words and name the option, not the content type."],
  accessibility: ["Radix tabs: arrow keys move between tabs; name the list with `ariaLabel` when no visible title does."],
  tokens: ["--space-md"],
};
