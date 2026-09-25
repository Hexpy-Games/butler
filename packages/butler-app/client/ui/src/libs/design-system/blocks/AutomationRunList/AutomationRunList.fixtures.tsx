import { CheckIcon } from "../../components/Icons";
import { AutomationRunList } from "./AutomationRunList";

export function AutomationRunListFixture() {
  return (
    <AutomationRunList
      runs={[
        { id: "run-1", icon: <CheckIcon size="md" />, title: "Completed", description: "Brief generated", meta: "today" },
      ]}
    />
  );
}
