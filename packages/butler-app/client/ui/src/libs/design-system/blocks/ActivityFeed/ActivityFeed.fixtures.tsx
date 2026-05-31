import { Activity, CheckIcon } from "../../components/Icons";
import { ActivityFeed } from "./ActivityFeed";

export function ActivityFeedFixture() {
  return (
    <ActivityFeed
      title="Worker activity"
      items={[
        { id: "1", icon: <Activity size={15} />, title: "Plan updated", description: "Design-system expansion", meta: "now" },
        { id: "2", icon: <CheckIcon size={15} />, title: "Validation passed", meta: "2m" },
      ]}
    />
  );
}
