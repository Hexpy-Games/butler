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
  purpose: "A titled group in a side panel with a tight list rhythm; InspectorInset aligns full-width content beside it.",
  whenToUse: ["Group facts or lists in a side panel (a ConversationShell or ManagementPage aside)"],
  whenNotToUse: [
    { when: "A titled region elsewhere", use: "Section" },
    { when: "The side panel beside the conversation (its aside)", use: "ConversationShell" },
    { when: "The detail beside a management page (its aside)", use: "ManagementPage" },
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
