import {
  ActivityFeed,
  CheckCircle2,
  LoaderCircle,
  Stack,
  Typo,
} from "@/butler-ds";
import type { ProgressRow } from "@/app/types.ts";
import {
  currentModelRoundWait,
  phaseActivityRows,
  type PhaseActivity,
} from "@/components/conversation/turnActivityRows";
import {
  CurrentModelRoundWaiting,
  phaseLabel,
} from "@/components/conversation/PhaseActivityLog";
import { inspectorInset } from "./inspectorLayout.ts";
import styles from "./TurnActivityLogPanel.module.css";

export function TurnActivityLogPanel({ rows }: { rows: ProgressRow[] }) {
  const activities = phaseActivityRows(rows);
  const waiting = currentModelRoundWait(rows);
  const latestId = waiting ? undefined : activities.at(-1)?.id;
  const items = activities.map((activity) => ({
    id: activity.id,
    icon: activity.id === latestId
      ? <LoaderCircle size={17} />
      : <CheckCircle2 size={17} />,
    title: activity.summary,
    meta: phaseLabel(activity.phase),
    description: <ActivityDetail activity={activity} />,
  }));
  if (waiting) {
    items.push({
      id: waiting.id,
      icon: <LoaderCircle size={17} />,
      title: waiting.safe_label,
      meta: phaseLabel(waiting.semantic_block_id),
      description: <CurrentModelRoundWaiting row={waiting} />,
    });
  }

  return (
    <ActivityFeed
      data-test-class="turn-activity-log-panel"
      className={styles.log}
      title="턴 활동"
      emptyLabel="이 턴의 세부 활동이 아직 없습니다"
      style={inspectorInset}
      items={items}
    />
  );
}

function ActivityDetail({ activity }: { activity: PhaseActivity }) {
  return (
    <Stack gap="xs">
      <Typo.Caption as="span">{activity.rationale}</Typo.Caption>
      <Typo.Caption as="span">다음: {activity.nextStep}</Typo.Caption>
      {activity.createdAt ? (
        <time dateTime={activity.createdAt}>
          <Typo.Caption as="span">
            {formatActivityTime(activity.createdAt)}
          </Typo.Caption>
        </time>
      ) : null}
    </Stack>
  );
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}
