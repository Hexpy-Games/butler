import type { ShowcaseGuidance } from "../../showcase";
import { Section } from "../../components/Section";
import { KeyValueRow } from "../KeyValueRow";
import { InspectorPanel } from "./InspectorPanel";

// #region recipe: Branch details panel
function BranchDetails() {
  return (
    <InspectorPanel title="Branch details">
      <KeyValueRow label="Gateway" value="Ready" />
      <KeyValueRow label="Git branch" value="main" />
      <KeyValueRow label="Changes" value="Clean" />
    </InspectorPanel>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A titled group inside an inspector tab with the inspector's inset and tight list rhythm.",
  whenToUse: ["Group facts or lists inside the right-panel inspector"],
  whenNotToUse: [
    { when: "A titled region elsewhere", use: "Section" },
    { when: "The tabbed inspector frame", use: "InspectorShell" },
  ],
  recipes: [{ name: "Branch details panel", description: "KeyValueRows inside; title uses the compact panel role.", render: () => <BranchDetails /> }],
  doDont: [
    {
      do: { caption: "Inspector panels keep the inspector inset and rhythm.", render: () => <BranchDetails /> },
      dont: { caption: "A page Section in the inspector uses a looser rhythm.", render: () => <Section title="Branch details"><KeyValueRow label="Gateway" value="Ready" /></Section> },
    },
  ],
  content: ["Titles are nouns (Branch details, Skills)."],
  accessibility: ["The title labels the panel; content keeps reading order."],
  tokens: ["--typo-panel-section-title-size", "--space-sm", "--space-xs"],
};
