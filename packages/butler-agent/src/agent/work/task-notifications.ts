import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { OutboundAction } from "../../test-support/harness/contracts.ts";
import { TaskStore, type TaskRecord } from "./task-store.ts";
import { resolveRuntimeMessageLanguage } from "../output/messages.ts";
import { buildTaskOriginContext, type TaskOriginContext } from "./task-origin.ts";
import { WorkOrchestrationStore } from "./work-orchestration.ts";

export type TaskNotificationStatus = "pending" | "delivered" | "failed";

export interface TaskNotification {
  notificationId: string;
  taskId: string;
  taskStatus: TaskRecord["status"];
  text: string;
  status: TaskNotificationStatus;
  createdAt: string;
  deliveredAt?: string;
  lastError?: string;
  originSummary?: string;
  originSessionId?: string;
  originEventId?: string;
}

function readJson(path: string): TaskNotification | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as TaskNotification : null;
  } catch {
    return null;
  }
}

function trimBlock(value: string | null | undefined, limit: number): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n...[truncated]` : trimmed;
}

function fallbackTaskReport(task: TaskRecord, language: "en" | "ko"): string {
  const result = trimBlock(task.observedResult, 2_800);
  if (language === "ko") {
    const title = task.status === "FAILED" ? "워커 작업이 실패했습니다." : "워커 작업이 완료되었습니다.";
    const parts = [
      title,
      "",
    ];
    if (task.origin?.task_summary) {
      parts.push(`- 원래 요청: ${task.origin.task_summary.slice(0, 240)}`);
    } else if (task.request) {
      parts.push(`- 요청: ${task.request.slice(0, 240)}`);
    }
    parts.push("", "## 결과", result || "결과 요약을 찾지 못했습니다. 저장된 작업 상태를 다시 확인한 뒤 이어서 보고하겠습니다.");
    return parts.join("\n");
  }

  const title = task.status === "FAILED" ? "Worker task failed." : "Worker task completed.";
  const parts = [
    title,
    "",
  ];
  if (task.origin?.task_summary) {
    parts.push(`- Original request: ${task.origin.task_summary.slice(0, 240)}`);
  } else if (task.request) {
    parts.push(`- Request: ${task.request.slice(0, 240)}`);
  }
  parts.push("", "## Result", result || "No result summary was available. Butler will re-check durable task state before reporting more.");
  return parts.join("\n");
}

function renderTaskResult(task: TaskRecord, butlerData: string): string {
  return fallbackTaskReport(task, resolveRuntimeMessageLanguage({ butlerData }));
}

function latestPlannedWorkerTaskId(task: TaskRecord): string {
  const latestAttempt = task.planned?.attempts.at(-1);
  if (!task.planned || !latestAttempt) return "";
  try {
    return readFileSync(join(task.planned.taskDir, "attempts", latestAttempt, "worker-task-id"), "utf8").trim();
  } catch {
    return "";
  }
}

function notificationOrigin(task: TaskRecord, butlerData: string): TaskOriginContext | null {
  if (task.origin) return task.origin;
  const workerTaskId = latestPlannedWorkerTaskId(task);
  if (workerTaskId) {
    const workerOrigin = new TaskStore(butlerData).read(workerTaskId)?.origin;
    if (workerOrigin) return workerOrigin;
  }
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

function shouldRecoverDeliveredPlannedReport(
  existing: TaskNotification | null,
  task: TaskRecord,
): boolean {
  if (!task.planned?.publicReport) return false;
  if (existing?.status !== "delivered" || existing.originSessionId) return false;
  return true;
}

export class TaskNotificationQueue {
  readonly queueDir: string;

  constructor(readonly butlerData: string) {
    this.queueDir = join(butlerData, "runtime", "task-notifications");
  }

  ensure(): void {
    mkdirSync(this.queueDir, { recursive: true });
  }

  path(notificationId: string): string {
    return join(this.queueDir, `${notificationId}.json`);
  }

  taskNotificationId(taskId: string): string {
    return `worker-result-${taskId}`;
  }

  plannedReportNotificationId(taskId: string): string {
    return `planned-report-${taskId}`;
  }

  read(notificationId: string): TaskNotification | null {
    return readJson(this.path(notificationId));
  }

  upsert(notification: TaskNotification): TaskNotification {
    this.ensure();
    writeFileSync(this.path(notification.notificationId), `${JSON.stringify(notification, null, 2)}\n`, "utf8");
    return notification;
  }

  enqueueTaskResult(task: TaskRecord): TaskNotification {
    const notificationId = this.taskNotificationId(task.taskId);
    const existing = this.read(notificationId);
    if (existing) return existing;
    const origin = notificationOrigin(task, this.butlerData);
    return this.upsert({
      notificationId,
      taskId: task.taskId,
      taskStatus: task.status,
      text: renderTaskResult(task, this.butlerData),
      status: "pending",
      createdAt: new Date().toISOString(),
      originSummary: origin?.task_summary ?? undefined,
      originSessionId: origin?.origin_session_id ?? undefined,
      originEventId: origin?.origin_inbound_event_id ?? undefined,
    });
  }

  enqueuePlannedReport(task: TaskRecord): TaskNotification | null {
    if (!task.planned?.publicReport) return null;
    const notificationId = this.plannedReportNotificationId(task.taskId);
    const existing = this.read(notificationId);
    const origin = notificationOrigin(task, this.butlerData);
    if (existing && !shouldRecoverDeliveredPlannedReport(existing, task)) return existing;
    return this.upsert({
      ...existing,
      notificationId,
      taskId: task.taskId,
      taskStatus: "REVIEWED",
      text: task.planned.publicReport,
      status: "pending",
      createdAt: new Date().toISOString(),
      originSummary: origin?.task_summary ?? undefined,
      originSessionId: origin?.origin_session_id ?? undefined,
      originEventId: origin?.origin_inbound_event_id ?? undefined,
      deliveredAt: undefined,
      lastError: undefined,
    });
  }

  pending(): TaskNotification[] {
    if (!existsSync(this.queueDir)) return [];
    return readdirSync(this.queueDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => readJson(join(this.queueDir, entry)))
      .filter((notification): notification is TaskNotification =>
        Boolean(notification && notification.status !== "delivered"),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  markDelivered(notificationId: string, at = new Date()): void {
    const notification = this.read(notificationId);
    if (!notification) return;
    this.upsert({
      ...notification,
      status: "delivered",
      deliveredAt: at.toISOString(),
      lastError: undefined,
    });
  }

  markFailed(notificationId: string, error: string): void {
    const notification = this.read(notificationId);
    if (!notification) return;
    this.upsert({
      ...notification,
      status: "failed",
      lastError: error,
    });
  }
}

export function taskNotificationToOutboundAction(input: {
  notification: TaskNotification;
  transport: string;
  accountId: string;
  peerKind: OutboundAction["peer"]["kind"];
  peerId: string;
  threadId?: string;
}): OutboundAction {
  return {
    actionId: `task-notification:${input.notification.notificationId}`,
    transport: input.transport,
    accountId: input.accountId,
    peer: {
      kind: input.peerKind,
      id: input.peerId,
      threadId: input.threadId,
    },
    message: {
      text: input.notification.text,
    },
    metadata: {
      kind: "worker_result",
      source: "tasks/task-notifications.ts",
      type: "worker-result",
      taskId: input.notification.taskId,
      status: input.notification.taskStatus,
      notificationId: input.notification.notificationId,
      originSummary: input.notification.originSummary,
      originSessionId: input.notification.originSessionId,
      originEventId: input.notification.originEventId,
    },
  };
}
