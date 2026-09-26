import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { WorkStatusItemView, WorkStatusView } from "@/app/types.ts";
import { MessageSquare, NavRow, NavSectionHeading, Stack, Typo } from "@/butler-ds";

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
        <WorkStatusRow
          key={`${item.session_id}:${item.updated_at}`}
          item={item}
          onOpenSession={onOpenSession}
        />
      ))}
    </Stack>
  );
}

function WorkStatusRow({ item, onOpenSession }: { item: WorkStatusItemView; onOpenSession: (sessionId: string) => void }) {
  const secondLine = [item.latest_report_summary || item.safe_summary, workStatusMeta(item)].filter(Boolean).join(" · ");
  return (
    <NavRow
      dataTestClass="sidebar-work-status-row"
      icon={<MessageSquare />}
      label={secondLine
        ? <Typo.Text lineClamp={2} wrap="anywhere" title={item.safe_title}>{item.safe_title}</Typo.Text>
        : <Typo.Text truncate title={item.safe_title}>{item.safe_title}</Typo.Text>}
      multiline={Boolean(secondLine)}
      meta={secondLine ? <Typo.Caption tone="secondary">{secondLine}</Typo.Caption> : undefined}
      ariaLabel={item.safe_title}
      actionsVisibility="hover"
      onClick={() => onOpenSession(item.session_id)}
    />
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
