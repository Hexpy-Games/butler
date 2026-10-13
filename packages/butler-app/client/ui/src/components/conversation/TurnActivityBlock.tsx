import { useAppLocale, appCopy } from "@/app/copy.ts";
import { Stack, Typo, WorkActivityBlock } from "@/butler-ds";
import type { PhaseActivity } from "@/app/conversation-progress";
import { delegatedRequestGoal } from "./delegatedRequestGoal";
import { phaseLabel } from "./phaseLabel";
import { workActivityToolsFromRows } from "./toolchainUtils";

export function ActivityBlock({
  activity,
  connected = false,
  delegatedGoal,
  turnId,
}: {
  activity: PhaseActivity;
  delegatedGoal?: string;
  connected?: boolean;
  turnId?: string;
}) {
  useAppLocale();
  const meta = activity.createdAt
    ? `${phaseLabel(activity.phase)} · ${formatActivityTime(activity.createdAt)}`
    : phaseLabel(activity.phase);
  const summary = delegatedRequestGoal(activity, delegatedGoal);
  return (
    <WorkActivityBlock
      density="compact"
      connected={connected}
      data-work-stage={activity.phase}
      title={activityDisplayTitle(activity)}
      description={
        <Stack as="span" gap="xs">
          <Typo.Caption as="span">{meta}</Typo.Caption>
          {sameActivityText(activity.title, summary) ? null : (
            <Typo.Caption as="span" truncate={summary !== activity.summary}>{appCopy.interfaceDetails.contentLabel} {summary}</Typo.Caption>
          )}
          {activity.rationale ? (
            <Typo.Caption as="span">{appCopy.interfaceDetails.intentLabel} {activity.rationale}</Typo.Caption>
          ) : null}
          {activity.nextStep ? (
            <Typo.Caption as="span">{appCopy.interfaceDetails.nextLabel} {activity.nextStep}</Typo.Caption>
          ) : null}
        </Stack>
      }
      tools={workActivityToolsFromRows(activity.operations, turnId)}
    />
  );
}

/** The activity's public title; the raw request echo reads as "Check request". */
export function activityDisplayTitle(activity: Pick<PhaseActivity, "title">): string {
  return /(?:사용자 요청|User request):/iu.test(activity.title) ? appCopy.guided.tools.start_work : activity.title;
}

function sameActivityText(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\s+/gu, " ");
  return normalize(left) === normalize(right);
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
