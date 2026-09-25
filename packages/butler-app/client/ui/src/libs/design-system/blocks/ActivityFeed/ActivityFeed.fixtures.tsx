import { Activity, CheckIcon } from "../../components/Icons";
import { ActivityFeed } from "./ActivityFeed";

export function ActivityFeedFixture() {
  return (
    <ActivityFeed
      title="Worker activity"
      items={[
        { id: "1", icon: <Activity size="md" />, title: "Plan updated", description: "Design-system expansion", meta: "now" },
        { id: "2", icon: <CheckIcon size="md" />, title: "Validation passed", meta: "2m" },
      ]}
    />
  );
}
