import { ACTIVE_TURN_STATES, EMPTY_MODEL_CATALOG } from "./constants.ts";
import { appCopy } from "./copy.ts";
import type {
  ActiveChatView,
  AgentTurnEvent,
  AppModelSummary,
  AppView,
  ContextDetailsView,
  MessageRecord,
  ModelCatalogView,
  NavigationView,
  ProgressRow,
  ReasoningEffort,
  SettingsSectionId,
  SettingsView,
  SessionOption,
  SessionSummary,
  SessionSummaryView,
  TimelineEvent,
  TurnProgressSnapshot,
  WorkerActivitySummary,
  WorkBlockView,
} from "./types.ts";

const CLIENT_TURN_PREFIX = "client-turn-";
const MAX_TURN_PROGRESS_SNAPSHOTS = 80;
const COLLAPSED_WORK_ACTIVITY_KINDS = new Set([
  "searched",
  "read",
  "ran_command",
  "edited",
  "dispatch",
  "used_tool",
]);
const LIFECYCLE_ACTIVITY_LABELS = new Set([
  "accepted",
  "started",
  "thinking",
  "queued for butler service",
  "working on request",
  "checking response",
  "response checked",
  "preparing final answer",
  "final answer ready",
  "completed",
  "delivered",
]);
const WORK_BLOCK_MARKER_KIND = "work_block";
const FIRST_VISIBLE_PROGRESS_EVENT_KIND = "turn.first_progress";
const FIRST_VISIBLE_PROGRESS_WORK_BLOCK_ID_PREFIX = "first-progress-";
const TURN_ACKNOWLEDGED_EVENT_KIND = "turn.acknowledged";
const SESSION_STARTING_STATE = "session_starting";
const PUBLIC_DECISION_SOURCES = new Set([
  "assistant-authored",
  "model-authored",
  "principal-authored",
]);
const RENDERABLE_WORK_DECISION_SOURCES = new Set([
  ...PUBLIC_DECISION_SOURCES,
  "runtime-derived",
]);
const INTERNAL_PROGRESS_TOOL_NAMES = new Set([
  "Update Todo List",
  "List Todo List",
  "Model preparation",
  "모델 준비",
]);
const INTERNAL_PROGRESS_RAW_TOOL_NAMES = new Set([
  "update_todo_list",
  "list_todo_list",
  "model_preparation",
]);
const INACTIVE_COMPOSER_WORKER_PHASES = new Set([
  "blocked",
  "complete",
  "failed",
  "cancelled",
  "recoverable",
]);
export function clientTurnIdFromMessageId(messageId: string): string {
  return `${CLIENT_TURN_PREFIX}${messageId}`;
}

export function isClientTurnId(turnId?: string): boolean {
  return Boolean(turnId?.startsWith(CLIENT_TURN_PREFIX));
}

export function mergeSessionSummaryForPendingTurn(
  current: SessionSummaryView | null,
  incoming: SessionSummaryView,
): SessionSummaryView {
  const terminalMerged = mergeTerminalSameTurnSummary(current, incoming);
  if (terminalMerged) return terminalMerged;
  const activeMerged = mergeActiveSameTurnSummary(current, incoming);
  if (activeMerged) return activeMerged;

  const currentTurnId = current?.latest_progress?.turn_id;
  if (!isClientTurnId(currentTurnId)) return incoming;
  const currentProgress = current?.latest_progress;

  const incomingTurnId = incoming.latest_progress?.turn_id;
  const incomingState =
    incoming.turn_state ?? incoming.latest_progress?.state ?? "";
  const incomingHasActiveProgress = (
    incoming.latest_progress?.safe_progress_rows ?? []
  ).some((row) => ACTIVE_TURN_STATES.has(row.state));
  const incomingHasProgress =
    (incoming.latest_progress?.safe_progress_rows ?? []).length > 0;
  const currentUpdatedAt = timestampMs(currentProgress?.updated_at);
  const incomingUpdatedAt = timestampMs(incoming.latest_progress?.updated_at);
  const hasComparableTiming =
    currentUpdatedAt !== null && incomingUpdatedAt !== null;
  const incomingIsNewerOrSame =
    hasComparableTiming && incomingUpdatedAt >= currentUpdatedAt;
  const incomingIsActive = ACTIVE_TURN_STATES.has(incomingState);
  const incomingIsTerminal = isTerminalProgressState(incomingState);

  if (
    incomingTurnId &&
    incomingTurnId === currentTurnId &&
    (incomingIsActive || incomingIsTerminal)
  ) {
    return incoming;
  }

  if (
    incomingTurnId &&
    incomingTurnId !== currentTurnId &&
    ((incomingIsActive && (incomingHasProgress || !hasComparableTiming)) ||
      (incomingIsNewerOrSame &&
        (incomingIsActive ||
          incomingIsTerminal ||
          incomingHasActiveProgress ||
          incomingHasProgress)))
  ) {
    return incoming;
  }

  return {
    ...incoming,
    latest_progress: current?.latest_progress,
    turn_state: current?.turn_state ?? incoming.turn_state,
  };
}

function mergeActiveSameTurnSummary(
  current: SessionSummaryView | null,
  incoming: SessionSummaryView,
): SessionSummaryView | null {
  const currentLatest = current?.latest_progress;
  const incomingLatest = incoming.latest_progress;
  const turnId = incomingLatest?.turn_id;
  if (!currentLatest?.turn_id || !turnId || currentLatest.turn_id !== turnId) {
    return null;
  }

  const currentState = currentLatest.state ?? current?.turn_state ?? "";
  const incomingState = incomingLatest.state ?? incoming.turn_state ?? "";
  if (
    !shouldPreserveActiveSnapshotOverStaleTerminal(
      currentLatest,
      incomingLatest,
      currentState,
      incomingState,
    )
  ) {
    return null;
  }

  return {
    ...incoming,
    turn_state: currentState || current?.turn_state || incoming.turn_state,
    latest_progress: currentLatest,
  };
}

function mergeTerminalSameTurnSummary(
  current: SessionSummaryView | null,
  incoming: SessionSummaryView,
): SessionSummaryView | null {
  const currentLatest = current?.latest_progress;
  const incomingLatest = incoming.latest_progress;
  const turnId = incomingLatest?.turn_id;
  if (!currentLatest?.turn_id || !turnId || currentLatest.turn_id !== turnId) {
    return null;
  }

  const currentState = currentLatest.state ?? current?.turn_state ?? "";
  const incomingState = incomingLatest.state ?? incoming.turn_state ?? "";
  if (shouldReviveProgressForRetry(currentState, incomingState)) {
    return null;
  }
  if (shouldResetProgressForRetry(currentState, incomingState)) {
    return null;
  }
  if (
    !isTerminalProgressState(currentState) ||
    isTerminalProgressState(incomingState)
  ) {
    return null;
  }

  return {
    ...incoming,
    turn_state: currentState,
    latest_progress: {
      ...incomingLatest,
      ...currentLatest,
      turn_id: turnId,
      state: currentState,
      updated_at:
        newestTimestamp(currentLatest.updated_at, incomingLatest.updated_at) ??
        currentLatest.updated_at ??
        incomingLatest.updated_at,
      safe_progress_rows: mergeProgressRows(
        incomingLatest.safe_progress_rows ?? [],
        currentLatest.safe_progress_rows ?? [],
      ),
    },
  };
}

function timestampMs(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function applyTimelineEvents(
  events: TimelineEvent[],
  activeChatId: string,
  setMessages: (update: (current: MessageRecord[]) => MessageRecord[]) => void,
  setSummary?: (
    update: (current: SessionSummaryView | null) => SessionSummaryView | null,
  ) => void,
  setTurnProgress?: (
    update: (
      current: Record<string, TurnProgressSnapshot>,
    ) => Record<string, TurnProgressSnapshot>,
  ) => void,
): void {
  const patch = collectTimelineEventPatch(events, activeChatId);
  if (setSummary && patch.progressByTurn.size > 0) {
    setSummary((current) => mergeTimelineProgressIntoSummary(current, patch));
  }
  if (setTurnProgress && patch.progressByTurn.size > 0) {
    setTurnProgress((current) =>
      mergeTurnProgressBuckets(current, patch.progressByTurn),
    );
  }
  if (patch.incoming.length > 0 || patch.deletedMessageIds.size > 0) {
    setMessages((current) =>
      removeDeletedMessages(
        mergeMessages(current, patch.incoming),
        patch.deletedMessageIds,
      ),
    );
  }
}

export function applyTimelineEventsToViewState(
  events: TimelineEvent[],
  activeChatId: string,
  state: {
    messages: MessageRecord[];
    summary: SessionSummaryView | null;
    turnProgress: Record<string, TurnProgressSnapshot>;
  },
): {
  messages: MessageRecord[];
  summary: SessionSummaryView | null;
  turnProgress: Record<string, TurnProgressSnapshot>;
} {
  const patch = collectTimelineEventPatch(events, activeChatId);
  if (
    patch.incoming.length === 0 &&
    patch.progressByTurn.size === 0 &&
    patch.deletedMessageIds.size === 0
  ) {
    return state;
  }
  const summary =
    patch.progressByTurn.size > 0
      ? mergeTimelineProgressIntoSummary(state.summary, patch)
      : state.summary;
  const progressByTurn = progressBucketsForActiveClientTurn(
    patch,
    state.summary,
    summary,
  );
  const turnProgress =
    progressByTurn.size > 0
      ? pruneAcknowledgedClientTurnProgress(
          mergeTurnProgressBuckets(state.turnProgress, progressByTurn),
          state.summary,
          summary,
          patch,
        )
      : state.turnProgress;
  const mergedMessages =
    patch.incoming.length > 0
      ? mergeMessages(state.messages, patch.incoming)
      : state.messages;
  const visibleMessages = removeDeletedMessages(
    mergedMessages,
    patch.deletedMessageIds,
  );
  const prunedTurnProgress = pruneReplacedClientTurnProgress(
    turnProgress,
    visibleMessages,
  );
  const messages = freezeMessageWorkBlocks(visibleMessages, prunedTurnProgress);
  return {
    messages,
    summary,
    turnProgress: prunedTurnProgress,
  };
}

export function pruneReplacedClientTurnProgress(
  turnProgress: Record<string, TurnProgressSnapshot>,
  messages: MessageRecord[],
): Record<string, TurnProgressSnapshot> {
  let next: Record<string, TurnProgressSnapshot> | null = null;
  for (const message of messages) {
    if (!message.id || !message.turn_id || isClientTurnId(message.turn_id)) {
      continue;
    }
    const clientTurnId = clientTurnIdFromMessageId(message.id);
    if (!turnProgress[clientTurnId]) continue;
    next ??= { ...turnProgress };
    delete next[clientTurnId];
  }
  return next ?? turnProgress;
}

function pruneAcknowledgedClientTurnProgress(
  turnProgress: Record<string, TurnProgressSnapshot>,
  previousSummary: SessionSummaryView | null,
  nextSummary: SessionSummaryView | null,
  patch: TimelineEventPatch,
): Record<string, TurnProgressSnapshot> {
  const previousTurnId = previousSummary?.latest_progress?.turn_id;
  const nextTurnId = nextSummary?.latest_progress?.turn_id;
  if (
    !previousTurnId ||
    !nextTurnId ||
    !isClientTurnId(previousTurnId) ||
    isClientTurnId(nextTurnId)
  ) {
    return turnProgress;
  }
  const replacement = patch.progressByTurn.get(nextTurnId);
  if (!replacesOptimisticClientTurn(previousSummary, replacement)) {
    return turnProgress;
  }
  if (!turnProgress[previousTurnId]) return turnProgress;
  const next = { ...turnProgress };
  delete next[previousTurnId];
  return next;
}

function progressBucketsForActiveClientTurn(
  patch: TimelineEventPatch,
  previousSummary: SessionSummaryView | null,
  nextSummary: SessionSummaryView | null,
): Map<string, TimelineProgressBucket> {
  const previousLatest = previousSummary?.latest_progress;
  const previousTurnId = previousLatest?.turn_id;
  const previousState = previousLatest?.state ?? previousSummary?.turn_state;
  const nextTurnId = nextSummary?.latest_progress?.turn_id;
  if (
    !previousTurnId ||
    !isClientTurnId(previousTurnId) ||
    !previousState ||
    !ACTIVE_TURN_STATES.has(previousState)
  ) {
    return patch.progressByTurn;
  }
  const replacementTurnId =
    nextTurnId &&
    !isClientTurnId(nextTurnId) &&
    replacesOptimisticClientTurn(
      previousSummary,
      patch.progressByTurn.get(nextTurnId),
    )
      ? nextTurnId
      : undefined;

  const filtered = new Map<string, TimelineProgressBucket>();
  for (const [turnId, bucket] of patch.progressByTurn) {
    if (
      turnId === previousTurnId ||
      turnId === replacementTurnId ||
      !isActiveProgressBucket(bucket)
    ) {
      filtered.set(turnId, bucket);
    }
  }
  return filtered;
}

function isActiveProgressBucket(bucket: TimelineProgressBucket): boolean {
  if (bucket.state && !isTerminalProgressState(bucket.state)) return true;
  return bucket.rows.some((row) => !isTerminalProgressState(row.state));
}

interface TimelineProgressBucket {
  rows: ProgressRow[];
  state?: string;
  label?: string;
  reviveForRetry?: boolean;
  replacesOptimisticClientTurn?: boolean;
}

interface TimelineEventPatch {
  incoming: MessageRecord[];
  deletedMessageIds: Set<string>;
  deletedAssistantTurnIds: Set<string>;
  progressByTurn: Map<string, TimelineProgressBucket>;
  latestProgressTurnId?: string;
  unknownProgressTurn: string;
}

function collectTimelineEventPatch(
  events: TimelineEvent[],
  activeChatId: string,
): TimelineEventPatch {
  const incoming: MessageRecord[] = [];
  const deletedMessageIds = new Set<string>();
  const deletedAssistantTurnIds = new Set<string>();
  const unknownProgressTurn = "__unknown__";
  const progressByTurn = new Map<string, TimelineProgressBucket>();
  let latestProgressTurnId: string | undefined;
  const progressBucket = (turnId?: string) => {
    const key = turnId ?? latestProgressTurnId ?? unknownProgressTurn;
    let bucket = progressByTurn.get(key);
    if (!bucket) {
      bucket = { rows: [] };
      progressByTurn.set(key, bucket);
    }
    if (turnId) latestProgressTurnId = turnId;
    return bucket;
  };
  const noteProgressState = (
    turnId?: string,
    state?: string,
    label?: string,
  ) => {
    const bucket = progressBucket(turnId);
    if (
      state === "retrying" ||
      shouldReviveProgressForRetry(bucket.state ?? "", state ?? "")
    ) {
      bucket.reviveForRetry = true;
    }
    bucket.state = state ?? bucket.state;
    bucket.label = label ?? bucket.label;
  };
  const appendProgressRow = (
    row: ProgressRow,
    turnId?: string,
    state?: string,
    label?: string,
  ) => {
    if (isInternalProgressRow(row)) return;
    const bucket = progressBucket(turnId);
    bucket.rows.push(row);
    const rowState = state ?? row.state;
    bucket.state =
      rowState && !isTerminalProgressState(rowState) ? rowState : bucket.state;
    bucket.label = label ?? bucket.label;
  };
  const noteAssistantMessageTerminalState = (message: MessageRecord): void => {
    if (
      message.role !== "assistant" ||
      !message.turn_id
    ) {
      return;
    }
    if (message.status === "delivered") {
      noteProgressState(message.turn_id, "delivered");
    } else if (message.status === "failed" || message.status === "cancelled") {
      noteProgressState(message.turn_id, message.status);
    }
  };
  for (const event of events ?? []) {
    if (event.type === "message.created") {
      const message = event.payload?.message;
      if (!message || message.chat_id !== activeChatId) continue;
      incoming.push(message);
      noteAssistantMessageTerminalState(message);
      continue;
    }
    if (event.type === "message.updated") {
      const message = event.payload?.message;
      if (!message || message.chat_id !== activeChatId) continue;
      incoming.push(message);
      noteAssistantMessageTerminalState(message);
      continue;
    }
    if (event.type === "message.deleted") {
      const chatId = event.payload?.chat_id;
      const messageId = event.payload?.message_id;
      if (chatId !== activeChatId || !messageId) continue;
      deletedMessageIds.add(messageId);
      if (
        event.payload?.role === "assistant" &&
        typeof event.payload.turn_id === "string" &&
        event.payload.turn_id
      ) {
        deletedAssistantTurnIds.add(event.payload.turn_id);
      }
      continue;
    }
    if (event.type === "turn.state_changed") {
      const turn = event.payload?.turn;
      const sessionId = event.payload?.session_id ?? turn?.chat_id;
      if (sessionId !== activeChatId) continue;
      const incomingTurnId = event.payload?.turn_id ?? turn?.id;
      noteProgressState(
        incomingTurnId,
        event.payload?.state ?? turn?.state,
        event.payload?.safe_status_label ?? turn?.safe_status_label,
      );
      continue;
    }
    if (
      event.type === "context.compaction.started" ||
      event.type === "context.compaction.completed"
    ) {
      if (event.payload?.session_id !== activeChatId) continue;
      incoming.push(systemEventMessageFromEvent(event, activeChatId));
      continue;
    }
    if (event.type === "progress.summary") {
      if (event.payload?.session_id !== activeChatId) continue;
      const row = event.payload.row;
      if (!row?.id) continue;
      appendProgressRow(row, event.payload.turn_id, row.state);
      continue;
    }
    if (event.type === "agent.turn_event") {
      const turnEvent = event.payload?.event;
      if (!turnEvent || turnEvent.sessionId !== activeChatId) continue;
      const row = progressRowFromTurnEvent(turnEvent);
      if (!row) continue;
      if (turnEvent.kind === TURN_ACKNOWLEDGED_EVENT_KIND) {
        progressBucket(turnEvent.turnId).replacesOptimisticClientTurn = true;
      }
      appendProgressRow(row, turnEvent.turnId, row.state);
      continue;
    }
    if (event.type === "agent.turn_event.progress") {
      if (event.payload?.session_id !== activeChatId) continue;
      const row = event.payload.row;
      if (!row?.id) continue;
      appendProgressRow(row, event.payload.turn_id, row.state);
    }
  }
  for (const [turnId, bucket] of progressByTurn) {
    if (
      turnId !== unknownProgressTurn &&
      deletedAssistantTurnIds.has(turnId) &&
      isActiveProgressBucket(bucket)
    ) {
      bucket.reviveForRetry = true;
    }
  }
  return {
    incoming,
    deletedMessageIds,
    deletedAssistantTurnIds,
    progressByTurn,
    latestProgressTurnId,
    unknownProgressTurn,
  };
}

function mergeTimelineProgressIntoSummary(
  current: SessionSummaryView | null,
  patch: TimelineEventPatch,
): SessionSummaryView | null {
  if (!current) return current;
  const latest = current.latest_progress ?? {
    turn_id: patch.latestProgressTurnId,
    safe_progress_rows: [],
  };
  const currentTurnId = latest.turn_id;
  const currentState = latest.state ?? current.turn_state;
  const currentTurnIsActive = Boolean(
    currentTurnId && currentState && ACTIVE_TURN_STATES.has(currentState),
  );
  let selectedTurnId = patch.latestProgressTurnId;
  if (currentTurnIsActive && currentTurnId) {
    if (patch.progressByTurn.has(currentTurnId)) {
      selectedTurnId = currentTurnId;
    } else if (
      patch.latestProgressTurnId &&
      patch.latestProgressTurnId !== currentTurnId
    ) {
      const replacementTurnId = optimisticClientTurnReplacementId(
        currentTurnId,
        patch,
        current,
      );
      if (replacementTurnId) {
        selectedTurnId = replacementTurnId;
      } else {
        return current;
      }
    }
  }
  const selectedKey = selectedTurnId ?? patch.unknownProgressTurn;
  const selected = patch.progressByTurn.get(selectedKey);
  if (!selected) return current;
  const nextTurnId =
    selectedKey === patch.unknownProgressTurn ? latest.turn_id : selectedKey;
  const reviveForRetry =
    selected.reviveForRetry ||
    shouldReviveProgressForRetry(currentState ?? "", selected.state ?? "");
  const resetForRetry = shouldResetProgressForRetry(
    currentState ?? "",
    selected.state ?? "",
  );
  const previousRows =
    resetForRetry || (nextTurnId && latest.turn_id && nextTurnId !== latest.turn_id)
      ? []
      : (latest.safe_progress_rows ?? []);
  const currentStateForMerge =
    resetForRetry || reviveForRetry ? "" : (currentState ?? "");
  const nextState = selected.state
    ? progressMergeState(currentStateForMerge, selected.state)
    : currentState;
  const mergedRows =
    selected.rows.length > 0
      ? mergeProgressRows(previousRows, selected.rows, { reviveForRetry })
      : previousRows;
  const nextRows = progressRowsForMergedTerminalState(mergedRows, nextState);
  const selectedStateWins = selected.state
    ? progressMergeState(currentStateForMerge, selected.state) === selected.state
    : false;
  return {
    ...current,
    turn_state: nextState ?? current.turn_state,
    latest_progress: {
      ...(resetForRetry ? {} : latest),
      turn_id: nextTurnId ?? latest.turn_id,
      safe_progress_rows: nextRows,
      ...(nextState ? { state: nextState } : {}),
      ...(selected.label && selectedStateWins
        ? { summary: selected.label }
        : {}),
    },
  };
}

function optimisticClientTurnReplacementId(
  currentTurnId: string,
  patch: TimelineEventPatch,
  currentSummary?: SessionSummaryView | null,
): string | undefined {
  if (!isClientTurnId(currentTurnId)) return undefined;
  let replacementTurnId: string | undefined;
  for (const [turnId, bucket] of patch.progressByTurn) {
    if (
      turnId !== patch.unknownProgressTurn &&
      !isClientTurnId(turnId) &&
      replacesOptimisticClientTurn(currentSummary, bucket)
    ) {
      replacementTurnId = turnId;
    }
  }
  return replacementTurnId;
}

function replacesOptimisticClientTurn(
  previousSummary: SessionSummaryView | null | undefined,
  bucket: TimelineProgressBucket | undefined,
): boolean {
  if (!bucket) return false;
  if (bucket.replacesOptimisticClientTurn) return true;
  const previousLatest = previousSummary?.latest_progress;
  const previousTurnId = previousLatest?.turn_id;
  const previousState = previousLatest?.state ?? previousSummary?.turn_state;
  return Boolean(
    previousTurnId &&
      isClientTurnId(previousTurnId) &&
      previousState === SESSION_STARTING_STATE &&
      isActiveProgressBucket(bucket),
  );
}

function mergeTurnProgressBuckets(
  current: Record<string, TurnProgressSnapshot>,
  progressByTurn: Map<string, TimelineProgressBucket>,
): Record<string, TurnProgressSnapshot> {
  let changed = false;
  const next = { ...current };
  for (const [turnId, bucket] of progressByTurn) {
    if (!turnId || turnId === "__unknown__") continue;
    const previous = next[turnId];
    const safeRows = bucket.rows.filter((row) => !isInternalProgressRow(row));
    const reviveForRetry =
      bucket.reviveForRetry ||
      shouldReviveProgressForRetry(previous?.state ?? "", bucket.state ?? "");
    const resetForRetry = shouldResetProgressForRetry(
      previous?.state ?? "",
      bucket.state ?? "",
    );
    const previousStateForMerge =
      resetForRetry || reviveForRetry ? "" : (previous?.state ?? "");
    const previousRows = resetForRetry
      ? []
      : (previous?.safe_progress_rows ?? []);
    const mergedRows =
      safeRows.length > 0
        ? mergeProgressRows(previousRows, safeRows, { reviveForRetry })
        : previousRows;
    const nextState = bucket.state
      ? progressMergeState(previousStateForMerge, bucket.state)
      : previous?.state;
    const rows = progressRowsForMergedTerminalState(mergedRows, nextState);
    const bucketStateWins = bucket.state
      ? progressMergeState(previousStateForMerge, bucket.state) === bucket.state
      : false;
    const snapshot = {
      ...(resetForRetry ? {} : previous),
      turn_id: turnId,
      safe_progress_rows: rows,
      ...(nextState ? { state: nextState } : {}),
      ...(bucket.label && (!previous || bucketStateWins)
        ? { summary: bucket.label }
        : {}),
    };
    if (previous && turnProgressSnapshotEqual(previous, snapshot)) continue;
    next[turnId] = snapshot;
    changed = true;
  }
  return changed ? capTurnProgressSnapshots(next) : current;
}

export function mergeTurnProgressFromSummary(
  current: Record<string, TurnProgressSnapshot>,
  summary: SessionSummaryView | null | undefined,
): Record<string, TurnProgressSnapshot> {
  const latest = summary?.latest_progress;
  if (!latest?.turn_id) return current;
  const rows = (latest.safe_progress_rows ?? []).filter(
    (row) => !isInternalProgressRow(row),
  );
  const previous = current[latest.turn_id];
  const incomingState = latest.state ?? summary?.turn_state ?? "";
  if (
    previous &&
    shouldPreserveActiveSnapshotOverStaleTerminal(
      previous,
      { ...latest, turn_id: latest.turn_id, safe_progress_rows: rows },
      previous.state ?? "",
      incomingState,
    )
  ) {
    return current;
  }
  const reviveForRetry = shouldReviveProgressForRetry(
    previous?.state ?? "",
    incomingState,
  );
  const resetForRetry = shouldResetProgressForRetry(
    previous?.state ?? "",
    incomingState,
  );
  const previousStateForMerge =
    resetForRetry || reviveForRetry ? "" : (previous?.state ?? "");
  const nextState = incomingState
    ? progressMergeState(previousStateForMerge, incomingState)
    : previous?.state;
  const incomingStateWins = incomingState
    ? progressMergeState(previousStateForMerge, incomingState) === incomingState
    : true;
  const base = incomingStateWins
    ? { ...(resetForRetry ? {} : previous), ...latest }
    : { ...latest, ...(resetForRetry ? {} : previous) };
  const mergedRows = mergeProgressRows(
    resetForRetry ? [] : (previous?.safe_progress_rows ?? []),
    rows,
    { reviveForRetry },
  );
  const nextSnapshot = {
    ...base,
    turn_id: latest.turn_id,
    ...(nextState ? { state: nextState } : {}),
    safe_progress_rows: progressRowsForMergedTerminalState(mergedRows, nextState),
  };
  if (previous && turnProgressSnapshotEqual(previous, nextSnapshot)) {
    return current;
  }
  return capTurnProgressSnapshots({
    ...current,
    [latest.turn_id]: nextSnapshot,
  });
}

export function activeTurnProgressSnapshot(
  summary: SessionSummaryView | null | undefined,
  turnProgress: Record<string, TurnProgressSnapshot> | null | undefined,
): TurnProgressSnapshot | null {
  const activeSnapshots = Object.entries(turnProgress ?? {})
    .map(([turnId, snapshot], index) => ({
      index,
      turnId,
      snapshot: { ...snapshot, turn_id: snapshot.turn_id ?? turnId },
    }))
    .filter(({ snapshot }) => isActiveTurnProgressSnapshot(snapshot))
    .sort((left, right) => {
      const leftTime = turnProgressSnapshotActivityMs(left.snapshot);
      const rightTime = turnProgressSnapshotActivityMs(right.snapshot);
      if (leftTime !== rightTime) return leftTime - rightTime;
      const leftClient = isClientTurnId(left.turnId) ? 0 : 1;
      const rightClient = isClientTurnId(right.turnId) ? 0 : 1;
      if (leftClient !== rightClient) return leftClient - rightClient;
      return left.index - right.index;
    });
  const latestActive = activeSnapshots.at(-1)?.snapshot;
  if (latestActive) return latestActive;

  const latest = summary?.latest_progress;
  const state = latest?.state ?? summary?.turn_state ?? "";
  if (latest?.turn_id && state && ACTIVE_TURN_STATES.has(state)) {
    return {
      ...latest,
      state,
      safe_progress_rows: latest.safe_progress_rows ?? [],
    };
  }
  return null;
}

function isActiveTurnProgressSnapshot(snapshot: TurnProgressSnapshot): boolean {
  const state = snapshot.state ?? "";
  if (state.length > 0) return !isTerminalProgressState(state);
  return (snapshot.safe_progress_rows ?? []).some(
    (row) => !isTerminalProgressState(row.state),
  );
}

function turnProgressSnapshotActivityMs(
  snapshot: TurnProgressSnapshot,
): number {
  const times = [
    timestampMs(snapshot.updated_at),
    ...(snapshot.safe_progress_rows ?? []).map((row) =>
      timestampMs(row.created_at),
    ),
  ].filter((value): value is number => value !== null);
  return times.length > 0 ? Math.max(...times) : 0;
}

export function mergeTurnProgressSnapshotMap(
  current: Record<string, TurnProgressSnapshot>,
  incoming: Record<string, TurnProgressSnapshot> | null | undefined,
): Record<string, TurnProgressSnapshot> {
  const entries = Object.entries(incoming ?? {});
  if (entries.length === 0) return current;
  let changed = false;
  const next = { ...current };
  for (const [turnId, snapshot] of entries) {
    if (!turnId) continue;
    const previous = next[turnId];
    const safeIncomingRows = (snapshot.safe_progress_rows ?? []).filter(
      (row) => !isInternalProgressRow(row),
    );
    const incomingSnapshot = {
      ...snapshot,
      turn_id: snapshot.turn_id ?? turnId,
      safe_progress_rows: safeIncomingRows,
    };
    if (!previous) {
      next[turnId] = incomingSnapshot;
      changed = true;
      continue;
    }
    const incomingState = snapshot.state ?? "";
    if (
      shouldPreserveActiveSnapshotOverStaleTerminal(
        previous,
        incomingSnapshot,
        previous.state ?? "",
        incomingState,
      )
    ) {
      continue;
    }
    const reviveForRetry = shouldReviveProgressForRetry(
      previous.state ?? "",
      incomingState,
    );
    const resetForRetry = shouldResetProgressForRetry(
      previous.state ?? "",
      incomingState,
    );
    const previousStateForMerge =
      resetForRetry || reviveForRetry ? "" : (previous.state ?? "");
    const nextState = incomingState
      ? progressMergeState(previousStateForMerge, incomingState)
      : previous.state;
    const incomingStateWins = incomingState
      ? progressMergeState(previousStateForMerge, incomingState) ===
        incomingState
      : false;
    const base = incomingStateWins
      ? { ...(resetForRetry ? {} : previous), ...snapshot }
      : { ...snapshot, ...(resetForRetry ? {} : previous) };
    const nextUpdatedAt =
      newestTimestamp(previous.updated_at, snapshot.updated_at) ??
      base.updated_at;
    const nextSnapshot = {
      ...base,
      turn_id: turnId,
      ...(nextState ? { state: nextState } : {}),
      ...(nextUpdatedAt ? { updated_at: nextUpdatedAt } : {}),
      safe_progress_rows: mergeProgressRows(
        resetForRetry ? [] : (previous.safe_progress_rows ?? []),
        safeIncomingRows,
        { reviveForRetry },
      ),
    };
    if (turnProgressSnapshotEqual(previous, nextSnapshot)) continue;
    next[turnId] = nextSnapshot;
    changed = true;
  }
  return changed ? capTurnProgressSnapshots(next) : current;
}

function newestTimestamp(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftMs = timestampMs(left);
  const rightMs = timestampMs(right);
  if (leftMs === null || rightMs === null) {
    return right.localeCompare(left) >= 0 ? right : left;
  }
  return rightMs >= leftMs ? right : left;
}

function capTurnProgressSnapshots(
  snapshots: Record<string, TurnProgressSnapshot>,
): Record<string, TurnProgressSnapshot> {
  const entries = Object.entries(snapshots);
  if (entries.length <= MAX_TURN_PROGRESS_SNAPSHOTS) return snapshots;
  const ranked = entries
    .map(([turnId, snapshot], index) => ({
      turnId,
      snapshot,
      index,
      updatedAt:
        snapshot.updated_at ??
        snapshot.safe_progress_rows.at(-1)?.created_at ??
        "",
    }))
    .sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.index - right.index,
    )
    .slice(-MAX_TURN_PROGRESS_SNAPSHOTS);
  return Object.fromEntries(
    ranked.map((entry) => [entry.turnId, entry.snapshot]),
  );
}

export function completedTurnActivityRows(rows: ProgressRow[]): ProgressRow[] {
  const byKey = new Map<string, ProgressRow>();
  for (const row of rows.filter(isCompletedTurnWorkActivityRow)) {
    byKey.set(progressRowMergeKey(row), row);
  }
  return [...byKey.values()];
}

export function workBlocksFromProgressRows(
  rows: ProgressRow[],
): WorkBlockView[] {
  return buildWorkBlocks(rows, { completedOnly: false });
}

export function completedTurnWorkBlocks(rows: ProgressRow[]): WorkBlockView[] {
  return buildWorkBlocks(rows, { completedOnly: true });
}

export type TypedUiReadModel =
  | { type: "receipt"; label: string; state: string; receiptKind: string }
  | { type: "decision"; summary: string; rationale?: string; nextStep?: string; source: string; modelCallId?: string; latencyMs?: number; evidenceRefs?: string[] }
  | { type: "work_block"; id: string; label?: string; state: string }
  | { type: "tool_control"; toolName: string; inputLabel?: string; label: string; toolCallId?: string; workBlockId?: string }
  | { type: "observation"; label: string; detailRows?: ProgressRow["safe_detail_rows"] }
  | { type: "outcome"; state: string; publicSummary: string }
  | { type: "runtime_fault"; faultId: string; kind: string; retryable: boolean; publicSummary: string; safeErrorCode?: string; safeCause?: string };

export function typedUiReadModelsFromProgressRows(
  rows: ProgressRow[],
): TypedUiReadModel[] {
  return rows.flatMap((row): TypedUiReadModel[] => {
    if (row.runtime_fault_id && row.runtime_fault_kind && row.runtime_fault_public_summary) {
      return [{
        type: "runtime_fault",
        faultId: row.runtime_fault_id,
        kind: row.runtime_fault_kind,
        retryable: row.runtime_fault_retryable === true,
        publicSummary: row.runtime_fault_public_summary,
        safeErrorCode: row.runtime_fault_safe_error_code,
        safeCause: row.runtime_fault_safe_cause,
      }];
    }
    if (row.receipt_kind) {
      return [{
        type: "receipt",
        label: row.safe_label,
        state: row.state,
        receiptKind: row.receipt_kind,
      }];
    }
    const decision = explicitPublicDecisionFieldsFromRow(row);
    if (decision.decision_summary && decision.decision_source) {
      return [{
        type: "decision",
        summary: decision.decision_summary,
        rationale: decision.decision_rationale,
        nextStep: decision.decision_next_step,
        source: decision.decision_source,
        ...(decision.decision_model_call_id ? { modelCallId: decision.decision_model_call_id } : {}),
        ...(decision.decision_latency_ms !== undefined ? { latencyMs: decision.decision_latency_ms } : {}),
        ...(decision.decision_evidence_refs ? { evidenceRefs: decision.decision_evidence_refs } : {}),
      }];
    }
    if (row.kind === WORK_BLOCK_MARKER_KIND && row.work_block_id) {
      return [{
        type: "work_block",
        id: row.work_block_id,
        label: row.work_block_label,
        state: row.state,
      }];
    }
    if (isToolControlReadModelRow(row)) {
      const toolName = row.safe_tool_name ?? "Tool";
      const inputLabel = row.safe_input_label;
      return [{
        type: "tool_control",
        toolName,
        inputLabel,
        label: inputLabel && row.safe_tool_name
          ? `${toolName}: ${inputLabel}`
          : row.safe_tool_name ?? inputLabel ?? "Tool",
        toolCallId: row.tool_call_id,
        workBlockId: row.work_block_id,
      }];
    }
    if (row.kind === "turn" && isTerminalProgressState(row.state)) {
      return [{ type: "outcome", state: row.state, publicSummary: row.safe_label }];
    }
    if (row.safe_detail_rows?.length) {
      return [{ type: "observation", label: row.safe_label, detailRows: row.safe_detail_rows }];
    }
    return [];
  });
}

export function isRuntimeFaultRetryableMessage(
  message: Pick<MessageRecord, "retryable" | "safe_error_code">,
): boolean {
  return message.retryable === true && message.safe_error_code === "runtime_fault";
}

export function freezeMessageWorkBlocks(
  messages: MessageRecord[],
  turnProgress: Record<string, TurnProgressSnapshot>,
): MessageRecord[] {
  let changed = false;
  const next = messages.map((message) => {
    const frozen = freezeMessageWorkBlocksForRecord(
      message,
      message.turn_id ? turnProgress[message.turn_id] : undefined,
    );
    if (frozen !== message) changed = true;
    return frozen;
  });
  return changed ? next : messages;
}

export function freezeMessageWorkBlocksForRecord(
  message: MessageRecord,
  snapshot: TurnProgressSnapshot | null | undefined,
): MessageRecord {
  if (message.role !== "assistant" || !message.turn_id) return message;
  const messageWithCleanBlocks = sanitizeMessageWorkBlocksForRecord(message);
  const blocks = completedMessageWorkBlocksFromSnapshot(
    snapshot,
    terminalProgressStateFromMessageStatus(message.status),
  );
  if (blocks.length === 0) {
    return messageWithCleanBlocks;
  }
  if (
    messageWithCleanBlocks.work_blocks &&
    workBlockArrayEqual(messageWithCleanBlocks.work_blocks, blocks)
  ) {
    return messageWithCleanBlocks;
  }
  return { ...messageWithCleanBlocks, work_blocks: blocks };
}

function sanitizeMessageWorkBlocksForRecord(
  message: MessageRecord,
): MessageRecord {
  const sanitized = sanitizeMessageWorkBlocks(message.work_blocks);
  if (sanitized === message.work_blocks) return message;
  if (!sanitized?.length) {
    const { work_blocks: _workBlocks, ...rest } = message;
    return rest;
  }
  return { ...message, work_blocks: sanitized };
}

function sanitizeMessageWorkBlocks(
  blocks: WorkBlockView[] | undefined,
): WorkBlockView[] | undefined {
  if (!blocks) return blocks;
  let changed = false;
  const sanitized: WorkBlockView[] = [];
  for (const block of blocks) {
    const rows = block.rows.filter((row) =>
      isVisibleToolchainProgressRow(row, block.label),
    );
    if (rows.length === 0) {
      changed = true;
      continue;
    }
    if (rows.length !== block.rows.length) {
      changed = true;
      sanitized.push({ ...block, rows });
      continue;
    }
    sanitized.push(block);
  }
  if (!changed) return blocks;
  return sanitized.length > 0 ? sanitized : undefined;
}

export function completedMessageWorkBlocksFromSnapshot(
  snapshot: TurnProgressSnapshot | null | undefined,
  terminalStateOverride?: string,
): WorkBlockView[] {
  if (!snapshot) return [];
  const snapshotState = terminalStateOverride ?? snapshot.state ?? "";
  const rows = isTerminalProgressState(snapshotState)
    ? (snapshot.safe_progress_rows ?? [])
        .filter((row) => !isFirstVisibleProgressRow(row))
        .map((row) =>
          isTerminalProgressState(row.state)
            ? row
            : { ...row, state: snapshotState },
        )
    : (snapshot.safe_progress_rows ?? []);
  return completedTurnWorkBlocks(rows).filter((block) =>
    block.rows.some((row) => isVisibleToolchainProgressRow(row, block.label)),
  );
}

function terminalProgressStateFromMessageStatus(
  status?: MessageRecord["status"],
): string | undefined {
  if (status === "delivered") return "delivered";
  if (status === "failed") return "failed";
  return undefined;
}

export function isVisibleToolchainProgressRow(
  row: ProgressRow,
  blockLabel: string,
): boolean {
  const normalizedLabel = row.safe_label.trim();
  const normalizedBlockLabel = blockLabel.trim();
  const normalizedToolName = row.safe_tool_name?.trim();
  if (isInternalProgressRow(row)) return false;
  if (row.kind === "todo") return false;
  if (row.kind === "message") return false;
  if (
    normalizedLabel &&
    normalizedLabel === normalizedBlockLabel &&
    !row.safe_input_label &&
    row.kind !== "todo"
  ) {
    return false;
  }
  if (
    normalizedToolName &&
    normalizedToolName === normalizedBlockLabel &&
    !row.tool_call_id &&
    !row.safe_input_label &&
    !row.safe_detail_rows?.length
  ) {
    return false;
  }
  return Boolean(
    row.tool_call_id ||
    row.safe_input_label ||
    row.safe_detail_rows?.length ||
    COLLAPSED_WORK_ACTIVITY_KINDS.has(row.kind ?? ""),
  );
}

function isCompletedTurnWorkActivityRow(row: ProgressRow): boolean {
  if (!row) return false;
  if (isFirstVisibleProgressRow(row)) return false;
  if (isInternalProgressRow(row)) return false;
  if (row.kind === "todo") return false;
  if (row.kind === WORK_BLOCK_MARKER_KIND) return false;
  const kind = row.kind ?? "";
  if (COLLAPSED_WORK_ACTIVITY_KINDS.has(kind)) return true;
  if (row.safe_tool_name || row.safe_input_label) return true;
  if (kind !== "message") return false;
  return !LIFECYCLE_ACTIVITY_LABELS.has(row.safe_label.trim().toLowerCase());
}

function isWorkBlockToolActivityRow(row: ProgressRow): boolean {
  if (row.kind === "message") return false;
  if (row.kind === "dispatch" && !row.tool_call_id) return false;
  return isCompletedTurnWorkActivityRow(row);
}

function isStandaloneWorkBlockMessageRow(row: ProgressRow): boolean {
  return row.kind === "message" && Boolean(row.work_block_id && row.work_block_label);
}

function isToolControlReadModelRow(row: ProgressRow): boolean {
  if (row.kind === "decision" || row.kind === WORK_BLOCK_MARKER_KIND) return false;
  return Boolean(row.safe_tool_name || row.safe_input_label || row.tool_call_id);
}

function isFirstVisibleProgressRow(row: ProgressRow): boolean {
  return row.kind === "message" &&
    Boolean(row.work_block_id?.startsWith(FIRST_VISIBLE_PROGRESS_WORK_BLOCK_ID_PREFIX));
}

function isWorkBlockDecisionCarrierRow(row?: ProgressRow): boolean {
  if (!row) return false;
  return row.kind === WORK_BLOCK_MARKER_KIND || isStandaloneWorkBlockMessageRow(row);
}

function buildWorkBlocks(
  rows: ProgressRow[],
  options: { completedOnly: boolean },
): WorkBlockView[] {
  const blocks = new Map<
    string,
    WorkBlockView & { rowMap: Map<string, ProgressRow> }
  >();
  const ensureBlock = (
    id: string,
    label: string,
    state: string,
    created_at?: string,
    row?: ProgressRow,
  ) => {
    const decision = isWorkBlockDecisionCarrierRow(row)
      ? publicDecisionFieldsFromRow(row)
      : {};
    let block = blocks.get(id);
    if (!block) {
      block = {
        id,
        label,
        state,
        rows: [],
        rowMap: new Map(),
        created_at,
        decision_summary: decision.decision_summary,
        decision_rationale: decision.decision_rationale,
        decision_next_step: decision.decision_next_step,
        decision_source: decision.decision_source,
        decision_evidence_refs: decision.decision_evidence_refs,
      };
      blocks.set(id, block);
      return block;
    }
    block.label = block.label || label;
    block.state = terminalState(block.state, state);
    block.created_at = block.created_at ?? created_at;
    block.decision_summary = block.decision_summary ?? decision.decision_summary;
    block.decision_rationale =
      block.decision_rationale ?? decision.decision_rationale;
    block.decision_next_step =
      block.decision_next_step ?? decision.decision_next_step;
    block.decision_source = block.decision_source ?? decision.decision_source;
    block.decision_evidence_refs =
      block.decision_evidence_refs ?? decision.decision_evidence_refs;
    return block;
  };

  for (const row of sortProgressRowsForDisplay(rows)) {
    if (row.kind === WORK_BLOCK_MARKER_KIND) {
      if (!row.work_block_id) continue;
      const blockId = row.work_block_id;
      ensureBlock(
        blockId,
        row.work_block_label ?? "",
        row.state,
        row.created_at,
        row,
      );
      continue;
    }
    if (isStandaloneWorkBlockMessageRow(row)) {
      const fallbackId = row.work_block_id ?? `row-${row.id}`;
      const blockId = fallbackId;
      const label = row.work_block_label ?? "";
      const block = ensureBlock(blockId, label, row.state, row.created_at, row);
      block.rowMap.set(progressRowMergeKey(row), workBlockToolRow(row));
      block.rows = [...block.rowMap.values()];
      continue;
    }
    if (row.kind === "todo") continue;
    if (!isWorkBlockToolActivityRow(row)) continue;
    const fallbackId = row.work_block_id ?? `row-${row.id}`;
    const blockId = fallbackId;
    const label = row.work_block_label ?? "";
    const block = ensureBlock(blockId, label, row.state, row.created_at, row);
    block.rowMap.set(progressRowMergeKey(row), workBlockToolRow(row));
    block.rows = [...block.rowMap.values()];
  }

  return [...blocks.values()]
    .map(({ rowMap: _rowMap, ...block }) => block)
    .filter((block) => Boolean(block.label.trim()))
    .filter((block) =>
      options.completedOnly
        ? isTerminalProgressState(block.state) ||
          block.rows.some((row) => isTerminalProgressState(row.state))
        : true,
    );
}

function workBlockToolRow(row: ProgressRow): ProgressRow {
  const {
    work_block_label: _workBlockLabel,
    work_decision_summary: _workDecisionSummary,
    work_decision_rationale: _workDecisionRationale,
    work_decision_next_step: _workDecisionNextStep,
    work_decision_source: _workDecisionSource,
    work_decision_evidence_refs: _workDecisionEvidenceRefs,
    ...toolRow
  } = row;
  return toolRow;
}

function terminalState(current: string, next: string): string {
  const rank = (state: string) =>
    state === "failed" || state === "cancelled"
      ? 3
      : state === "delivered" || state === "complete" || state === "completed"
        ? 2
        : state === "running"
          ? 1
          : 0;
  return rank(next) >= rank(current) ? next : current;
}

function progressRowFromTurnEvent(event: AgentTurnEvent): ProgressRow | null {
  if (event.visibility === "internal") return null;
  const payload = safeRecordPayload(event.payload);
  const created_at = event.createdAt;
  if (event.kind === "assistant.public_note") {
    const note = safePublicText(payload.note, "Working");
    const workBlockId = safeOptionalPublicText(payload.workBlockId);
    return {
      id: event.id,
      kind: "message",
      state: "running",
      safe_label: note,
      created_at,
      work_block_id: workBlockId,
      work_block_label: safeOptionalPublicText(payload.workBlockLabel),
      ...publicDecisionFields(payload),
    };
  }
  if (event.kind === FIRST_VISIBLE_PROGRESS_EVENT_KIND) {
    return {
      id: event.id,
      kind: "turn",
      state: "thinking",
      safe_label: safePublicText(payload.note ?? payload.safeLabel, "Working"),
      created_at,
    };
  }
  if (event.kind === TURN_ACKNOWLEDGED_EVENT_KIND) {
    return {
      id: event.id,
      kind: "turn",
      state: "accepted",
      safe_label: safePublicText(
        payload.safeLabel,
        "Request received. Preparing the work.",
      ),
      receipt_kind: TURN_ACKNOWLEDGED_EVENT_KIND,
      created_at,
    };
  }
  if (event.kind === "assistant.decision") {
    const decision = explicitPublicDecisionFields(payload);
    if (!decision.public_decision_summary || !decision.public_decision_source) {
      return null;
    }
    return {
      id: event.id,
      kind: "decision",
      state: "running",
      safe_label: decision.public_decision_summary,
      created_at,
      ...decision,
    };
  }
  if (
    event.kind === "work.block.started" ||
    event.kind === "work.block.updated" ||
    event.kind === "work.block.completed"
  ) {
    const label = safePublicText(payload.label ?? payload.safeLabel, "Working");
    return {
      id: event.id,
      kind: WORK_BLOCK_MARKER_KIND,
      state: event.kind === "work.block.completed" ? "delivered" : "running",
      safe_label: label,
      created_at,
      work_block_id: safeOptionalPublicText(payload.workBlockId) ?? event.id,
      work_block_label: label,
      ...publicDecisionFields(payload),
    };
  }
  if (event.kind === "guard.started" || event.kind === "guard.completed") {
    return {
      id: event.id,
      kind: "system",
      state: event.kind === "guard.started" ? "running" : "delivered",
      safe_label:
        event.kind === "guard.started"
          ? "Checking response"
          : "Response checked",
      created_at,
    };
  }
  if (event.kind.startsWith("tool.")) {
    if (event.kind === "tool.progress" && payload.activityKind === "todo") {
      return {
        id: event.id,
        kind: "todo",
        state: safeOptionalPublicText(payload.state) ?? "running",
        safe_label: safePublicText(payload.safeLabel, "Working step"),
        safe_detail_rows: safeDetailRows(payload.detailRows),
        safe_order: safeOptionalNumber(payload.safeOrder),
        created_at,
      };
    }
    const toolName = safePublicText(payload.toolName, "Tool");
    if (isInternalProgressToolName(toolName)) return null;
    const inputLabel = safeOptionalPublicText(payload.inputLabel);
    const safeLabel = safePublicText(
      payload.safeLabel,
      inputLabel ? `${toolName}: ${inputLabel}` : toolName,
    );
    return {
      id: event.id,
      kind: safeProgressKind(payload.activityKind),
      state:
        event.kind === "tool.failed"
          ? "failed"
          : event.kind === "tool.completed"
            ? "delivered"
            : "running",
      safe_label: safeLabel,
      safe_tool_name: toolName,
      safe_input_label: inputLabel,
      tool_call_id: safeOptionalPublicText(payload.toolCallId),
      bridge_phase: safeOptionalPublicText(payload.bridgePhase),
      work_block_id: safeOptionalPublicText(payload.workBlockId),
      work_block_label: safeOptionalPublicText(payload.workBlockLabel),
      ...publicDecisionFields(payload),
      safe_detail_rows: safeDetailRows(payload.detailRows),
      created_at,
    };
  }
  if (event.kind === "runtime.fault") {
    const faultId = safePublicText(payload.faultId, event.id);
    const kind = safePublicText(payload.kind, "runtime_fault");
    const publicSummary = safePublicText(
      payload.publicSummary,
      "Butler runtime was interrupted before the turn could continue.",
    );
    return {
      id: event.id,
      kind: "runtime_fault",
      state: "runtime_fault",
      safe_label: publicSummary,
      created_at,
      runtime_fault_id: faultId,
      runtime_fault_kind: kind,
      runtime_fault_retryable: payload.retryable === true,
      runtime_fault_public_summary: publicSummary,
      runtime_fault_safe_error_code: safeOptionalPublicText(payload.safeErrorCode),
      runtime_fault_safe_cause: safeOptionalPublicText(payload.safeCause),
    };
  }
  if (
    event.kind === "turn.accepted" ||
    event.kind === "turn.started" ||
    event.kind === "turn.iteration.started"
  ) {
    return {
      id: event.id,
      kind: "turn",
      state: event.kind === "turn.accepted" ? "accepted" : "thinking",
      safe_label:
        event.kind === "turn.accepted" ? "Accepted" : "Working on request",
      created_at,
    };
  }
  if (event.kind === "message.final.started") {
    return {
      id: event.id,
      kind: "message",
      state: "running",
      safe_label: "Preparing final answer",
      created_at,
    };
  }
  if (
    event.kind === "message.final.completed" ||
    event.kind === "turn.completed"
  ) {
    return {
      id: event.id,
      kind: "turn",
      state: "delivered",
      safe_label:
        event.kind === "message.final.completed"
          ? "Final answer ready"
          : "Completed",
      created_at,
    };
  }
  if (event.kind === "turn.failed" || event.kind === "turn.cancelled") {
    const label =
      event.kind === "turn.failed"
        ? safePublicText(payload.safeLabel, "Failed")
        : "Cancelled";
    return {
      id: event.id,
      kind: "turn",
      state: event.kind === "turn.failed" ? "failed" : "cancelled",
      safe_label: label,
      created_at,
    };
  }
  return null;
}

function safeRecordPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

export function isInternalProgressRow(row: ProgressRow): boolean {
  return (
    isInternalProgressToolName(row.safe_tool_name) ||
    isInternalProgressToolName(row.safe_label) ||
    isInternalProgressToolName(row.safe_input_label)
  );
}

function isInternalProgressToolName(value?: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  const normalized = trimmed.toLocaleLowerCase("en-US").replace(/\s+/gu, "_");
  return (
    INTERNAL_PROGRESS_TOOL_NAMES.has(trimmed) ||
    INTERNAL_PROGRESS_RAW_TOOL_NAMES.has(normalized)
  );
}

export function semanticProgressRows(rows: ProgressRow[]): ProgressRow[] {
  const visible = rows.filter((row) => !isInternalProgressRow(row));
  const todoRows = sortProgressRowsForDisplay(
    dedupeProgressForDisplay(visible.filter((row) => row.kind === "todo")),
  );
  if (todoRows.length > 0) return todoRows.slice(0, 8);
  const workRows = dedupeProgressForDisplay(
    visible.filter(
      (row) =>
        row.kind === WORK_BLOCK_MARKER_KIND ||
        Boolean(
          row.work_block_id && row.work_block_label && !row.safe_tool_name,
        ),
    ),
  );
  if (workRows.length > 0) return workRows.slice(-8);
  const messageRows = dedupeProgressForDisplay(
    visible.filter(
      (row) =>
        row.kind === "message" &&
        !LIFECYCLE_ACTIVITY_LABELS.has(row.safe_label.trim().toLowerCase()),
    ),
  );
  if (messageRows.length > 0) return messageRows.slice(-8);
  return dedupeProgressForDisplay(
    visible.filter(
      (row) =>
        !row.safe_tool_name &&
        !row.safe_input_label &&
        !COLLAPSED_WORK_ACTIVITY_KINDS.has(row.kind ?? ""),
    ),
  ).slice(-8);
}

function dedupeProgressForDisplay(rows: ProgressRow[]): ProgressRow[] {
  const byKey = new Map<string, ProgressRow>();
  for (const row of rows) {
    const directKey =
      todoProgressMergeKey(row) ??
      row.work_block_id ??
      row.safe_label.trim().toLowerCase() ??
      row.id;
    const key =
      row.kind === "todo"
        ? (findProgressRowKey(byKey, (candidate) =>
            todoProgressRowsDisplayMatch(candidate, row),
          ) ?? directKey)
        : directKey;
    const previous = byKey.get(key);
    byKey.set(
      key,
      previous && row.kind === "todo" ? mergeProgressRow(previous, row) : row,
    );
  }
  return [...byKey.values()];
}

function todoProgressRowsDisplayMatch(
  left: ProgressRow,
  right: ProgressRow,
): boolean {
  if (left.kind !== "todo" || right.kind !== "todo") return false;
  const leftKey = todoProgressMergeKey(left);
  const rightKey = todoProgressMergeKey(right);
  if (leftKey && rightKey && leftKey === rightKey) return true;

  const leftLabel = normalizeTodoProgressLabel(left.safe_label);
  const rightLabel = normalizeTodoProgressLabel(right.safe_label);
  if (!leftLabel || leftLabel !== rightLabel) return false;

  const leftOrder = progressRowFiniteDisplayOrder(left);
  const rightOrder = progressRowFiniteDisplayOrder(right);
  if (leftOrder !== null && rightOrder !== null)
    return leftOrder === rightOrder;

  const leftStableId = normalizeProgressPart(left.safe_input_label);
  const rightStableId = normalizeProgressPart(right.safe_input_label);
  return !leftStableId || !rightStableId;
}

function sortProgressRowsForDisplay(rows: ProgressRow[]): ProgressRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const orderDelta =
        progressRowDisplayOrder(left.row) - progressRowDisplayOrder(right.row);
      return orderDelta || left.index - right.index;
    })
    .map(({ row }) => row);
}

function progressRowDisplayOrder(row: ProgressRow): number {
  return progressRowFiniteDisplayOrder(row) ?? Number.POSITIVE_INFINITY;
}

function progressRowFiniteDisplayOrder(row: ProgressRow): number | null {
  const order = Number(row.safe_order);
  return Number.isFinite(order) && order >= 0 ? order : null;
}

function safeProgressKind(value: unknown): string {
  const text = safePublicText(value, "used_tool");
  return [
    "searched",
    "read",
    "ran_command",
    "edited",
    "dispatch",
    "used_tool",
    "context",
    "model",
    "message",
    "turn",
    "system",
    "todo",
  ].includes(text)
    ? text
    : "used_tool";
}

function safeDetailRows(value: unknown): ProgressRow["safe_detail_rows"] {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .filter(isPlainRecord)
    .map((row, index) => ({
      id: safePublicText(row.id, `detail-${index + 1}`),
      kind: safeOptionalPublicText(row.kind),
      safe_label: safePublicText(row.safe_label, "Detail"),
      safe_value: safeOptionalPublicText(row.safe_value),
      state: safeOptionalPublicText(row.state),
    }))
    .slice(0, 8);
  return rows.length > 0 ? rows : undefined;
}

function publicDecisionFields(
  payload: Record<string, unknown>,
): Partial<ProgressRow> {
  const source = safeOptionalPublicText(payload.decisionSource);
  if (!isPublicDecisionSource(source)) return {};
  const rawEvidenceRefs = payload.decisionEvidenceRefs ?? payload.evidenceRefs;
  const evidenceRefs = Array.isArray(rawEvidenceRefs)
    ? rawEvidenceRefs
        .map((item) => safeOptionalPublicText(item))
        .filter((item): item is string => Boolean(item))
        .slice(0, 6)
    : undefined;
  const fields: Partial<ProgressRow> = {};
  const summary = safeOptionalPublicText(payload.decisionSummary);
  if (summary) fields.work_decision_summary = summary;
  const rationale = safeOptionalPublicText(payload.decisionRationale);
  if (rationale) fields.work_decision_rationale = rationale;
  const nextStep = safeOptionalPublicText(payload.decisionNextStep);
  if (nextStep) fields.work_decision_next_step = nextStep;
  if (source) fields.work_decision_source = source;
  if (evidenceRefs && evidenceRefs.length > 0)
    fields.work_decision_evidence_refs = evidenceRefs;
  return fields;
}

function explicitPublicDecisionFields(
  payload: Record<string, unknown>,
): Partial<ProgressRow> {
  const source = safeOptionalPublicText(payload.source);
  if (!isPublicDecisionSource(source)) return {};
  const rawEvidenceRefs = payload.evidenceRefs;
  const evidenceRefs = Array.isArray(rawEvidenceRefs)
    ? rawEvidenceRefs
        .map((item) => safeOptionalPublicText(item))
        .filter((item): item is string => Boolean(item))
        .slice(0, 6)
    : undefined;
  const fields: Partial<ProgressRow> = {};
  const role = safeOptionalPublicText(payload.role);
  if (role) fields.public_decision_role = role;
  const summary = safeOptionalPublicText(payload.summary);
  if (summary) fields.public_decision_summary = summary;
  const rationale = safeOptionalPublicText(payload.rationale);
  if (rationale) fields.public_decision_rationale = rationale;
  const nextStep = safeOptionalPublicText(payload.nextStep);
  if (nextStep) fields.public_decision_next_step = nextStep;
  if (source) fields.public_decision_source = source;
  const modelCallId = safeOptionalPublicText(payload.modelCallId);
  if (modelCallId) fields.public_decision_model_call_id = modelCallId;
  const latencyMs = safeOptionalNumber(payload.latencyMs);
  if (latencyMs !== undefined) fields.public_decision_latency_ms = latencyMs;
  if (evidenceRefs && evidenceRefs.length > 0)
    fields.public_decision_evidence_refs = evidenceRefs;
  return fields;
}

function isPublicDecisionSource(source: unknown): source is string {
  return typeof source === "string" && PUBLIC_DECISION_SOURCES.has(source);
}

function publicDecisionFieldsFromRow(row?: ProgressRow): Partial<{
  decision_summary: string;
  decision_rationale: string;
  decision_next_step: string;
  decision_source: string;
  decision_model_call_id: string;
  decision_latency_ms: number;
  decision_evidence_refs: string[];
}> {
  if (!row || !isRenderableWorkDecisionSource(row.work_decision_source)) return {};
  return {
    decision_summary: row.work_decision_summary,
    decision_rationale: row.work_decision_rationale,
    decision_next_step: row.work_decision_next_step,
    decision_source: row.work_decision_source,
    decision_evidence_refs: row.work_decision_evidence_refs,
  };
}

function explicitPublicDecisionFieldsFromRow(row?: ProgressRow): Partial<{
  decision_summary: string;
  decision_rationale: string;
  decision_next_step: string;
  decision_source: string;
  decision_model_call_id: string;
  decision_latency_ms: number;
  decision_evidence_refs: string[];
}> {
  if (
    !row ||
    row.kind !== "decision" ||
    !isPublicDecisionSource(row.public_decision_source)
  ) {
    return {};
  }
  return {
    decision_summary: row.public_decision_summary,
    decision_rationale: row.public_decision_rationale,
    decision_next_step: row.public_decision_next_step,
    decision_source: row.public_decision_source,
    decision_model_call_id: row.public_decision_model_call_id,
    decision_latency_ms: row.public_decision_latency_ms,
    decision_evidence_refs: row.public_decision_evidence_refs,
  };
}

function isRenderableWorkDecisionSource(source: unknown): source is string {
  return typeof source === "string" && RENDERABLE_WORK_DECISION_SOURCES.has(source);
}

function safeOptionalPublicText(value: unknown): string | undefined {
  const text = safePublicText(value, "");
  return text || undefined;
}

function safeOptionalNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return undefined;
  return Math.floor(numberValue);
}

function safePublicText(value: unknown, fallback: string): string {
  const text =
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
      ? String(value)
      : "";
  const normalized = stripUnsafeControlCharacters(text)
    .replace(
      /\b(?:api[_-]?key|token|secret|password|database_url|db_url)\s*[:=]\s*\S+|\b(?:auth|authorization)\s*[:=]\s*(?:bearer\s+)?\S+/giu,
      "[redacted]",
    )
    .replace(/\bbearer\s+[\w.~+/=-]+/giu, "Bearer [redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return fallback;
  if (looksPrivateOrInternalText(normalized)) return fallback;
  const decoded = decodeBase64Candidate(normalized);
  if (decoded && looksPrivateOrInternalText(decoded)) return fallback;
  return normalized.slice(0, 180);
}

function looksPrivateOrInternalText(value: string): boolean {
  if (/<\s*\/?\s*(?:think|thinking|reasoning)\b[^>]*>/iu.test(value))
    return true;
  if (
    /<\|?(?:channel|start|message|assistant|analysis|final)[^>]*\|?>/iu.test(
      value,
    )
  )
    return true;
  if (
    /\b(?:hidden reasoning|chain[- ]of[- ]thought|scratchpad|internal plan|raw transcript|let me think|let's think|i need to think|we need to think|step[- ]by[- ]step reasoning)\b/iu.test(
      value,
    )
  ) {
    return true;
  }
  if (
    /\b(?:tool_call|tool_result|argumentsJson|sessionId|eventId)\b/u.test(value)
  )
    return true;
  if (
    /^\s*[{[]/u.test(value) &&
    /"(?:eventId|sessionId|payload|arguments|tool_call)"/u.test(value)
  ) {
    return true;
  }
  return false;
}

function decodeBase64Candidate(value: string): string | null {
  const compact = value.replace(/\s+/gu, "");
  if (compact.length < 24 || compact.length > 2_048) return null;
  if (!/^[A-Za-z0-9+/=_-]+$/u.test(compact)) return null;
  try {
    const normalized = compact.replace(/-/gu, "+").replace(/_/gu, "/");
    return decodeURIComponent(
      Array.from(
        atob(normalized),
        (character) =>
          `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
      ).join(""),
    );
  } catch {
    return null;
  }
}

function stripUnsafeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function systemEventMessageFromEvent(
  event: TimelineEvent,
  activeChatId: string,
): MessageRecord {
  const compacting = event.type === "context.compaction.started";
  const createdAt = event.created_at ?? new Date().toISOString();
  return {
    id: `system-${event.type}-${event.id ?? createdAt}`,
    chat_id: activeChatId,
    role: "system_event",
    text: compacting
      ? "Context automatically compacting"
      : "Context automatically compacted",
    status: compacting ? "streaming" : "delivered",
    retryable: false,
    cursor: Number(event.id ?? 0) + 0.25,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function removeDeletedMessages(
  messages: MessageRecord[],
  deletedMessageIds: Set<string>,
): MessageRecord[] {
  if (deletedMessageIds.size === 0) return messages;
  const filtered = messages.filter((message) => !deletedMessageIds.has(message.id));
  return filtered.length === messages.length ? messages : filtered;
}

export function mergeMessages(
  current: MessageRecord[],
  incoming: MessageRecord[],
): MessageRecord[] {
  const byId = new Map<string, MessageRecord>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) {
    if (!message?.id) continue;
    const previous = byId.get(message.id);
    byId.set(
      message.id,
      previous ? mergeMessageRecord(previous, message) : message,
    );
  }
  const merged = [...byId.values()].sort(
    (left, right) => messageCursor(left) - messageCursor(right),
  );
  return messageArrayReferencesEqual(current, merged) ? current : merged;
}

export function collapseAssistantAttempts(
  messages: MessageRecord[],
): MessageRecord[] {
  const latestByTurn = new Map<string, MessageRecord>();
  const result: MessageRecord[] = [];
  for (const message of messages) {
    if (message.role === "user" || !message.turn_id) {
      result.push(message);
      continue;
    }
    const previous = latestByTurn.get(message.turn_id);
    if (!previous || messageCursor(message) >= messageCursor(previous)) {
      latestByTurn.set(message.turn_id, message);
    }
  }
  for (const message of messages) {
    if (message.role === "user" || !message.turn_id) continue;
    if (latestByTurn.get(message.turn_id)?.id === message.id)
      result.push(message);
  }
  return result.sort(
    (left, right) => messageCursor(left) - messageCursor(right),
  );
}

function messageCursor(message: MessageRecord): number {
  const cursor = Number(message.cursor ?? 0);
  return Number.isFinite(cursor) ? cursor : 0;
}

function mergeMessageRecord(
  previous: MessageRecord,
  incoming: MessageRecord,
): MessageRecord {
  const next =
    previous.work_blocks?.length && !incoming.work_blocks
      ? { ...incoming, work_blocks: previous.work_blocks }
      : incoming;
  const sanitized = sanitizeMessageWorkBlocksForRecord(next);
  return messageRecordEqual(previous, sanitized) ? previous : sanitized;
}

function mergeProgressRows(
  current: ProgressRow[],
  incoming: ProgressRow[],
  options: { reviveForRetry?: boolean } = {},
): ProgressRow[] {
  const byKey = new Map<string, ProgressRow>();
  for (const row of current) {
    byKey.set(progressRowDirectMergeKey(row), row);
  }
  for (const row of incoming) {
    const directKey = progressRowDirectMergeKey(row);
    let key = directKey;
    const sameToolKey = row.tool_call_id
      ? findProgressRowKey(
          byKey,
          (candidate) => candidate.tool_call_id === row.tool_call_id,
        )
      : null;
    if (sameToolKey) {
      key = sameToolKey;
    } else if (row.tool_call_id && !byKey.has(directKey)) {
      const legacyCandidates = findProgressRowKeys(
        byKey,
        (candidate) =>
          !candidate.tool_call_id &&
          !isTerminalProgressState(candidate.state) &&
          progressRowsSemanticallyMatch(candidate, row),
      );
      if (legacyCandidates.length === 1) key = legacyCandidates[0]!;
    } else if (!row.tool_call_id && !isTerminalProgressState(row.state)) {
      const toolCandidates = findProgressRowKeys(
        byKey,
        (candidate) =>
          Boolean(candidate.tool_call_id) &&
          progressRowsSemanticallyMatch(candidate, row),
      );
      if (toolCandidates.length === 1) key = toolCandidates[0]!;
    }
    const previous = byKey.get(key);
    byKey.set(
      key,
      previous ? mergeProgressRow(previous, row, options) : row,
    );
  }
  const merged = [...byKey.values()];
  return progressRowArrayReferencesEqual(current, merged) ? current : merged;
}

function findProgressRowKey(
  rows: Map<string, ProgressRow>,
  predicate: (row: ProgressRow) => boolean,
): string | null {
  for (const [key, row] of rows) {
    if (predicate(row)) return key;
  }
  return null;
}

function findProgressRowKeys(
  rows: Map<string, ProgressRow>,
  predicate: (row: ProgressRow) => boolean,
): string[] {
  const matches: string[] = [];
  for (const [key, row] of rows) {
    if (predicate(row)) matches.push(key);
  }
  return matches;
}

function progressRowMergeKey(row: ProgressRow): string {
  return progressRowDirectMergeKey(row);
}

function progressRowDirectMergeKey(row: ProgressRow): string {
  if (row.kind === WORK_BLOCK_MARKER_KIND && row.work_block_id)
    return `work:${row.work_block_id}`;
  const todoKey = todoProgressMergeKey(row);
  if (todoKey) return `todo:${todoKey}`;
  if (row.tool_call_id) return `tool:${row.tool_call_id}`;
  const semanticKey = progressRowSemanticMergeKey(row);
  if (semanticKey) return `activity:${semanticKey}:row:${row.id}`;
  return `row:${row.id}`;
}

function progressRowSemanticMergeKey(row: ProgressRow): string | null {
  if (row.kind === "message" || row.kind === "system") return null;
  const todoKey = todoProgressMergeKey(row);
  if (todoKey) return `todo:${todoKey}`;
  const semanticParts = [
    row.kind ?? "",
    row.safe_tool_name ?? "",
    row.safe_input_label ?? "",
    row.safe_label,
  ].map((part) => part.trim().toLowerCase());
  return row.safe_label ? semanticParts.join(":") : null;
}

function todoProgressMergeKey(row: ProgressRow): string | null {
  if (row.kind !== "todo") return null;
  const stableId = normalizeProgressPart(row.safe_input_label);
  if (stableId) return `id:${stableId}`;
  const label = normalizeTodoProgressLabel(row.safe_label);
  return label ? `label:${label}` : null;
}

function normalizeTodoProgressLabel(value?: string): string {
  return normalizeProgressPart(value)
    .replace(/\s*(?:하는\s*)?중입니다$/u, "")
    .replace(/\s*(?:하는\s*)?중$/u, "")
    .trim();
}

function progressRowsSemanticallyMatch(
  left: ProgressRow,
  right: ProgressRow,
): boolean {
  if (left.kind === "message" || left.kind === "system") return false;
  if (right.kind === "message" || right.kind === "system") return false;
  if (left.kind !== right.kind) return false;
  if (!progressRowsHaveCompatibleEvidence(left, right)) return false;
  const leftExact = progressRowSemanticMergeKey(left);
  const rightExact = progressRowSemanticMergeKey(right);
  if (leftExact && rightExact && leftExact === rightExact) return true;

  const leftLabel = normalizeProgressPart(left.safe_label);
  const rightLabel = normalizeProgressPart(right.safe_label);
  if (leftLabel && leftLabel === rightLabel) {
    const leftTool = normalizeProgressPart(left.safe_tool_name);
    const rightTool = normalizeProgressPart(right.safe_tool_name);
    const leftInput = normalizeProgressPart(left.safe_input_label);
    const rightInput = normalizeProgressPart(right.safe_input_label);
    const toolsCompatible = !leftTool || !rightTool || leftTool === rightTool;
    const inputsCompatible =
      !leftInput || !rightInput || leftInput === rightInput;
    return toolsCompatible && inputsCompatible;
  }

  const leftTool = normalizeProgressPart(left.safe_tool_name);
  const rightTool = normalizeProgressPart(right.safe_tool_name);
  const leftInput = normalizeProgressPart(left.safe_input_label);
  const rightInput = normalizeProgressPart(right.safe_input_label);
  return Boolean(
    leftTool &&
    rightTool &&
    leftInput &&
    rightInput &&
    leftTool === rightTool &&
    leftInput === rightInput,
  );
}

function progressRowsHaveCompatibleEvidence(
  left: ProgressRow,
  right: ProgressRow,
): boolean {
  if (
    left.work_block_id &&
    right.work_block_id &&
    left.work_block_id !== right.work_block_id
  )
    return false;
  if (
    !progressDetailRowsCompatible(left.safe_detail_rows, right.safe_detail_rows)
  )
    return false;
  if (left.safe_path_labels?.length && right.safe_path_labels?.length) {
    const rightPaths = new Set(
      right.safe_path_labels.map(normalizeProgressPart),
    );
    return left.safe_path_labels.some((pathLabel) =>
      rightPaths.has(normalizeProgressPart(pathLabel)),
    );
  }
  return true;
}

function progressDetailRowsCompatible(
  leftRows?: ProgressRow["safe_detail_rows"],
  rightRows?: ProgressRow["safe_detail_rows"],
): boolean {
  if (!leftRows?.length || !rightRows?.length) return true;
  const rightById = new Map(rightRows.map((row) => [row.id, row]));
  for (const leftRow of leftRows) {
    const rightRow = rightById.get(leftRow.id);
    if (!rightRow) continue;
    const leftValue = normalizeProgressPart(leftRow.safe_value);
    const rightValue = normalizeProgressPart(rightRow.safe_value);
    if (leftValue && rightValue && leftValue !== rightValue) return false;
  }
  return true;
}

function normalizeProgressPart(value?: string): string {
  return (value ?? "").trim().toLowerCase();
}

function mergeProgressRow(
  current: ProgressRow,
  incoming: ProgressRow,
  options: { reviveForRetry?: boolean } = {},
): ProgressRow {
  const mergedState = progressMergeRowState(current, incoming, options);
  const incomingWins = mergedState === incoming.state;
  const base = incomingWins
    ? { ...current, ...incoming }
    : { ...incoming, ...current };
  const next = {
    ...base,
    state: mergedState,
    safe_label: base.safe_label || current.safe_label || incoming.safe_label,
    safe_tool_name:
      base.safe_tool_name ?? current.safe_tool_name ?? incoming.safe_tool_name,
    safe_input_label:
      base.safe_input_label ??
      current.safe_input_label ??
      incoming.safe_input_label,
    safe_detail_rows:
      base.safe_detail_rows ??
      current.safe_detail_rows ??
      incoming.safe_detail_rows,
    safe_order: base.safe_order ?? current.safe_order ?? incoming.safe_order,
    safe_path_labels:
      base.safe_path_labels ??
      current.safe_path_labels ??
      incoming.safe_path_labels,
    tool_call_id:
      base.tool_call_id ?? current.tool_call_id ?? incoming.tool_call_id,
    work_block_id:
      base.work_block_id ?? current.work_block_id ?? incoming.work_block_id,
    work_block_label:
      base.work_block_label ??
      current.work_block_label ??
      incoming.work_block_label,
    created_at: current.created_at ?? incoming.created_at,
  };
  return progressRowEqual(current, next) ? current : next;
}

function progressMergeRowState(
  current: ProgressRow,
  incoming: ProgressRow,
  options: { reviveForRetry?: boolean },
): string {
  if (
    options.reviveForRetry &&
    current.state === "failed" &&
    !isTerminalProgressState(incoming.state)
  ) {
    return incoming.state;
  }
  return progressMergeState(current.state, incoming.state);
}

function messageRecordEqual(
  left: MessageRecord,
  right: MessageRecord,
): boolean {
  return (
    left.id === right.id &&
    left.chat_id === right.chat_id &&
    left.turn_id === right.turn_id &&
    left.role === right.role &&
    left.text === right.text &&
    left.status === right.status &&
    left.delivery_state === right.delivery_state &&
    stringArrayEqual(left.limitation_codes ?? [], right.limitation_codes ?? []) &&
    stringArrayEqual(left.limitations ?? [], right.limitations ?? []) &&
    left.retryable === right.retryable &&
    left.cursor === right.cursor &&
    left.created_at === right.created_at &&
    left.updated_at === right.updated_at &&
    workBlockArrayEqual(left.work_blocks ?? [], right.work_blocks ?? []) &&
    JSON.stringify(left.attachments ?? []) ===
      JSON.stringify(right.attachments ?? []) &&
    JSON.stringify(left.artifacts ?? []) ===
      JSON.stringify(right.artifacts ?? [])
  );
}

function messageArrayReferencesEqual(
  left: MessageRecord[],
  right: MessageRecord[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function turnProgressSnapshotEqual(
  left: TurnProgressSnapshot,
  right: TurnProgressSnapshot,
): boolean {
  return (
    left.turn_id === right.turn_id &&
    left.summary === right.summary &&
    left.updated_at === right.updated_at &&
    left.state === right.state &&
    left.delivery_state === right.delivery_state &&
    stringArrayEqual(left.limitation_codes ?? [], right.limitation_codes ?? []) &&
    stringArrayEqual(left.limitations ?? [], right.limitations ?? []) &&
    progressRowArrayEqual(
      left.safe_progress_rows ?? [],
      right.safe_progress_rows ?? [],
    )
  );
}

function progressRowArrayReferencesEqual(
  left: ProgressRow[],
  right: ProgressRow[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function stringArrayEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function progressRowArrayEqual(
  left: ProgressRow[],
  right: ProgressRow[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => progressRowEqual(item, right[index]!))
  );
}

function workBlockArrayEqual(
  left: WorkBlockView[],
  right: WorkBlockView[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => workBlockEqual(item, right[index]!))
  );
}

function workBlockEqual(left: WorkBlockView, right: WorkBlockView): boolean {
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.state === right.state &&
    left.decision_summary === right.decision_summary &&
    left.decision_rationale === right.decision_rationale &&
    left.decision_next_step === right.decision_next_step &&
    left.decision_source === right.decision_source &&
    left.created_at === right.created_at &&
    progressRowArrayEqual(left.rows ?? [], right.rows ?? []) &&
    JSON.stringify(left.decision_evidence_refs ?? []) ===
      JSON.stringify(right.decision_evidence_refs ?? [])
  );
}

function progressRowEqual(left: ProgressRow, right: ProgressRow): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.state === right.state &&
    left.safe_label === right.safe_label &&
    left.safe_tool_name === right.safe_tool_name &&
    left.safe_input_label === right.safe_input_label &&
    left.safe_order === right.safe_order &&
    left.tool_call_id === right.tool_call_id &&
    left.work_block_id === right.work_block_id &&
    left.work_block_label === right.work_block_label &&
    left.work_decision_summary === right.work_decision_summary &&
    left.work_decision_rationale === right.work_decision_rationale &&
    left.work_decision_next_step === right.work_decision_next_step &&
    left.work_decision_source === right.work_decision_source &&
    left.created_at === right.created_at &&
    JSON.stringify(left.work_decision_evidence_refs ?? []) ===
      JSON.stringify(right.work_decision_evidence_refs ?? []) &&
    JSON.stringify(left.safe_path_labels ?? []) ===
      JSON.stringify(right.safe_path_labels ?? []) &&
    JSON.stringify(left.safe_detail_rows ?? []) ===
      JSON.stringify(right.safe_detail_rows ?? [])
  );
}

function progressMergeState(current: string, incoming: string): string {
  if (isTerminalProgressState(incoming)) return incoming;
  if (shouldResetProgressForRetry(current, incoming)) return incoming;
  if (shouldReviveProgressForRetry(current, incoming)) return incoming;
  if (isTerminalProgressState(current)) return current;
  return progressStateRank(incoming) >= progressStateRank(current)
    ? incoming
    : current;
}

function progressRowsForMergedTerminalState(
  rows: ProgressRow[],
  state?: string,
): ProgressRow[] {
  if (!isDeliveredProgressState(state)) return rows;
  const filtered = rows.filter((row) => !supersededTerminalFailureProgressRow(row));
  return filtered.length === rows.length ? rows : filtered;
}

function supersededTerminalFailureProgressRow(row: ProgressRow): boolean {
  return row.kind === "turn" && row.state === "failed";
}

function shouldResetProgressForRetry(_current: string, _incoming: string): boolean {
  return false;
}

function shouldReviveProgressForRetry(current: string, incoming: string): boolean {
  return current === "failed" && incoming === "retrying";
}

function shouldPreserveActiveSnapshotOverStaleTerminal(
  current: TurnProgressSnapshot,
  incoming: TurnProgressSnapshot,
  currentState: string,
  incomingState: string,
): boolean {
  if (
    !current.turn_id ||
    !incoming.turn_id ||
    current.turn_id !== incoming.turn_id
  ) {
    return false;
  }
  if (!currentState || isTerminalProgressState(currentState)) return false;
  if (incomingState !== "failed" && incomingState !== "cancelled") return false;
  const currentActivityMs = turnProgressSnapshotActivityMs(current);
  const incomingActivityMs = turnProgressSnapshotActivityMs(incoming);
  return (
    currentActivityMs > 0 &&
    incomingActivityMs > 0 &&
    incomingActivityMs < currentActivityMs
  );
}

function isTerminalProgressState(state: string): boolean {
  return (
    state === "failed" ||
    state === "cancelled" ||
    state === "delivered" ||
    state === "complete" ||
    state === "completed"
  );
}

function isDeliveredProgressState(state?: string): boolean {
  return state === "delivered" || state === "complete" || state === "completed";
}

function progressStateRank(state: string): number {
  if (state === "failed" || state === "cancelled") return 4;
  if (state === "delivered" || state === "complete" || state === "completed")
    return 3;
  if (state === "running" || state === "streaming") return 2;
  if (state === "thinking" || state === "accepted") return 1;
  return 0;
}

export function activeChatFromNavigation(
  navigation: NavigationView,
  activeChatId: string,
): ActiveChatView {
  const draft = parseDraftChatId(activeChatId);
  if (draft.kind === "chat") {
    return {
      title: "오늘의 일을 같이 펼쳐볼까요",
      shortTitle: "New chat",
      project: "",
    };
  }
  if (draft.kind === "project") {
    const project = (navigation.projects ?? []).find(
      (item) => item.id === draft.projectId,
    );
    const projectName = project?.display_name ?? "Project";
    return {
      title: `${projectName}에서 오늘 이어갈 일을 골라볼까요`,
      shortTitle: "New project chat",
      project: projectName,
    };
  }
  for (const chat of navigation.chats ?? []) {
    if (chat.id === activeChatId) {
      return {
        title: chat.title || "New chat",
        shortTitle: chat.title || "New chat",
        project: "",
      };
    }
  }
  for (const project of navigation.projects ?? []) {
    const session = (project.sessions ?? []).find(
      (item) => item.id === activeChatId,
    );
    if (session) {
      return {
        title: session.title || "Project chat",
        shortTitle: session.title || "Project chat",
        project: project.display_name,
      };
    }
  }
  return {
    title: "오늘의 일을 같이 펼쳐볼까요",
    shortTitle: "New chat",
    project: "",
  };
}

export function sessionFromNavigation(
  navigation: NavigationView,
  sessionId: string,
): SessionSummary | null {
  for (const chat of navigation.chats ?? []) {
    if (chat.id === sessionId) return chat;
  }
  for (const project of navigation.projects ?? []) {
    const session = (project.sessions ?? []).find(
      (item) => item.id === sessionId,
    );
    if (session) return session;
  }
  return null;
}

export function activeTitleForView(
  view: AppView,
  activeChat: ActiveChatView,
): { title: string; subtitle?: string } {
  if (view.kind === "settings") return { title: appCopy.settings.title };
  if (view.kind === "automations" || view.kind === "automation-detail")
    return { title: appCopy.automations.title };
  if (view.kind === "project-dashboard")
    return { title: appCopy.sidebar.projectDashboard };
  return { title: activeChat.shortTitle, subtitle: activeChat.project };
}

export function isDraftChatId(value: string): boolean {
  return value === "draft:chat" || value?.startsWith("draft:project:");
}

export function parseDraftChatId(value: string): {
  kind?: "chat" | "project";
  projectId?: string;
} {
  if (value?.startsWith("draft:project:")) {
    return { kind: "project", projectId: value.slice("draft:project:".length) };
  }
  if (value === "draft:chat") return { kind: "chat" };
  return {};
}

export function projectDraftId(projectId: string): string {
  return `draft:project:${projectId}`;
}

export function titleFromPrompt(text: string): string {
  const firstLine = text.trim().split(/\r?\n/u)[0] ?? "";
  const collapsed = firstLine.replace(/\s+/gu, " ").trim();
  if (!collapsed) return "New chat";
  return collapsed.length > 48 ? `${collapsed.slice(0, 45)}...` : collapsed;
}

export function allSessionsFromNavigation(
  navigation: NavigationView,
): SessionOption[] {
  const chatSessions = (navigation.chats ?? []).map((chat) => ({
    id: chat.id,
    label: chat.title,
  }));
  const projectSessions = (navigation.projects ?? []).flatMap((project) =>
    (project.sessions ?? []).map((session) => ({
      id: session.id,
      label: `${project.display_name} / ${session.title}`,
    })),
  );
  return [...chatSessions, ...projectSessions];
}

export function runtimeModels(
  modelCatalog: ModelCatalogView,
): AppModelSummary[] {
  if (Array.isArray(modelCatalog?.registered_models)) {
    const registered = modelCatalog.registered_models.filter(
      (model) => model.runtime_supported === true,
    );
    if (registered.length > 0) return registered;
  }
  const models = modelCatalog?.models?.length
    ? modelCatalog.models
    : EMPTY_MODEL_CATALOG.models;
  const supported = models.filter((model) => model.runtime_supported === true);
  return supported.length > 0 ? supported : EMPTY_MODEL_CATALOG.models;
}

export function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function resolveAppearanceTheme(
  theme: SettingsView["appearance_theme"] | null | undefined,
  prefersDark = systemPrefersDark(),
): "dark" | "light" {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return prefersDark ? "dark" : "light";
}

export function appThemeClasses(
  settings: SettingsView,
  prefersDark?: boolean,
): string {
  const theme = `theme-${resolveAppearanceTheme(
    settings?.appearance_theme,
    prefersDark,
  )}`;
  const sidebar =
    settings?.translucent_sidebar === false
      ? "sidebar-solid"
      : "sidebar-translucent";
  const mainScreenTheme = `main-screen-theme-${settings?.main_screen_theme ?? "bloom"}`;
  return `${theme} ${sidebar} ${mainScreenTheme}`;
}

export function normalizeSettingsSectionId(value: unknown): SettingsSectionId {
  const section = String(value ?? "general").toLocaleLowerCase("en-US");
  if (section === "updates") return "updates";
  if (
    section === "logs" ||
    section.includes("developer-log") ||
    section.includes("log") ||
    section.includes("로그")
  )
    return "logs";
  if (section.includes("appearance")) return "appearance";
  if (section.includes("server") || section.includes("bridge")) return "server";
  if (section.includes("mcp")) return "mcp";
  if (section.includes("skill")) return "skills";
  if (
    section.includes("usage") ||
    section.includes("metrics") ||
    section.includes("사용량")
  )
    return "usage";
  if (section.includes("model") || section.includes("access")) return "models";
  if (
    section.includes("about") ||
    section.includes("info") ||
    section.includes("정보")
  )
    return "about";
  if (section.includes("persona") || section.includes("personal"))
    return "personalization";
  if (section.includes("archive")) return "archives";
  if (
    section.includes("system") ||
    section.includes("event") ||
    section.includes("scheduler") ||
    section.includes("consolidation")
  )
    return "system";
  if (
    section.includes("privacy") ||
    section.includes("data") ||
    section.includes("diagnostic")
  )
    return "privacy";
  return "general";
}

export function relativeAge(value: string | null | undefined): string {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function contextTooltip(context?: ContextDetailsView | null): string {
  if (!context) return "No context yet";
  return `${Math.round(context.used_tokens / 1000)}k / ${Math.round(context.budget_tokens / 1000)}k`;
}

export function modelDisplayName(model?: AppModelSummary | null): string {
  return model?.display_name ?? model?.model_id ?? "Model";
}

export function tokenWindowLabel(tokens: number): string {
  if (!Number.isFinite(tokens)) return "context unknown";
  if (tokens >= 1_000_000)
    return `${Number((tokens / 1_000_000).toFixed(2))}M API context`;
  return `${Math.round(tokens / 1000)}k API context`;
}

export function accessLabel(value: string): string {
  if (value === "ask_first") return appCopy.permissions.askFirst;
  if (value === "read_only") return appCopy.permissions.readOnly;
  return appCopy.permissions.fullAccess;
}

export function accessDescription(value: string): string {
  if (value === "ask_first") return appCopy.permissions.askFirstDesc;
  if (value === "read_only") return appCopy.permissions.readOnlyDesc;
  return appCopy.permissions.fullAccessDesc;
}

export function reasoningLabel(value: ReasoningEffort | string): string {
  if (value === "none") return "Instant";
  if (value === "xhigh") return "Extra High";
  return value ? value[0].toUpperCase() + value.slice(1) : "Medium";
}

export function reasoningOptionLabel(
  model: AppModelSummary | undefined,
  value: ReasoningEffort,
): string {
  if (model?.provider_id === "local" && value !== "none") {
    const ratio = model.local_reasoning_budget_ratio;
    if (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0) {
      return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    }
    const budget = model.reasoning_budget_tokens?.[value];
    if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
      return formatReasoningTokens(budget);
    }
  }
  return reasoningLabel(value);
}

export function reasoningBudgetSummary(
  model: AppModelSummary | undefined,
  value: ReasoningEffort,
): string {
  if (value === "none") return "Instant";
  if (model?.provider_id === "local") return reasoningOptionLabel(model, value);
  const budget = model?.reasoning_budget_tokens?.[value];
  if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
    return formatReasoningTokens(budget);
  }
  return reasoningLabel(value);
}

function formatReasoningTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  const value = tokens / 1000;
  return `${value < 10 && !Number.isInteger(value) ? value.toFixed(1) : Math.round(value)}k`;
}

export function phaseLabel(value: string): string {
  if (value === "orienting") return "Thinking";
  if (value === "planning") return "Planning";
  if (value === "inspecting") return "Inspecting";
  if (value === "executing") return "Executing";
  if (value === "verifying") return "Verifying";
  if (value === "committing") return "Committing";
  if (value === "consolidating") return "Consolidating";
  if (value === "reporting") return "Reporting";
  if (value === "complete") return "Complete";
  if (value === "recoverable") return "Recoverable";
  return value ? value[0].toUpperCase() + value.slice(1) : "Worker";
}

export interface WorkerActivityGroup {
  id: string;
  parent?: WorkerActivitySummary;
  workers: WorkerActivitySummary[];
}

export function isPlannedWorkerActivity(
  worker: WorkerActivitySummary,
): boolean {
  return (
    worker.activity_kind === "planned" ||
    worker.task_id?.startsWith("planned-") === true ||
    /^planned\b/iu.test(workerActivityDisplayName(worker))
  );
}

export function workerActivityDisplayName(worker: WorkerActivitySummary): string {
  const ordinal = worker.worker_ordinal_label?.trim();
  const label = worker.worker_label.trim();
  return (
    worker.worker_display_name?.trim() ||
    (isGenericWorkerLabel(label) ? ordinal : label) ||
    ordinal ||
    "Worker"
  );
}

function isGenericWorkerLabel(label: string): boolean {
  return /^worker$/iu.test(label);
}

export function groupWorkerActivities(
  workers: WorkerActivitySummary[],
): WorkerActivityGroup[] {
  const parentKeys = new Set(
    workers
      .filter(isPlannedWorkerActivity)
      .map((worker) => worker.task_id ?? worker.orchestration_id)
      .filter((key): key is string => Boolean(key)),
  );
  const childrenByParent = new Map<string, WorkerActivitySummary[]>();
  for (const worker of workers) {
    if (isPlannedWorkerActivity(worker) || !worker.orchestration_id) continue;
    const children = childrenByParent.get(worker.orchestration_id) ?? [];
    children.push(worker);
    childrenByParent.set(worker.orchestration_id, children);
  }

  const groups: WorkerActivityGroup[] = [];
  for (const worker of workers) {
    if (isPlannedWorkerActivity(worker)) {
      const key = worker.task_id ?? worker.orchestration_id ?? worker.worker_id;
      const children = childrenByParent.get(key) ?? [];
      groups.push({
        id: `group-${key}`,
        parent: worker,
        workers: children,
      });
      continue;
    }
    if (worker.orchestration_id && parentKeys.has(worker.orchestration_id)) {
      continue;
    }
    groups.push({
      id: `group-${worker.worker_id}`,
      workers: [worker],
    });
  }
  return groups;
}

export function workerActivityStatusLine(
  worker: WorkerActivitySummary,
): string {
  const planned = isPlannedWorkerActivity(worker);
  const statusLine = worker.status_line.trim();
  const currentTitle = worker.current_activity_title?.trim();
  if (worker.terminal)
    return statusLine || currentTitle || phaseLabel(worker.phase);
  if (!planned && currentTitle) return currentTitle;
  return currentTitle || statusLine || phaseLabel(worker.phase);
}

export function workerActivityDescription(
  worker: WorkerActivitySummary,
): string {
  return isPlannedWorkerActivity(worker)
    ? worker.objective
    : workerActivityCollapsedAction(worker);
}

export function workerActivityMeta(
  worker: WorkerActivitySummary,
): string | null {
  const phase = phaseLabel(worker.semantic_phase ?? worker.phase);
  const action = worker.action_kind?.trim();
  return action ? `${phase} · ${action}` : phase;
}

export function workerActivityCollapsedSummaryLine(
  worker: WorkerActivitySummary,
): string {
  const label = workerActivityDisplayName(worker);
  const phase = phaseLabel(worker.semantic_phase ?? worker.phase);
  const action = worker.action_kind?.trim();
  const meta = action ? `${phase}/${action}` : phase;
  return `${label} ${meta}: ${workerActivityCollapsedAction(worker)}`;
}

function workerActivityCollapsedAction(worker: WorkerActivitySummary): string {
  const currentTitle = worker.current_activity_title?.trim();
  if (currentTitle) return currentTitle;
  const statusLine = worker.status_line.trim();
  if (statusLine) return stripWorkerPhasePrefix(statusLine, worker.phase);
  return phaseLabel(worker.phase);
}

function stripWorkerPhasePrefix(
  statusLine: string,
  phase: WorkerActivitySummary["phase"],
): string {
  const prefix = `${phaseLabel(phase)}:`;
  return statusLine
    .toLocaleLowerCase("en-US")
    .startsWith(prefix.toLocaleLowerCase("en-US"))
    ? statusLine.slice(prefix.length).trim()
    : statusLine;
}

export function isWorkerVisibleInComposer(
  worker: WorkerActivitySummary,
  _now = Date.now(),
): boolean {
  const phase = worker.semantic_phase ?? worker.phase;
  return !worker.terminal && !INACTIVE_COMPOSER_WORKER_PHASES.has(phase);
}

export function shouldShowTurnActivity(input: {
  activeTurn: boolean;
  hasTodoProgress: boolean;
  isSending: boolean;
  timelineProgressRowCount: number;
  turnState?: string;
}): boolean {
  if (
    input.activeTurn &&
    !input.isSending &&
    input.timelineProgressRowCount === 0 &&
    !input.hasTodoProgress &&
    isInternalContinuationTurnState(input.turnState)
  ) {
    return false;
  }
  return (
    (input.isSending || input.activeTurn) &&
    (!input.hasTodoProgress || input.timelineProgressRowCount > 0)
  );
}

function isInternalContinuationTurnState(state?: string): boolean {
  return state === "retrying" || state === "waiting_for_tool";
}

export function isWorkerCancellable(worker: WorkerActivitySummary): boolean {
  return !worker.terminal && worker.supported_controls.includes("cancel");
}

export function firstCancellableWorker(
  workers: WorkerActivitySummary[] | null | undefined,
  now = Date.now(),
): WorkerActivitySummary | null {
  return (
    workers?.find(
      (worker) =>
        isWorkerCancellable(worker) && isWorkerVisibleInComposer(worker, now),
    ) ?? null
  );
}

export function hasFollowableWorkerActivity(
  workers: WorkerActivitySummary[] | null | undefined,
  now = Date.now(),
): boolean {
  return Boolean(
    workers?.some((worker) => isWorkerVisibleInComposer(worker, now)),
  );
}

export function workerControlLabel(value: string): string {
  if (value === "resume") return "Request resume";
  if (value === "cancel") return "Request cancel";
  return `Request ${String(value).replace(/_/gu, " ")}`;
}
