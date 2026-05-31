import { Button } from "../../components/Button";
import { AutomationRow } from "./AutomationRow";

export function AutomationRowFixture() {
  return (
    <AutomationRow
      title="Brief"
      description="Summarize active work"
      schedule="Weekdays"
      actions={<Button size="xs" variant="borderless">Run</Button>}
    />
  );
}
