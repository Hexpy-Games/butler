import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BtccTurnOutcome,
  BtccTurnRequest,
  BtccWakeCompletionCandidate,
  BtccWakeProjectionHost,
  BtccWakeProjectionSummary,
} from "../contracts.ts";
import type {
  BtccWakeAuthorization,
  TurnRecord,
  TurnStateRepository,
} from "../turn/index.ts";

type WakeAuthorizationStore = {
  validateWake(input: BtccWakeAuthorization): boolean | Promise<boolean>;
};

type WakeQueueItem = {
  version: 1;
  taskId: string;
  sourceTurnId: string;
  authorizationRef: string;
  resultScopeRef?: string;
  request: BtccTurnRequest;
  status: "pending" | "delivered" | "rejected";
  createdAt: string;
  rejectedReason?: string;
};

export function createBtccTrustedWakeProjectionHost(input: {
  turns: Pick<TurnStateRepository, "findTurn">;
  wakeAuthorizations: WakeAuthorizationStore;
  dispatch: (request: BtccTurnRequest) => Promise<BtccTurnOutcome>;
  queueDir: string;
}): BtccWakeProjectionHost {
  mkdirSync(input.queueDir, { recursive: true });
  let running: Promise<BtccWakeProjectionSummary> | null = null;
  return {
    reconcile(candidates) {
      if (running) return running;
      running = reconcile(input, candidates).finally(() => {
        running = null;
      });
      return running;
    },
  };
}

async function reconcile(
  input: Parameters<typeof createBtccTrustedWakeProjectionHost>[0],
  candidates: readonly BtccWakeCompletionCandidate[],
): Promise<BtccWakeProjectionSummary> {
  let authorized = 0;
  let rejected = 0;
  for (const candidate of candidates) {
    try {
      const result = await authorizeCandidate(input, candidate);
      if (result === "authorized") authorized += 1;
      else if (result === "rejected") rejected += 1;
    } catch {
      // A malformed or unavailable completion cannot become an authorized wake.
      rejected += 1;
    }
  }

  let dispatched = 0;
  for (const item of readQueue(input.queueDir)) {
    if (item.status !== "pending") continue;
    const authorization = authorizationForQueueItem(item);
    if (!authorization) {
      writeQueueItem(input.queueDir, {
        ...item,
        status: "rejected",
        rejectedReason: "invalid-typed-wake-queue-item",
      });
      rejected += 1;
      continue;
    }
    let authorizedWake = false;
    try {
      authorizedWake = await input.wakeAuthorizations.validateWake(authorization);
    } catch {
      authorizedWake = false;
    }
    if (!authorizedWake) {
      writeQueueItem(input.queueDir, {
        ...item,
        status: "rejected",
        rejectedReason: "missing-or-mismatched-authorization",
      });
      rejected += 1;
      continue;
    }
    const sourceTurn = await input.turns.findTurn(item.sourceTurnId).catch(() => null);
    if (
      !sourceTurn ||
      sourceTurn.sessionId !== item.request.sessionId ||
      sourceTurn.semanticState === "cancelled" ||
      !sourceTurn.progressDestination ||
      !sameProgressDestination(sourceTurn.progressDestination, item.request)
    ) {
      writeQueueItem(input.queueDir, {
        ...item,
        status: "rejected",
        rejectedReason: "source-turn-is-not-provable",
      });
      rejected += 1;
      continue;
    }
    try {
      const outcome = await input.dispatch(item.request);
      if (outcome.kind === "fenced_pending_persistence") continue;
      writeQueueItem(input.queueDir, { ...item, status: "delivered" });
      dispatched += 1;
    } catch {
      // The same durable wake Turn can be retried by the next host poll.
    }
  }

  return {
    candidates: candidates.length,
    authorized,
    rejected,
    dispatched,
    pending: readQueue(input.queueDir).filter((item) => item.status === "pending").length,
  };
}

async function authorizeCandidate(
  input: Parameters<typeof createBtccTrustedWakeProjectionHost>[0],
  candidate: BtccWakeCompletionCandidate,
): Promise<"authorized" | "rejected" | "already_queued"> {
  const sourceTurnId = candidate.sourceTurnId.trim();
  const authorizationRef = candidate.authorizationRef.trim();
  const resultScopeRef = candidate.resultScopeRef?.trim() || undefined;
  const resultText = candidate.resultText.trim();
  if (
    !candidate.taskId.trim() ||
    !candidate.originSessionId.trim() ||
    !sourceTurnId ||
    !authorizationRef ||
    !resultText
  ) return "rejected";

  const existing = readQueueItem(input.queueDir, candidate.taskId);
  if (existing) {
    if (
      existing.sourceTurnId !== sourceTurnId ||
      existing.authorizationRef !== authorizationRef ||
      (existing.resultScopeRef ?? undefined) !== resultScopeRef
    ) return "rejected";
    return "already_queued";
  }

  let sourceTurn: TurnRecord | null;
  try {
    sourceTurn = await input.turns.findTurn(sourceTurnId);
  } catch {
    return "rejected";
  }
  if (
    !sourceTurn ||
    sourceTurn.sessionId !== candidate.originSessionId ||
    sourceTurn.semanticState === "cancelled" ||
    !sourceTurn.progressDestination
  ) return "rejected";

  const authorization: BtccWakeAuthorization = {
    sourceTurnId,
    authorizationRef,
    ...(resultScopeRef ? { resultScopeRef } : {}),
  };
  let authorized = false;
  try {
    authorized = await input.wakeAuthorizations.validateWake(authorization);
  } catch {
    authorized = false;
  }
  if (!authorized) return "rejected";
  const request = requestForCompletion({
    candidate,
    sourceTurn,
    sourceTurnId,
    authorizationRef,
    resultScopeRef,
    resultText,
  });
  writeQueueItem(input.queueDir, {
    version: 1,
    taskId: candidate.taskId,
    sourceTurnId,
    authorizationRef,
    ...(resultScopeRef ? { resultScopeRef } : {}),
    request,
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  return "authorized";
}

function requestForCompletion(input: {
  candidate: BtccWakeCompletionCandidate;
  sourceTurn: TurnRecord;
  sourceTurnId: string;
  authorizationRef: string;
  resultScopeRef?: string;
  resultText: string;
}): BtccTurnRequest {
  const destination = input.sourceTurn.progressDestination!;
  const triggerId = `btcc-wake-trigger:${input.candidate.taskId}`;
  const turnId = `btcc-wake-turn:${input.candidate.taskId}`;
  const role = input.sourceTurn.context.executionPolicy?.role === "steward"
    ? "steward"
    : "butler";
  return {
    turnId,
    sessionId: input.sourceTurn.sessionId,
    eventId: triggerId,
    transport: destination.transport,
    accountId: destination.accountId,
    peer: { ...destination.peer },
    sender: { id: "btcc-worker-completion" },
    message: {
      id: triggerId,
      content: input.resultText,
      timestamp: new Date().toISOString(),
    },
    trigger: {
      kind: "authorized_wake",
      triggerId,
      sourceTurnId: input.sourceTurnId,
      authorizationRef: input.authorizationRef,
      ...(input.resultScopeRef ? { resultScopeRef: input.resultScopeRef } : {}),
    },
    route: {
      role,
      workspacePath: input.sourceTurn.context.executionPolicy?.workspacePath ?? "",
      ...(input.sourceTurn.context.projectRef
        ? { projectId: input.sourceTurn.context.projectRef }
        : {}),
      reason: destination.transport === "app" ? "app-worker-result" : "transport-binding",
    },
    progressDestination: { ...destination, peer: { ...destination.peer } },
  };
}

function authorizationForQueueItem(
  item: WakeQueueItem,
): BtccWakeAuthorization | null {
  const request = item.request;
  const trigger = request?.trigger;
  if (
    !trigger ||
    trigger.kind !== "authorized_wake" ||
    request?.turnId !== `btcc-wake-turn:${item.taskId}` ||
    request.eventId !== trigger.triggerId ||
    request.message?.id !== trigger.triggerId ||
    trigger.sourceTurnId !== item.sourceTurnId ||
    trigger.authorizationRef !== item.authorizationRef ||
    (trigger.resultScopeRef ?? undefined) !== (item.resultScopeRef ?? undefined)
  ) return null;
  return {
    sourceTurnId: item.sourceTurnId,
    authorizationRef: item.authorizationRef,
    ...(item.resultScopeRef ? { resultScopeRef: item.resultScopeRef } : {}),
  };
}

function sameProgressDestination(
  source: NonNullable<TurnRecord["progressDestination"]>,
  request: BtccTurnRequest,
): boolean {
  const destination = request.progressDestination;
  return Boolean(
    destination &&
    destination.transport === source.transport &&
    destination.accountId === source.accountId &&
    destination.peer.kind === source.peer.kind &&
    destination.peer.id === source.peer.id &&
    (destination.peer.parentId ?? undefined) === (source.peer.parentId ?? undefined) &&
    destination.replyToMessageId === source.replyToMessageId,
  );
}

function queuePath(queueDir: string, taskId: string): string {
  const hash = createHash("sha256").update(taskId).digest("hex");
  return join(queueDir, `${hash}.json`);
}

function readQueueItem(queueDir: string, taskId: string): WakeQueueItem | null {
  const path = queuePath(queueDir, taskId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as WakeQueueItem;
    return parsed?.version === 1 && parsed.taskId === taskId ? parsed : null;
  } catch {
    return null;
  }
}

function readQueue(queueDir: string): WakeQueueItem[] {
  if (!existsSync(queueDir)) return [];
  return readdirSync(queueDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      try {
        return JSON.parse(readFileSync(join(queueDir, entry), "utf8")) as WakeQueueItem;
      } catch {
        return null;
      }
    })
    .filter((item): item is WakeQueueItem => item?.version === 1)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function writeQueueItem(queueDir: string, item: WakeQueueItem): void {
  mkdirSync(queueDir, { recursive: true });
  writeFileSync(queuePath(queueDir, item.taskId), `${JSON.stringify(item, null, 2)}\n`, "utf8");
}
