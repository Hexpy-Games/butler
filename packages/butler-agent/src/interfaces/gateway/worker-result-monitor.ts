import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import type { DeliveryResult, OutboundAction } from "../../test-support/harness/contracts.ts";
import {
  completionConsumerForTransport,
  completionOwnerForSessionId,
  claimCompletionPromotions,
  enqueueCompletionNotifications,
  type PlannedWorkerPromotion,
} from "../../agent/work/completion-router.ts";
import {
  TaskNotificationQueue,
  taskNotificationToOutboundAction,
  type TaskNotification,
} from "../../agent/work/task-notifications.ts";
import { PlannedTaskStore } from "../../agent/work/planned-task.ts";
import { TaskStore, type TaskRecord } from "../../agent/work/task-store.ts";
import { DeliveryGuard } from "../transport/delivery-guard.ts";
import { createTelegramTransportAdapter } from "../transport/telegram/adapter.ts";
import type { SessionBindingStore } from "../../test-support/harness/session-store.ts";

export interface WorkerResultDeliveryTarget {
  transport: string;
  accountId: string;
  peerKind: OutboundAction["peer"]["kind"];
  peerId: string;
}

interface ResolvedWorkerDeliveryTarget extends WorkerResultDeliveryTarget {
  sessionId: string;
  threadId?: string;
}

export type WorkerResultRenderer = (input: {
  notification: TaskNotification;
  task: TaskRecord;
}) => Promise<string> | string;

export type WorkerResultMonitorAction = "full_scan" | "delivery_only" | "idle";

const DEFAULT_COMPLETION_RECOVERY_SWEEP_MS = 5 * 60_000;

export class WorkerResultMonitorGate {
  private revision: string | null = null;
  private lastFullScanAtMs: number | null = null;

  constructor(
    private readonly recoverySweepMs = DEFAULT_COMPLETION_RECOVERY_SWEEP_MS,
  ) {}

  nextAction(input: {
    revision: string;
    pendingCount: number;
    nowMs: number;
  }): WorkerResultMonitorAction {
    const recoveryDue = this.lastFullScanAtMs !== null &&
      input.nowMs - this.lastFullScanAtMs >= this.recoverySweepMs;
    if (this.revision === null || input.revision !== this.revision || recoveryDue) {
      return "full_scan";
    }
    return input.pendingCount > 0 ? "delivery_only" : "idle";
  }

  recordFullScan(input: { revision: string; nowMs: number }): void {
    this.revision = input.revision;
    this.lastFullScanAtMs = input.nowMs;
  }
}

export function completionMonitorRevision(butlerData: string): string {
  const taskStore = new TaskStore(butlerData);
  return taskStore.taskIds()
    .sort((a, b) => a.localeCompare(b))
    .map((taskId) => {
      try {
        return `${taskId}:${readFileSync(join(taskStore.taskDir(taskId), "status"), "utf8").trim()}`;
      } catch {
        return `${taskId}:missing`;
      }
    })
    .join("\n");
}

async function withTimeout<T>(input: {
  promise: Promise<T> | T;
  ms: number;
  label: string;
}): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      Promise.resolve(input.promise),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${input.label} timed out after ${input.ms}ms`)), input.ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function pollWorkerResultsOnce(input: {
  butlerHome: string;
  butlerData: string;
  sessionId: string;
  chatId?: string;
  deliveryTarget?: WorkerResultDeliveryTarget;
  sendTelegram?: (input: {
    chatId: string;
    text: string;
    threadId?: string;
  }) => Promise<DeliveryResult>;
  deliverAction?: (
    sessionId: string,
    action: OutboundAction,
    metadata: Record<string, unknown>,
  ) => Promise<DeliveryResult>;
  sessionStore?: SessionBindingStore;
  renderNotificationText?: WorkerResultRenderer;
  handlePlannedTaskReadyForReview?: (promotion: PlannedWorkerPromotion) => Promise<void> | void;
  plannedReviewCallbackTimeoutMs?: number;
  scanCompletions?: boolean;
}): Promise<number> {
  const chatId = input.chatId?.trim();
  const deliveryTarget = input.deliveryTarget ?? (chatId
    ? {
        transport: "telegram",
        accountId: "default",
        peerKind: "group" as const,
        peerId: chatId,
      }
    : null);
  if (!deliveryTarget) return 0;

  const consumer = completionConsumerForTransport(deliveryTarget.transport);
  if (input.scanCompletions !== false) {
    const promotions = claimCompletionPromotions({
      butlerData: input.butlerData,
      consumer,
    });
    for (const promotion of promotions) {
      if (!input.handlePlannedTaskReadyForReview) continue;
      await withTimeout({
        promise: input.handlePlannedTaskReadyForReview(promotion),
        ms: input.plannedReviewCallbackTimeoutMs ?? 180_000,
        label: "planned review callback",
      });
    }
    enqueueCompletionNotifications({
      butlerData: input.butlerData,
      consumer,
    });
  }
  const taskStore = new TaskStore(input.butlerData);
  const queue = new TaskNotificationQueue(input.butlerData);
  const guard = input.deliverAction
    ? null
    : new DeliveryGuard({
        adapters: [
          createTelegramTransportAdapter({
            butlerHome: input.butlerHome,
            sendTelegram: input.sendTelegram,
          }),
        ],
      });

  let delivered = 0;
  for (const notification of queue.pending()) {
    if (completionOwnerForSessionId(notification.originSessionId) !== consumer) continue;
    const task = taskStore.read(notification.taskId);
    if (!task) {
      queue.markFailed(notification.notificationId, "task not found");
      continue;
    }
    let notificationText = notification.text;
    const isPlannedReport = notification.notificationId.startsWith("planned-report-");
    if (input.renderNotificationText && !isPlannedReport) {
      try {
        const rendered = await input.renderNotificationText({ notification, task });
        if (rendered.trim()) notificationText = rendered.trim();
      } catch (error) {
        queue.markFailed(notification.notificationId, error instanceof Error ? error.message : String(error));
        continue;
      }
    }
    const target = resolveWorkerDeliveryTarget({
      sessionId: input.sessionId,
      notification,
      fallback: deliveryTarget,
      sessionStore: input.sessionStore,
    });
    const action = taskNotificationToOutboundAction({
      notification: {
        ...notification,
        text: notificationText,
      },
      transport: target.transport,
      accountId: target.accountId,
      peerKind: target.peerKind,
      peerId: target.peerId,
      threadId: target.threadId,
    });
    const metadata = {
      source: "gateway/worker-result-monitor.ts",
      type: "worker-result",
      taskId: notification.taskId,
      status: notification.taskStatus,
      notificationId: notification.notificationId,
    };

    const result = input.deliverAction
      ? await input.deliverAction(target.sessionId, action, metadata)
      : await guard!.deliver(target.sessionId, action, metadata);
    if (result.ok) {
      queue.markDelivered(notification.notificationId);
      taskStore.markResultNotified(notification.taskId);
      if (isPlannedReport) {
        markPlannedReportDelivered(input.butlerData, notification.taskId);
      }
      delivered += 1;
    } else {
      queue.markFailed(notification.notificationId, result.error || "delivery failed");
    }
  }

  return delivered;
}

function resolveWorkerDeliveryTarget(input: {
  sessionId: string;
  notification: TaskNotification;
  fallback: WorkerResultDeliveryTarget;
  sessionStore?: SessionBindingStore;
}): ResolvedWorkerDeliveryTarget {
  const originSessionId = input.notification.originSessionId?.trim();
  if (originSessionId && input.sessionStore) {
    const binding = input.sessionStore.getBySessionId(originSessionId);
    const transportBinding = binding?.transportBindings.find((item) =>
      item.transport === input.fallback.transport,
    );
    if (transportBinding) {
      return {
        sessionId: originSessionId,
        transport: transportBinding.transport,
        accountId: transportBinding.accountId,
        peerKind: transportBinding.threadId
          ? "thread"
          : transportBinding.transport === "app"
            ? "dm"
            : input.fallback.peerKind,
        peerId: transportBinding.peerId,
        threadId: transportBinding.threadId,
      };
    }
  }
  return {
    sessionId: originSessionId || input.sessionId,
    ...input.fallback,
  };
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

export async function runWorkerResultMonitor(input: {
  butlerHome: string;
  butlerData: string;
  sessionId: string;
  chatId?: string;
  deliveryTarget?: WorkerResultDeliveryTarget;
  pollMs?: number;
  shouldStop: () => boolean;
  sendTelegram?: (input: {
    chatId: string;
    text: string;
    threadId?: string;
  }) => Promise<DeliveryResult>;
  deliverAction?: (
    sessionId: string,
    action: OutboundAction,
    metadata: Record<string, unknown>,
  ) => Promise<DeliveryResult>;
  sessionStore?: SessionBindingStore;
  renderNotificationText?: WorkerResultRenderer;
  handlePlannedTaskReadyForReview?: (promotion: PlannedWorkerPromotion) => Promise<void> | void;
  plannedReviewCallbackTimeoutMs?: number;
  log?: (line: string) => void;
  recoverySweepMs?: number;
}): Promise<void> {
  mkdirSync(join(input.butlerData, "tasks"), { recursive: true });
  const pollMs = input.pollMs ?? 5_000;
  const gate = new WorkerResultMonitorGate(input.recoverySweepMs);
  while (!input.shouldStop()) {
    try {
      const nowMs = Date.now();
      const action = gate.nextAction({
        revision: completionMonitorRevision(input.butlerData),
        pendingCount: new TaskNotificationQueue(input.butlerData).pending().length,
        nowMs,
      });
      if (action !== "idle") {
        const delivered = await pollWorkerResultsOnce({
          ...input,
          scanCompletions: action === "full_scan",
        });
        if (action === "full_scan") {
          gate.recordFullScan({
            revision: completionMonitorRevision(input.butlerData),
            nowMs,
          });
        }
        if (delivered > 0) {
          input.log?.(`worker result monitor delivered ${delivered} result(s)`);
        }
      }
    } catch (error) {
      input.log?.(`worker result monitor error: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
