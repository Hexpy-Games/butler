import { FileText, ListFilter } from "../../components/Icons";
import { InspectorPanel } from "../InspectorPanel";
import { KeyValueRow } from "../KeyValueRow";
import { InspectorShell } from "./InspectorShell";
import styles from "./InspectorShell.module.css";

export function InspectorShellFixture() {
  return (
    <InspectorShell
      activeTab="summary"
      className={styles.fixture}
      tabs={[
        { id: "summary", label: "Summary", icon: <ListFilter size={16} /> },
        { id: "files", label: "Files", icon: <FileText size={16} /> },
      ]}
      onTabChange={() => undefined}
    >
      <InspectorPanel title="Branch details">
        <KeyValueRow label="Gateway" value="Ready" />
      </InspectorPanel>
    </InspectorShell>
  );
}
