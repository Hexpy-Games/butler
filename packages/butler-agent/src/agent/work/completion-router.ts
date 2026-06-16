import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { PlannedTaskStore, type PlannedTaskRecord, type PlannedTaskStatus } from "./planned-task.ts";
import { TaskNotificationQueue } from "./task-notifications.ts";
import { TaskStore, workSafetyForTask, type TaskRecord } from "./task-store.ts";
import { buildTaskOriginContext, type TaskCompletionOwner, type TaskOriginContext } from "./task-origin.ts";
import { WorkOrchestrationStore } from "./work-orchestration.ts";

export type CompletionConsumer = TaskCompletionOwner;

export interface PlannedWorkerPromotion {
  plannedTaskId: string;
  workerTaskId: string;
  attempt: number;
  reviewEventId: string;
  originSessionId?: string;
  status: "WORKER_DONE" | "WORKER_FAILED";
}

export interface CompletionRouteResult {
  promotions: PlannedWorkerPromotion[];
  enqueued: number;
}

interface CompletionClaim {
  version: 1;
  kind: "planned-review";
  owner: CompletionConsumer;
  planned_task_id: string;
  worker_task_id: string;
  attempt: number;
  claimed_at: string;
}

export function completionConsumerForTransport(transport: string): CompletionConsumer {
  return transport === "app" ? "app" : "native";
}

export function completionOwnerForSessionId(sessionId: string | null | undefined): CompletionConsumer {
  return sessionId?.startsWith("butler/app-") ? "app" : "native";
}

export function completionOwnerForOrigin(origin: TaskOriginContext | null | undefined): CompletionConsumer {
  if (origin?.completion?.owner === "app" || origin?.completion?.owner === "native") {
    return origin.completion.owner;
  }
  return completionOwnerForSessionId(origin?.origin_session_id);
}

export function routeCompletionNotifications(input: {
  butlerData: string;
  consumer: CompletionConsumer;
}): CompletionRouteResult {
  const promotions = claimPlannedWorkerCompletions(input);
  const enqueued = enqueueOwnedNotifications(input);
  return { promotions, enqueued };
}

export function claimPlannedWorkerCompletions(input: {
  butlerData: string;
  consumer: CompletionConsumer;
}): PlannedWorkerPromotion[] {
  const taskStore = new TaskStore(input.butlerData);
  const plannedStore = new PlannedTaskStore(input.butlerData);
  const promotions: PlannedWorkerPromotion[] = [];
  const seen = new Set<string>();

  for (const task of taskStore.reportableTasks()) {
    const plannedLink = plannedStore.findByWorkerTaskId(task.taskId);
    if (!plannedLink) continue;
    const key = `${plannedLink.record.taskId}:${plannedLink.attempt}`;
    seen.add(key);
    const isLatestAttempt = plannedLink.attempt === latestAttemptNumber(plannedLink.record);
    if (!isLatestAttempt) continue;
    if (completionOwnerForPlannedWorker(plannedLink.record, task, input.butlerData) !== input.consumer) continue;

    if (plannedLink.record.status === "PLANNED_RUNNING") {
      if (task.notifiedAt) continue;
      if (!claimPlannedReview({
        butlerData: input.butlerData,
        owner: input.consumer,
        plannedTaskId: plannedLink.record.taskId,
        workerTaskId: task.taskId,
        attempt: plannedLink.attempt,
        allowOwnerCorrection: true,
      })) continue;
      plannedStore.writeAttemptResult(
        plannedLink.record.taskId,
        plannedLink.attempt,
        task.observedResult ?? task.result ?? "",
      );
      const safety = workSafetyForTask(task);
      const status = task.status === "FAILED" || !safety.completion_claim_allowed ? "WORKER_FAILED" : "WORKER_DONE";
      plannedStore.transition(plannedLink.record.taskId, status);
      taskStore.markResultNotified(task.taskId);
      promotions.push({
        plannedTaskId: plannedLink.record.taskId,
        workerTaskId: task.taskId,
        attempt: plannedLink.attempt,
        reviewEventId: plannedReviewEventId(plannedLink.record.taskId, task.taskId, plannedLink.attempt),
        originSessionId: originSessionIdForPlannedWorker(plannedLink.record, task, input.butlerData),
        status,
      });
      continue;
    }

    const status = plannedPromotionStatus(plannedLink.record.status);
    if (status) {
      if (task.notifiedAt) continue;
      if (!claimPlannedReview({
        butlerData: input.butlerData,
        owner: input.consumer,
        plannedTaskId: plannedLink.record.taskId,
        workerTaskId: task.taskId,
        attempt: plannedLink.attempt,
        allowOwnerCorrection: true,
      })) continue;
      taskStore.markResultNotified(task.taskId);
      promotions.push({
        plannedTaskId: plannedLink.record.taskId,
        workerTaskId: task.taskId,
        attempt: plannedLink.attempt,
        reviewEventId: plannedReviewEventId(plannedLink.record.taskId, task.taskId, plannedLink.attempt),
        originSessionId: originSessionIdForPlannedWorker(plannedLink.record, task, input.butlerData),
        status,
      });
    }
  }

  for (const summary of plannedStore.summaries(25)) {
    const status = plannedPromotionStatus(summary.status);
    if (!status) continue;
    const record = plannedStore.read(summary.task_id);
    const latestAttempt = record?.attempts.at(-1);
    const attemptNumber = Number(latestAttempt);
    const workerTaskId = record && latestAttempt
      ? readWorkerTaskId(record.taskDir, latestAttempt)
      : "";
    if (!record || !latestAttempt || !workerTaskId || !Number.isFinite(attemptNumber)) continue;
    const key = `${record.taskId}:${attemptNumber}`;
    if (seen.has(key)) continue;
    const task = taskStore.read(workerTaskId);
    if (task?.notifiedAt) continue;
    if (completionOwnerForPlannedWorker(record, task, input.butlerData) !== input.consumer) continue;
    if (!claimPlannedReview({
      butlerData: input.butlerData,
      owner: input.consumer,
      plannedTaskId: record.taskId,
      workerTaskId,
      attempt: attemptNumber,
      allowOwnerCorrection: true,
    })) continue;
    if (task) taskStore.markResultNotified(task.taskId);
    promotions.push({
      plannedTaskId: record.taskId,
      workerTaskId,
      attempt: attemptNumber,
      reviewEventId: plannedReviewEventId(record.taskId, workerTaskId, attemptNumber),
      originSessionId: originSessionIdForPlannedWorker(record, task, input.butlerData),
      status,
    });
  }

  return promotions;
}

function enqueueOwnedNotifications(input: {
  butlerData: string;
  consumer: CompletionConsumer;
}): number {
  const taskStore = new TaskStore(input.butlerData);
  const plannedStore = new PlannedTaskStore(input.butlerData);
  const queue = new TaskNotificationQueue(input.butlerData);
  let enqueued = 0;

  for (const task of taskStore.plannedReportReadyTasks()) {
    if (completionOwnerForTask(task, input.butlerData) !== input.consumer) continue;
    const notificationId = queue.plannedReportNotificationId(task.taskId);
    const existing = queue.read(notificationId);
    const recoverDeliveredAppReport = (
      input.consumer === "app" &&
      existing?.status === "delivered" &&
      !existing.originSessionId
    );
    if (existing?.status === "delivered" && !recoverDeliveredAppReport) {
      markPlannedReportDelivered(input.butlerData, task.taskId);
      continue;
    }
    if (task.notifiedAt && !recoverDeliveredAppReport) continue;
    if (!existing || recoverDeliveredAppReport) enqueued += 1;
    queue.enqueuePlannedReport(task);
  }

  for (const task of taskStore.reportableTasks()) {
    if (task.notifiedAt) continue;
    if (plannedStore.findByWorkerTaskId(task.taskId)) continue;
    if (completionOwnerForTask(task, input.butlerData) !== input.consumer) continue;
    const notificationId = queue.taskNotificationId(task.taskId);
    const existing = queue.read(notificationId);
    if (existing?.status === "delivered") continue;
    if (!existing) enqueued += 1;
    queue.enqueueTaskResult(task);
  }

  return enqueued;
}

function completionOwnerForTask(
  task: TaskRecord | null,
  butlerData: string,
): CompletionConsumer {
  return completionOwnerForOrigin(originForTask(task, butlerData));
}

function completionOwnerForPlannedWorker(
  planned: PlannedTaskRecord,
  workerTask: TaskRecord | null,
  butlerData: string,
): CompletionConsumer {
  const plannedTaskOrigin = new TaskStore(butlerData).read(planned.taskId)?.origin;
  if (plannedTaskOrigin) return completionOwnerForOrigin(plannedTaskOrigin);
  if (planned.plan.origin_session_id) return completionOwnerForSessionId(planned.plan.origin_session_id);
  return completionOwnerForTask(workerTask, butlerData);
}

function originSessionIdForPlannedWorker(
  planned: PlannedTaskRecord,
  workerTask: TaskRecord | null,
  butlerData: string,
): string | undefined {
  const plannedTaskOrigin = new TaskStore(butlerData).read(planned.taskId)?.origin;
  return plannedTaskOrigin?.origin_session_id ||
    planned.plan.origin_session_id ||
    workerTask?.origin?.origin_session_id ||
    undefined;
}

function originForTask(task: TaskRecord | null, butlerData: string): TaskOriginContext | null {
  if (task?.origin) return task.origin;
  const workerTaskId = latestPlannedWorkerTaskId(task);
  if (workerTaskId) {
    const workerOrigin = new TaskStore(butlerData).read(workerTaskId)?.origin;
    if (workerOrigin) return workerOrigin;
  }
  if (!task?.taskId) return null;
  const link = new WorkOrchestrationStore(butlerData).findByWorkerTaskId(task.taskId);
  if (!link) return null;
  const originSessionId = link.record.origin_session_id?.trim();
  if (!originSessionId) return null;
  return buildTaskOriginContext({
    sessionId: originSessionId,
    taskSummary: link.stream.objective || link.record.goal || task.request || "Work orchestration stream",
    project: task.project ?? null,
    topicSummary: `Work orchestration stream ${link.stream.id}`,
    createdAt: link.record.created_at,
  });
}

function latestPlannedWorkerTaskId(task: TaskRecord | null): string {
  const latestAttempt = task?.planned?.attempts.at(-1);
  if (!task?.planned || !latestAttempt) return "";
  return readWorkerTaskId(task.planned.taskDir, latestAttempt);
}

function readWorkerTaskId(taskDir: string, attempt: string): string {
  try {
    return readFileSync(join(taskDir, "attempts", attempt, "worker-task-id"), "utf8").trim();
  } catch {
    return "";
  }
}

function plannedPromotionStatus(status: PlannedTaskStatus): PlannedWorkerPromotion["status"] | null {
  if (status === "WORKER_DONE") return "WORKER_DONE";
  if (status === "WORKER_FAILED") return "WORKER_FAILED";
  return null;
}

function latestAttemptNumber(record: PlannedTaskRecord): number {
  const latestAttempt = Number(record.attempts.at(-1));
  return Number.isFinite(latestAttempt) ? latestAttempt : 0;
}

function plannedReviewEventId(plannedTaskId: string, workerTaskId: string, attempt: number): string {
  return `review-${plannedTaskId}-${workerTaskId}-attempt-${attempt}`
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function claimPlannedReview(input: {
  butlerData: string;
  owner: CompletionConsumer;
  plannedTaskId: string;
  workerTaskId: string;
  attempt: number;
  allowOwnerCorrection?: boolean;
}): boolean {
  const path = plannedReviewClaimPath(input.butlerData, input.plannedTaskId, input.attempt);
  const existing = readClaim(path);
  if (existing) {
    const sameAttempt = (
      existing.worker_task_id === input.workerTaskId &&
      existing.attempt === input.attempt
    );
    if (existing.owner === input.owner && sameAttempt) return true;
    if (!input.allowOwnerCorrection || !sameAttempt) return false;
  }
  mkdirSync(join(input.butlerData, "runtime", "completion-router", "planned-review-claims"), { recursive: true });
  const claim: CompletionClaim = {
    version: 1,
    kind: "planned-review",
    owner: input.owner,
    planned_task_id: input.plannedTaskId,
    worker_task_id: input.workerTaskId,
    attempt: input.attempt,
    claimed_at: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(claim, null, 2)}\n`, "utf8");
  return true;
}

function plannedReviewClaimPath(butlerData: string, plannedTaskId: string, attempt: number): string {
  return join(
    butlerData,
    "runtime",
    "completion-router",
    "planned-review-claims",
    `${plannedTaskId}-attempt-${attempt}.json`,
  );
}

function readClaim(path: string): CompletionClaim | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CompletionClaim;
    if (
      parsed?.version === 1 &&
      parsed.kind === "planned-review" &&
      (parsed.owner === "app" || parsed.owner === "native") &&
      typeof parsed.planned_task_id === "string" &&
      typeof parsed.worker_task_id === "string" &&
      typeof parsed.attempt === "number" &&
      Number.isFinite(parsed.attempt)
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function markPlannedReportDelivered(butlerData: string, taskId: string): void {
  const store = new PlannedTaskStore(butlerData);
  const record = store.read(taskId);
  if (
    record?.status === "PUBLIC_REPORT_READY" ||
    record?.status === "FAILED_PUBLIC_REPORT_READY"
  ) {
    store.transition(taskId, "REPORTED");
  }
}
