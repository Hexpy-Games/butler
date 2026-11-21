import { formatInterfaceText, getAppCopy, type AppCopy, type AppLocale } from "../../../butler-i18n/src/index.ts";
import type { ConversationMessage, ProgressSummaryRow, SessionView } from "../../../butler-protocol/src/index.ts";
import { mergeToolRows } from "../../../butler-progress-projection/src/index.ts";
import { progressRowLabel, visibleRows } from "./workStatus";

export type Activity = {
  id: string; phase?: string; title: string; summary: string; rationale?: string;
  nextStep?: string; createdAt?: string; operations: ProgressSummaryRow[]; turnId?: string;
};

/** Port of desktop app/conversation-progress/activity.ts. */
export function projectActivities(rows: ProgressSummaryRow[], turnId: string | undefined, locale: AppLocale): { activities: Activity[]; semanticState?: string } {
  const ordered = mergeToolRows(orderedProgressRows(visibleRows(rows).map(row => localizeProgressRow(row, locale))));
  const activityRows = ordered.filter(row => row.kind !== "todo");
  const phases = phaseActivityRows(activityRows);
  const activities = (phases.length ? phases : fallbackOrdinaryActivity(activityRows, turnId, getAppCopy(locale)))
    .map(activity => ({ ...activity, turnId }));
  return { activities, semanticState: currentSemanticState(activityRows, activities) };
}

function localizeProgressRow(row: ProgressSummaryRow, locale: AppLocale): ProgressSummaryRow {
  const content = row.interface_content;
  if (!content && !row.interface_label_key && progressRowLabel(row, locale) === row.safe_label) return row;
  return { ...row, safe_label: progressRowLabel(row, locale),
    ...(content?.title ? { work_decision_title: formatInterfaceText(content.title, locale), work_block_label: formatInterfaceText(content.title, locale) } : {}),
    ...(content?.summary ? { work_decision_summary: formatInterfaceText(content.summary, locale) } : {}),
    ...(content?.nextStep ? { work_decision_next_step: formatInterfaceText(content.nextStep, locale) } : {}),
  };
}

function phaseActivityRows(rows: ProgressSummaryRow[]): Activity[] {
  const activities: Activity[] = [];
  const authoredBlocks = new Set(rows.filter(isPhaseActivityRow).map((row) => row.semantic_block_id));
  const currentByBlock = new Map<string, Activity>();
  const operationsBeforeActivity = new Map<string, ProgressSummaryRow[]>();
  const thinkingBeforeActivity: ProgressSummaryRow[] = [];
  const positions = new Map(rows.map((row, index) => [row, index]));
  for (const row of rows) {
    if (isPhaseActivityRow(row)) {
      const activity: Activity = {
        id: row.id,
        phase: row.activity_stage,
        title: row.work_decision_title ??
          compactLegacyDisplayTitle(row.work_decision_summary),
        summary: row.work_decision_summary,
        rationale: row.work_decision_rationale,
        nextStep: row.work_decision_next_step,
        createdAt: row.created_at,
        operations: [...thinkingBeforeActivity.splice(0), ...(operationsBeforeActivity.get(row.semantic_block_id) ?? [])]
          .sort((left, right) => positions.get(left)! - positions.get(right)!),
      };
      operationsBeforeActivity.delete(row.semantic_block_id);
      activities.push(activity);
      currentByBlock.set(row.semantic_block_id, activity);
      continue;
    }
    if (row.bridge_phase === "model_round_waiting" && row.thinking_title) {
      const latest = activities.at(-1);
      if (latest) latest.operations.push(row); else thinkingBeforeActivity.push(row);
      continue;
    }
    if (row.bridge_phase !== "btcc_operation" || !row.semantic_block_id) continue;
    const activity = currentByBlock.get(row.semantic_block_id) ??
      (!authoredBlocks.has(row.semantic_block_id) ? activities.at(-1) : undefined);
    if (activity) {
      activity.operations.push(row);
    } else {
      // Work acceptance can publish its operation before the accepted activity.
      const operations = operationsBeforeActivity.get(row.semantic_block_id) ?? [];
      operations.push(row);
      operationsBeforeActivity.set(row.semantic_block_id, operations);
    }
  }
  return activities;
}

function isPhaseActivityRow(row: ProgressSummaryRow): row is ProgressSummaryRow & {
  semantic_block_id: string;
  work_decision_summary: string;
} {
  return row.kind === "message" && !row.work_block_id &&
    Boolean(row.semantic_block_id) &&
    row.work_decision_source === "model-authored" &&
    Boolean(row.work_decision_summary);
}

function currentSemanticState(
  rows: ProgressSummaryRow[],
  activities: Activity[],
): string | undefined {
  const latestModelActivity = findLatest(rows, (row) =>
    (row.work_decision_source === "model-authored" ||
      (row.kind === "message" &&
        row.bridge_phase !== "btcc_operation" &&
        row.bridge_phase !== "model_round_waiting" &&
        Boolean(row.semantic_block_id))));
  if (latestModelActivity?.activity_stage) return latestModelActivity.activity_stage;
  return activities.at(-1)?.phase;
}

function orderedProgressRows(rows: ProgressSummaryRow[]): ProgressSummaryRow[] {
  if (rows.some((row) => finiteSequence(row.turn_event_sequence) === undefined)) {
    return [...rows];
  }
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftSequence = finiteSequence(left.row.turn_event_sequence);
      const rightSequence = finiteSequence(right.row.turn_event_sequence);
      return (leftSequence ?? 0) - (rightSequence ?? 0) || left.index - right.index;
    })
    .map(({ row }) => row);
}

function finiteSequence(value?: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function findLatest(
  rows: ProgressSummaryRow[],
  predicate: (row: ProgressSummaryRow) => boolean,
): ProgressSummaryRow | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row && predicate(row)) return row;
  }
  return undefined;
}

/**
 * Presentation-only grouping for orphan ordinary-tool rows. It deliberately
 * carries no phase, Work, or authority fields and is scoped to one Turn.
 */
export function fallbackOrdinaryActivity(
  rows: ProgressSummaryRow[],
  turnId: string | undefined,
  appCopy: AppCopy,
): Activity[] {
  const resolvedTurnId = resolveTurnId(rows, turnId);
  if (!resolvedTurnId) return [];
  const operations = dedupeOrdinaryOperations(rows, resolvedTurnId);
  if (operations.length === 0) return [];
  const first = operations[0];
  return [{
    id: first.semantic_block_id?.trim() || `turn:${resolvedTurnId}:ordinary`,
    title: appCopy.interfaceStatus.working,
    summary: appCopy.interfaceStatus.working,
    createdAt: first.created_at,
    operations,
  }];
}

function resolveTurnId(rows: ProgressSummaryRow[], turnId?: string): string | undefined {
  const explicitTurnId = turnId?.trim();
  if (explicitTurnId) return explicitTurnId;
  const rowTurnIds = new Set(rows.map((row) => row.turn_id?.trim()).filter(Boolean));
  if (rowTurnIds.size !== 1) return undefined;
  const [resolvedTurnId] = rowTurnIds;
  return resolvedTurnId;
}

function dedupeOrdinaryOperations(rows: ProgressSummaryRow[], turnId: string): ProgressSummaryRow[] {
  const seenToolCallIds = new Set<string>();
  const seenRowIds = new Set<string>();
  const operations: ProgressSummaryRow[] = [];
  for (const row of mergeToolRows(rows)) {
    if (
      (row.bridge_phase !== "btcc_operation" && !(row.bridge_phase === "model_round_waiting" && row.thinking_title)) ||
      (row.turn_id !== undefined && row.turn_id.trim() !== turnId) ||
      row.work_block_id ||
      row.work_contract_id ||
      row.work_stream_id
    ) continue;
    const toolCallId = row.tool_call_id?.trim();
    if (seenRowIds.has(row.id) || (toolCallId && seenToolCallIds.has(toolCallId))) continue;
    seenRowIds.add(row.id);
    if (toolCallId) seenToolCallIds.add(toolCallId);
    operations.push(row);
  }
  return operations;
}

function compactLegacyDisplayTitle(value: string): string {
  const title = value.trim();
  const segments = Array.from(title);
  return segments.length <= 24 ? title : `${segments.slice(0, 24).join("")}…`;
}

/** Port of observerActivitySources and SessionObserverStepTimeline's projection. */
export function observerActivities(view: SessionView, locale: AppLocale): (Activity & { actionKey?: string | null })[] {
  const { messages, activity_history: activityHistory = [], active_turn: activeTurn, latest_turn: latestTurn } = view;
  const sources = new Map<string, { turn_id: string; created_at?: string; rows: NonNullable<ConversationMessage["turn_activity_rows"]> }>(
    activityHistory.map((source) => [source.turn_id, source]),
  );
  for (const message of messages) {
    if (message.role === "assistant" && message.turn_id && message.turn_activity_rows?.length) {
      sources.set(message.turn_id, { turn_id: message.turn_id,
        created_at: message.turn_activity_rows.find((row) => row.created_at)?.created_at ?? message.created_at,
        rows: message.turn_activity_rows });
    }
  }
  // Child session messages do not carry turn_activity_rows. The gateway keeps
  // their public record on latest_turn.progress even after active_turn clears.
  if (latestTurn && !sources.has(latestTurn.id)) sources.set(latestTurn.id, {
    turn_id: latestTurn.id, created_at: latestTurn.created_at,
    rows: latestTurn.progress?.safe_progress_rows ?? [],
  });
  if (activeTurn) sources.set(activeTurn.id, { turn_id: activeTurn.id,
    created_at: activeTurn.created_at, rows: activeTurn.progress?.safe_progress_rows ?? [] });
  return [...sources.values()].flatMap(source => {
    const authored = new Map(source.rows.filter(row => row.work_decision_source === "model-authored").map(row => [row.id, row.action_key]));
    return projectActivities(source.rows, source.turn_id, locale).activities.map(activity => ({
      ...activity, turnId: source.turn_id, actionKey: authored.get(activity.id), createdAt: activity.createdAt ?? source.created_at,
    }));
  }).sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""));
}

export function activityTail(activities: Activity[], copy: AppCopy): { previous?: string; earlier: number } {
  const previous = activities.at(-2);
  return { previous: previous ? activityDisplayTitle(previous, copy) : undefined, earlier: Math.max(0, activities.length - 1) };
}

export function activityDisplayTitle(activity: Pick<Activity, "title">, copy: AppCopy): string {
  return /(?:사용자 요청|User request):/iu.test(activity.title) ? copy.guided.tools.start_work : activity.title;
}

export function delegatedRequestGoal(activity: Activity, goal: string | undefined, appCopy: AppCopy): string {
  // Legacy delegated plans copied the worker brief into the initial note.
  // Only the explicitly quoted original request is suitable for this surface.
  if (goal?.trim()) return goal.replace(/\s+/gu, " ").trim();
  const request = /(?:사용자 요청|User request):\s*(?:'(.+?)'(?=\s|$)|"(.+?)"(?=\s|$)|‘(.+?)’|“(.+?)”)/iu.exec(activity.summary);
  if (/(?:사용자 요청|User request):/iu.test(activity.summary)) {
    const title = /(?:사용자 요청|User request):/iu.test(activity.title)
      ? appCopy.guided.tools.start_work! : activity.title;
    return (request?.slice(1).find(Boolean) ?? title).replace(/\s+/gu, " ").trim();
  }
  return activity.summary;
}
