import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskStore } from "../../../../agent/work/task-store.ts";
import {
  PlannedTaskStore,
  type PlannedTaskRecord,
} from "../../../../agent/work/planned-task.ts";
import {
  WorkOrchestrationStore,
  type WorkOrchestrationRecord,
} from "../../../../agent/work/work-orchestration.ts";
import { WorkStreamStore } from "../../../../agent/work/work-stream.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import { requestBackgroundCommandCancellation } from "../../../../runtime/command/background-command-registry.ts";
import {
  workerTaskIdsForPlannedTask,
  writeWorkerActivityProjection,
} from "./worker-task-files.ts";
import type {
  MessageRecord,
  WorkerActivityControlRequest,
  WorkerActivityControlResult,
  WorkerActivitySummary,
} from "../../interface/protocol/app-protocol.ts";

export class AppWorkerControlStore {
  constructor(
    private readonly butlerData: string,
    private readonly getWorkerActivity: (
      workerId: string,
    ) => WorkerActivitySummary,
    private readonly insertMessage: (
      sessionId: string,
      role: MessageRecord["role"],
      text: string,
      status: MessageRecord["status"],
    ) => MessageRecord,
    private readonly appendEvent: (
      type: string,
      payload: Record<string, unknown>,
    ) => void,
  ) {}

  controlWorkerActivity(
    workerId: string,
    input: WorkerActivityControlRequest,
  ): WorkerActivityControlResult {
    const worker = this.getWorkerActivity(workerId);
    if (!worker.supported_controls.includes(input.action)) {
      throw new AppStoreOperationError(
        409,
        "worker_control_unsupported",
        "Worker control is not supported.",
      );
    }
    if (input.action === "cancel") return this.cancelWorkerActivity(worker);
    const noticeText = `Worker ${worker.worker_display_name} received ${input.action}. What should Butler do next?`;
    const notice = this.insertMessage(
      worker.session_id ?? "general",
      "system_event",
      noticeText,
      "delivered",
    );
    this.appendEvent("main_session_worker_control_notice", {
      worker_id: worker.worker_id,
      action: input.action,
      message_id: notice.id,
    });
    return { worker, notice };
  }

  private cancelWorkerActivity(
    worker: WorkerActivitySummary,
  ): WorkerActivityControlResult {
    const taskId = worker.task_id;
    if (!taskId) {
      throw new AppStoreOperationError(
        409,
        "worker_control_unsupported",
        "Worker has no cancellable task.",
      );
    }
    const taskStore = new TaskStore(this.butlerData);
    const plannedStore = new PlannedTaskStore(this.butlerData);
    const workStreamStore = new WorkStreamStore(this.butlerData);
    const orchestrationStore = new WorkOrchestrationStore(this.butlerData);
    const cancelledTaskIds = new Set<string>();
    const workerTaskIds = new Set<string>();
    const plannedTaskIds = new Set<string>();
    const orchestrationIds = new Set<string>();

    const cancelWorkerTaskId = (workerTaskId: string) => {
      workerTaskIds.add(workerTaskId);
      this.cancelDurableWorkerTask(taskStore, workerTaskId, cancelledTaskIds);
    };
    const collectPlannedWorkers = (planned: PlannedTaskRecord | null) => {
      if (!planned) return;
      plannedTaskIds.add(planned.taskId);
      for (const workerTaskId of workerTaskIdsForPlannedTask(planned)) {
        workerTaskIds.add(workerTaskId);
      }
    };
    const collectOrchestrationWorkers = (
      orchestration: WorkOrchestrationRecord | null,
    ) => {
      if (!orchestration) return;
      orchestrationIds.add(orchestration.id);
      for (const stream of orchestration.streams) {
        if (stream.worker_task_id) workerTaskIds.add(stream.worker_task_id);
      }
    };

    if (worker.activity_kind === "planned") {
      const planned = plannedStore.read(taskId);
      collectPlannedWorkers(planned);
      this.cancelPlannedTask(plannedStore, taskId);
      plannedTaskIds.add(taskId);
    } else {
      cancelWorkerTaskId(taskId);
      const linkedPlan = plannedStore.findByWorkerTaskId(taskId);
      if (linkedPlan) {
        collectPlannedWorkers(linkedPlan.record);
        this.cancelPlannedTask(plannedStore, linkedPlan.record.taskId);
      }
    }

    const linkedStreams = workStreamStore.linkedTo({
      plannedTaskIds: [...plannedTaskIds],
      workerTaskIds: [...workerTaskIds],
    });
    for (const stream of linkedStreams) {
      for (const linkedWorkerTaskId of stream.linked_worker_task_ids) {
        workerTaskIds.add(linkedWorkerTaskId);
      }
      for (const linkedPlannedTaskId of stream.linked_planned_task_ids) {
        plannedTaskIds.add(linkedPlannedTaskId);
        collectPlannedWorkers(plannedStore.read(linkedPlannedTaskId));
      }
      for (const linkedOrchestrationId of stream.linked_orchestration_ids) {
        collectOrchestrationWorkers(
          orchestrationStore.read(linkedOrchestrationId),
        );
      }
    }
    for (const linkedOrchestrationId of [...orchestrationIds]) {
      const orchestration = orchestrationStore.read(linkedOrchestrationId);
      collectOrchestrationWorkers(orchestration);
      if (orchestration) orchestrationStore.cancel(linkedOrchestrationId);
    }
    for (const linkedPlannedTaskId of [...plannedTaskIds]) {
      this.cancelPlannedTask(plannedStore, linkedPlannedTaskId);
    }
    for (const linkedWorkerTaskId of [...workerTaskIds]) {
      cancelWorkerTaskId(linkedWorkerTaskId);
    }
    workStreamStore.cancelLinked({
      workStreamIds: linkedStreams.map((stream) => stream.id),
      plannedTaskIds: [...plannedTaskIds],
      orchestrationIds: [...orchestrationIds],
      workerTaskIds: [...workerTaskIds],
      statusNote: "Cancelled by user request.",
    });

    const refreshed = this.getWorkerActivity(worker.worker_id);
    this.appendEvent("worker_activity_controlled", {
      worker_id: refreshed.worker_id,
      action: "cancel",
      phase: refreshed.phase,
      task_id: refreshed.task_id,
      orchestration_id: refreshed.orchestration_id,
    });
    return { worker: refreshed };
  }

  private cancelDurableWorkerTask(
    taskStore: TaskStore,
    taskId: string,
    cancelledTaskIds: Set<string>,
  ): void {
    if (cancelledTaskIds.has(taskId)) return;
    cancelledTaskIds.add(taskId);
    const task = taskStore.read(taskId);
    const taskDir = task?.taskDir ?? taskStore.taskDir(taskId);
    this.terminateWorkerExecution(taskId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status"), "KILLED\n", "utf8");
    writeWorkerActivityProjection(
      taskDir,
      "cancelled",
      "Cancelled: worker was stopped by user request.",
    );
  }

  private cancelPlannedTask(
    plannedStore: PlannedTaskStore,
    taskId: string,
  ): void {
    const planned = plannedStore.read(taskId);
    const taskDir = planned?.taskDir ?? plannedStore.taskDir(taskId);
    mkdirSync(taskDir, { recursive: true });
    writeWorkerActivityProjection(
      taskDir,
      "cancelled",
      "Cancelled: planned work was stopped by user request.",
    );
    if (
      !planned ||
      planned.status === "CANCELLED" ||
      planned.status === "REPORTED"
    ) {
      writeFileSync(join(taskDir, "status"), "CANCELLED\n", "utf8");
      return;
    }
    try {
      plannedStore.transition(taskId, "CANCELLED");
    } catch {
      writeFileSync(join(taskDir, "status"), "CANCELLED\n", "utf8");
    }
  }

  private terminateWorkerExecution(taskId: string): void {
    if (!requestBackgroundCommandCancellation({ butlerData: this.butlerData, id: taskId })) {
      this.appendEvent("worker_activity_cancel_no_process", {
        task_id: taskId,
      });
    }
  }
}
