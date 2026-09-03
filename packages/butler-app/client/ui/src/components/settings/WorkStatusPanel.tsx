import { appCopy } from "@/app/copy.ts";
import type { WorkStatusItemView, WorkStatusView } from "@/app/types.ts";
import { Button, Stack, SurfacePanel, Tag, Typo } from "@/butler-ds";

export interface WorkStatusPanelProps {
  view: WorkStatusView | null;
  unavailable?: boolean;
  onOpenSession: (sessionId: string) => void;
}

export function WorkStatusPanel({
  view,
  unavailable = false,
  onOpenSession,
}: WorkStatusPanelProps) {
  const copy = appCopy.settings.workStatus;
  if (unavailable) return <Typo.Caption>{copy.unavailable}</Typo.Caption>;
  if (!view) return <Typo.Caption>{copy.loading}</Typo.Caption>;
  if (view.items.length === 0) {
    return <Typo.Caption data-testid="work-status-empty">{copy.empty}</Typo.Caption>;
  }
  return (
    <Stack gap="sm" data-testid="work-status-list">
      {view.items.map((item) => (
        <WorkStatusRow
          key={`${item.session_id}:${item.updated_at}`}
          item={item}
          onOpenSession={onOpenSession}
        />
      ))}
    </Stack>
  );
}

function WorkStatusRow({
  item,
  onOpenSession,
}: {
  item: WorkStatusItemView;
  onOpenSession: (sessionId: string) => void;
}) {
  const copy = appCopy.settings.workStatus;
  const meta = [
    item.stage ? copy.stages[item.stage] : null,
    item.total_actions > 0
      ? copy.actions(item.completed_actions, item.total_actions)
      : null,
    item.effect_count > 0 ? copy.effects(item.effect_count) : null,
  ].filter((value): value is string => Boolean(value));
  return (
    <SurfacePanel elevation="none">
      <Stack gap="xs">
        <Stack align="row" cross="center" justify="between" gap="sm" wrap>
          <Typo.Body as="div">{item.safe_title}</Typo.Body>
          <Tag ariaLabel={copy.states[item.state]}>{copy.states[item.state]}</Tag>
        </Stack>
        <Typo.Caption>{item.safe_summary}</Typo.Caption>
        {item.latest_report_summary ? (
          <Typo.Caption>
            {copy.latestReport}: {item.latest_report_summary}
          </Typo.Caption>
        ) : null}
        {item.recent_artifacts?.length ? (
          <Typo.Caption>
            {copy.recentArtifacts}: {item.recent_artifacts.join(" · ")}
          </Typo.Caption>
        ) : null}
        <Stack align="row" cross="center" justify="between" gap="sm" wrap>
          {meta.length > 0 ? <Typo.Caption>{meta.join(" · ")}</Typo.Caption> : <span />}
          <Button
            type="button"
            size="xs"
            variant="inline"
            onClick={() => onOpenSession(item.session_id)}
          >
            {copy.details}
          </Button>
        </Stack>
      </Stack>
    </SurfacePanel>
  );
}
