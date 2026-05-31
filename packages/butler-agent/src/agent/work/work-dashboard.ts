import { TaskNotificationQueue, type TaskNotification } from "./task-notifications.ts";
import { TaskStore, type TaskSummary } from "./task-store.ts";
import { readOperationalHealth } from "../../operations/health/operational-health.ts";
import type { WorkMode } from "./task-store.ts";

export type WorkControlAction = "view_result" | "resume" | "retry_delivery" | "cancel";

export interface WorkDashboardActionIntent {
  action: WorkControlAction;
  label: string;
  task_id?: string;
  notification_id?: string;
  enabled: boolean;
  reason?: string;
}

export interface WorkDashboardItem {
  label: string;
  status: string;
  task_type: "direct" | "planned";
  work_mode: WorkMode;
  safe_to_report: boolean;
  completion_claim_allowed: boolean;
  guard_reason: string | null;
  summary: string;
  next_step: string;
  raw_id?: string;
  actions: WorkDashboardActionIntent[];
}

export interface WorkDashboard {
  counts: {
    active: number;
    recoverable: number;
    failed: number;
    reportReady: number;
    pendingDelivery: number;
    failedDelivery: number;
  };
  active: WorkDashboardItem[];
  recoverable: WorkDashboardItem[];
  failed: WorkDashboardItem[];
  reportReady: WorkDashboardItem[];
  delivery: Array<{
    label: string;
    status: TaskNotification["status"];
    summary: string;
    raw_id?: string;
    actions: WorkDashboardActionIntent[];
  }>;
  debug: boolean;
}

export interface WorkControlResult {
  ok: boolean;
  action: WorkControlAction;
  message: string;
  intent?: WorkDashboardActionIntent;
  result?: string | null;
}

function safeLabel(index: number, prefix: string): string {
  return `${prefix} ${index + 1}`;
}

function itemActions(task: TaskSummary): WorkDashboardActionIntent[] {
  return [
    {
      action: "view_result",
      label: "View result",
      task_id: task.task_id,
      enabled: task.has_result || Boolean(task.observed_result_preview) || task.status === "FAILED",
      reason: task.has_result || task.observed_result_preview ? undefined : "No result evidence is available yet.",
    },
    {
      action: "resume",
      label: "Resume",
      task_id: task.task_id,
      enabled: task.can_resume,
      reason: task.can_resume ? undefined : "Only recoverable tasks can be resumed.",
    },
    {
      action: "cancel",
      label: "Cancel",
      task_id: task.task_id,
      enabled: task.status === "RUNNING",
      reason: task.status === "RUNNING" ? undefined : "Only running tasks can be cancelled.",
    },
  ];
}

function toDashboardItem(task: TaskSummary, index: number, debug: boolean): WorkDashboardItem {
  const status = task.planned_status ?? task.status;
  return {
    label: debug ? task.task_id : safeLabel(index, "Work"),
    status,
    task_type: task.task_type,
    work_mode: task.work_mode,
    safe_to_report: task.safe_to_report,
    completion_claim_allowed: task.completion_claim_allowed,
    guard_reason: task.guard_reason,
    summary: task.user_summary,
    next_step: task.next_step,
    raw_id: debug ? task.task_id : undefined,
    actions: itemActions(task).map((action) => debug ? action : {
      ...action,
      task_id: undefined,
    }),
  };
}

function deliveryActions(notification: TaskNotification, debug: boolean): WorkDashboardActionIntent[] {
  return [{
    action: "retry_delivery",
    label: "Retry delivery",
    task_id: debug ? notification.taskId : undefined,
    notification_id: debug ? notification.notificationId : undefined,
    enabled: notification.status === "failed",
    reason: notification.status === "failed" ? undefined : "Only failed deliveries need retry.",
  }];
}

export function createWorkDashboard(options: {
  butlerData: string;
  limit?: number;
  debug?: boolean;
}): WorkDashboard {
  const debug = Boolean(options.debug);
  const limit = Math.max(1, Math.min(25, Math.trunc(options.limit ?? 10)));
  const taskStore = new TaskStore(options.butlerData);
  const tasks = taskStore.summaries(25);
  const queue = new TaskNotificationQueue(options.butlerData);
  const delivery = queue.pending();
  const health = readOperationalHealth(options.butlerData);

  const activeTasks = tasks.filter((task) =>
    task.status === "RUNNING" ||
    task.planned_status === "PLANNED_RUNNING" ||
    task.planned_status === "REPAIRING" ||
    task.planned_status === "REVIEWING",
  );
  const recoverableTasks = tasks.filter((task) => task.can_resume);
  const failedTasks = tasks.filter((task) =>
    task.status === "FAILED" ||
    task.planned_status === "REVIEW_FAILED" ||
    task.planned_status === "REVIEW_INCONCLUSIVE",
  );
  const reportReadyTasks = tasks.filter((task) => task.public_report_ready);

  return {
    counts: {
      active: activeTasks.length || health.tasks.running,
      recoverable: recoverableTasks.length || health.tasks.recoverable,
      failed: failedTasks.length || health.tasks.failed,
      reportReady: reportReadyTasks.length,
      pendingDelivery: delivery.filter((item) => item.status === "pending").length,
      failedDelivery: delivery.filter((item) => item.status === "failed").length,
    },
    active: activeTasks.slice(0, limit).map((task, index) => toDashboardItem(task, index, debug)),
    recoverable: recoverableTasks.slice(0, limit).map((task, index) => toDashboardItem(task, index, debug)),
    failed: failedTasks.slice(0, limit).map((task, index) => toDashboardItem(task, index, debug)),
    reportReady: reportReadyTasks.slice(0, limit).map((task, index) => toDashboardItem(task, index, debug)),
    delivery: delivery.slice(0, limit).map((notification, index) => ({
      label: debug ? notification.notificationId : safeLabel(index, "Delivery"),
      status: notification.status,
      summary: notification.originSummary ?? notification.taskId,
      raw_id: debug ? notification.notificationId : undefined,
      actions: deliveryActions(notification, debug),
    })),
    debug,
  };
}

export function renderWorkDashboard(dashboard: WorkDashboard): string {
  const lines = [
    "## Work Dashboard",
    `active=${dashboard.counts.active} recoverable=${dashboard.counts.recoverable} failed=${dashboard.counts.failed} report_ready=${dashboard.counts.reportReady}`,
    `delivery_pending=${dashboard.counts.pendingDelivery} delivery_failed=${dashboard.counts.failedDelivery}`,
  ];
  const groups: Array<[string, WorkDashboardItem[]]> = [
    ["Active", dashboard.active],
    ["Recoverable", dashboard.recoverable],
    ["Failed", dashboard.failed],
    ["Report Ready", dashboard.reportReady],
  ];
  for (const [label, items] of groups) {
    if (items.length === 0) continue;
    lines.push("", `— ${label} —`);
    for (const item of items) {
      lines.push(`${item.label}: ${item.summary}`);
      if (dashboard.debug && item.raw_id) lines.push(`  id: ${item.raw_id}`);
      lines.push(`  mode: ${item.work_mode}`);
      if (item.guard_reason) lines.push(`  guard: ${item.guard_reason}`);
      lines.push(`  next: ${item.next_step}`);
    }
  }
  if (dashboard.delivery.length > 0) {
    lines.push("", "— Delivery —");
    for (const item of dashboard.delivery) {
      lines.push(`${item.label}: ${item.status} — ${item.summary}`);
      if (dashboard.debug && item.raw_id) lines.push(`  notification: ${item.raw_id}`);
    }
  }
  return lines.join("\n");
}

export function performWorkControl(input: {
  butlerData: string;
  action: WorkControlAction;
  taskId?: string;
  notificationId?: string;
}): WorkControlResult {
  const taskStore = new TaskStore(input.butlerData);
  const queue = new TaskNotificationQueue(input.butlerData);

  if (input.action === "retry_delivery") {
    const notificationId = input.notificationId?.trim();
    if (!notificationId) {
      return { ok: false, action: input.action, message: "retry_delivery requires notification_id" };
    }
    const notification = queue.read(notificationId);
    if (!notification) {
      return { ok: false, action: input.action, message: `delivery notification not found: ${notificationId}` };
    }
    if (notification.status !== "failed") {
      return { ok: false, action: input.action, message: `delivery is ${notification.status}; only failed delivery can be retried` };
    }
    queue.upsert({
      ...notification,
      status: "pending",
      lastError: undefined,
      deliveredAt: undefined,
    });
    return {
      ok: true,
      action: input.action,
      message: "delivery retry queued",
      intent: {
        action: "retry_delivery",
        label: "Retry delivery",
        task_id: notification.taskId,
        notification_id: notification.notificationId,
        enabled: true,
      },
    };
  }

  const taskId = input.taskId?.trim();
  if (!taskId) return { ok: false, action: input.action, message: `${input.action} requires task_id` };
  const task = taskStore.read(taskId);
  if (!task) return { ok: false, action: input.action, message: `task not found: ${taskId}` };

  if (input.action === "view_result") {
    if (!task.observedResult && !task.result && task.status !== "FAILED") {
      return { ok: false, action: input.action, message: "task has no result evidence yet" };
    }
    return {
      ok: true,
      action: input.action,
      message: "task result loaded",
      result: task.observedResult ?? task.result,
      intent: {
        action: "view_result",
        label: "View result",
        task_id: taskId,
        enabled: true,
      },
    };
  }

  if (input.action === "resume") {
    if (task.status !== "RECOVERABLE") {
      return { ok: false, action: input.action, message: `task is ${task.status}; only RECOVERABLE tasks can be resumed` };
    }
    return {
      ok: true,
      action: input.action,
      message: "resume intent validated",
      intent: {
        action: "resume",
        label: "Resume",
        task_id: taskId,
        enabled: true,
      },
    };
  }

  if (input.action === "cancel") {
    if (task.status !== "RUNNING") {
      return { ok: false, action: input.action, message: `task is ${task.status}; only RUNNING tasks can be cancelled` };
    }
    return {
      ok: true,
      action: input.action,
      message: "cancel intent validated",
      intent: {
        action: "cancel",
        label: "Cancel",
        task_id: taskId,
        enabled: true,
      },
    };
  }

  return { ok: false, action: input.action, message: `unsupported action: ${input.action}` };
}
