import { ActivityFeed } from "../ActivityFeed";
import type { ActivityFeedItem } from "../ActivityFeed";

export interface AutomationRunListProps {
  runs: ActivityFeedItem[];
  title?: string;
  emptyLabel?: string;
}

export function AutomationRunList({
  runs,
  title = "Runs",
  emptyLabel = "No automation runs yet",
}: AutomationRunListProps) {
  return <ActivityFeed title={title} items={runs} emptyLabel={emptyLabel} />;
}
