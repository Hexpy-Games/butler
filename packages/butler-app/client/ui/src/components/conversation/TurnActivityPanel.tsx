import { useThinkingRows } from "./useThinkingRows";
import { useModelThinking } from "@/app/modelThinking";
import { useId, type ReactNode } from "react";
import { useAppLocale } from "@/app/copy.ts";
import { projectTurnActivity, type TurnActivityProjection } from "@/app/conversation-progress";
import type { ProgressRow } from "@/app/types.ts";
import { CurrentTurnStatus } from "./CurrentTurnStatus";
import { TurnActivityTimeline } from "./TurnActivityTimeline";
import { TurnDecisionRow } from "./TurnDecisionRow";
import { Stack } from "@/butler-ds";
import { TurnActivityPending } from "./TurnActivityPending";
import { appCopy } from "@/app/copy.ts";
import { CollapsedTurnActivity } from "./WorkBlocks";
import { chatActivityLabel } from "./chatActivityLabel";

/** Live progress of the running turn, attached to its message or its own row. */
export interface LiveTurnActivity {
  rows: ProgressRow[];
  state?: string;
  turnId?: string;
  startedAt?: string;
}

/** Activity row before the first answer text: the work, then the live status line (대화: the line alone). */
export function TurnActivityPanel({ rows, state, turnId, startedAt, chat = false }: LiveTurnActivity & { chat?: boolean }) {
  useAppLocale();
  // Pending and current status are different trees, so the status mark remounts when work
  // arrives; one key per panel lets it continue the morph instead of restarting from the logo.
  const markKey = useId();
  const projection = projectTurnActivity(useThinkingRows(rows, turnId), turnId);
  if (chat || !hasLiveWork(projection)) return <TurnActivityStatus markKey={markKey} rows={rows} state={state} turnId={turnId} startedAt={startedAt} chat={chat} />;
  return (
    <Stack
      as="section"
      gap="md"
      data-test-class="turn-activity-panel turn-work-panel turn-decision-work-panel"
      aria-label={appCopy.conversation.work.historyRegionLabel}
    >
      {projection.phaseActivities.length > 0
        ? <TurnActivityTimeline activities={projection.phaseActivities} currentState={projection.semanticState} live turnId={turnId} />
        : liveTurnWork(projection, turnId)}
      <TurnActivityStatus markKey={markKey} rows={rows} state={state} turnId={turnId} startedAt={startedAt} />
    </Stack>
  );
}

/** Live work that has no phase timeline: work blocks, or the latest decision. */
export function liveTurnWork(projection: TurnActivityProjection, turnId?: string): ReactNode {
  const { decisions, modelRoundWait, operation, publicActivity, workBlocks } = projection;
  if (workBlocks.length > 0) return <CollapsedTurnActivity blocks={workBlocks} live turnId={turnId} />;
  const showDecision = decisions.length > 0 && !publicActivity && !modelRoundWait && !operation;
  return showDecision ? <TurnDecisionRow decision={decisions.at(-1)!} /> : null;
}

/** The live status line: pending label before any work, then the current step (대화: the current tool) and timer. */
export function TurnActivityStatus({ markKey: sharedMarkKey, rows, state, turnId, startedAt, chat = false }: LiveTurnActivity & { markKey?: string; chat?: boolean }) {
  useAppLocale();
  const thinkingLine = useModelThinking(store => turnId ? store.lines[turnId] : undefined);
  const ownMarkKey = useId();
  const markKey = sharedMarkKey ?? ownMarkKey;
  const projection = projectTurnActivity(useThinkingRows(rows, turnId), turnId);
  const { modelRoundWait, operation, phaseActivities, publicActivity, readModels } = projection;
  if (!hasLiveWork(projection)) return <TurnActivityPending markKey={markKey} readModels={readModels} state={state} />;
  return (
    <CurrentTurnStatus
      thinkingLine={thinkingLine}
      markKey={markKey}
      state={state}
      waitingForAnswer={rows.some((row) => row.safe_tool_name === "ask_user")}
      activityLabel={chat ? chatActivityLabel(phaseActivities) : undefined}
      modelRoundWait={modelRoundWait}
      operation={operation}
      publicActivity={publicActivity}
      phaseLabel={phaseActivities.at(-1)?.summary}
      startedAt={startedAt ?? earliestProgressTimestamp(rows)}
    />
  );
}

function hasLiveWork({ decisions, workBlocks, phaseActivities, publicActivity, modelRoundWait, operation }: TurnActivityProjection) {
  return decisions.length > 0 || workBlocks.length > 0 || phaseActivities.length > 0 ||
    Boolean(publicActivity || modelRoundWait || operation);
}

function earliestProgressTimestamp(rows: ProgressRow[]): string | undefined {
  return rows
    .map((row) => row.created_at)
    .filter((value): value is string =>
      typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}
