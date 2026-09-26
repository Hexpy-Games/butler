import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { WorkStatusItemView, WorkStatusView } from "@/app/types.ts";
import { NavSectionHeading, SessionRow, Stack } from "@/butler-ds";

/** Nothing renders while loading, empty or unavailable: the Running tab stays a list of live work. */
export function SpaceWorkStatusList({
  view,
  onOpenSession,
}: {
  view: WorkStatusView | null;
  onOpenSession: (sessionId: string) => void;
}) {
  useAppLocale();
  if (!view || view.items.length === 0) return null;
  return (
    <Stack gap="xs" data-test-class="sidebar-work-status">
      <NavSectionHeading title={appCopy.settings.workStatus.title} />
      {view.items.map((item) => (
        <SessionRow
          key={`${item.session_id}:${item.updated_at}`}
          dataTestClass="sidebar-work-status-row"
          title={item.safe_title}
          description={item.latest_report_summary || item.safe_summary}
          meta={workStatusMeta(item)}
          onSelect={() => onOpenSession(item.session_id)}
        />
      ))}
    </Stack>
  );
}

function workStatusMeta(item: WorkStatusItemView): string {
  const copy = appCopy.settings.workStatus;
  return [
    copy.states[item.state],
    item.stage ? copy.stages[item.stage] : null,
    item.total_actions > 0 ? copy.actions(item.completed_actions, item.total_actions) : null,
    item.effect_count > 0 ? copy.effects(item.effect_count) : null,
    item.recent_artifacts?.length ? item.recent_artifacts.join(", ") : null,
  ].filter((value): value is string => Boolean(value)).join(" · ");
}
