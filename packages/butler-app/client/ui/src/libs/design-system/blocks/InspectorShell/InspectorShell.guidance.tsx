import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { FileText, ListFilter } from "../../components/Icons";
import { Tabs, TabsList, TabsTrigger } from "../../components/Tabs";
import { Section } from "../../components/Section";
import { InspectorPanel } from "../InspectorPanel";
import { KeyValueRow } from "../KeyValueRow";
import { ListRow } from "../ListRow";
import { InspectorInset, InspectorShell } from "./index";

// #region recipe: Tabbed inspector
function Inspector() {
  const [tab, setTab] = useState("summary");
  return (
    <InspectorShell activeTab={tab} onTabChange={setTab} tabs={[
      { id: "summary", label: "Summary", icon: <ListFilter size="md" /> },
      { id: "files", label: "Files", icon: <FileText size="md" /> },
    ]}>
      {tab === "summary"
        ? <InspectorPanel title="Branch details"><KeyValueRow label="Gateway" value="Ready" /></InspectorPanel>
        : <InspectorInset><Section title="Artifacts" gap="sm"><ListRow icon={<FileText size="md" />} title="release-notes.md" /></Section></InspectorInset>}
    </InspectorShell>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The right-panel inspector: icon tabs, a flat selected tab and a scrolling body; InspectorInset aligns custom content.",
  whenToUse: ["The inspector beside the conversation"],
  whenNotToUse: [
    { when: "Tabs inside page content", use: "Tabs" },
    { when: "One group in the inspector", use: "InspectorPanel" },
  ],
  recipes: [{ name: "Tabbed inspector", description: "The shell owns the tabs; each tab renders InspectorPanels or inset Sections.", render: () => <Inspector /> }],
  doDont: [
    {
      do: { caption: "One inspector frame with icon tabs.", render: () => <Inspector /> },
      dont: { caption: "Page tabs in the narrow inspector wrap and lose icons.", render: () => <Tabs defaultValue="a"><TabsList><TabsTrigger value="a">Summary</TabsTrigger><TabsTrigger value="b">Files</TabsTrigger></TabsList></Tabs> },
    },
  ],
  content: ["Tab labels are single nouns."],
  accessibility: ["Tabs are a tablist with the selected tab exposed; the body scrolls independently."],
  tokens: ["--right-panel-width", "--selection", "--space-md"],
};
