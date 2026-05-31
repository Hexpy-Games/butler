import { Activity } from "../../components/Icons";
import { KeyValueRow } from "../KeyValueRow";
import { InspectorPanel } from "./InspectorPanel";

export function InspectorPanelFixture() {
  return (
    <InspectorPanel title="Inspector" description="Context summary" icon={<Activity size={15} />}>
      <KeyValueRow label="Tokens" value="18,240" meta="62%" />
      <KeyValueRow label="Files" value="8" />
    </InspectorPanel>
  );
}
