import { TaskStore } from "../../../../agent/work/task-store.ts";
import {
  workStreamTerminal,
  WorkStreamStore,
} from "../../../../agent/work/work-stream.ts";
import { PlannedTaskStore } from "../../../../agent/work/planned-task.ts";
import { WorkOrchestrationStore } from "../../../../agent/work/work-orchestration.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import { shouldKeepInactiveLinkedReportingWorker } from "./worker-activity-projection.ts";
import {
  appWorkStreamVisibleInActiveProjection,
  isActiveWorkerActivity,
  orderWorkerActivities,
  relabelWorkerActivities,
  synthesizeOrchestrationParentActivities,
  workerActivityFromTaskSummary,
} from "./worker-activity-read-model.ts";
import { sessionHintForRow } from "../sessions/session-read-model.ts";
import type { SessionView, WorkerActivityListView, WorkerActivitySummary } from "../../interface/protocol/app-protocol.ts";

export class AppWorkerActivityStore {
  constructor(
    private readonly butlerData: string,
    private readonly chatIdForRuntimeSession: (
      runtimeSessionId: string,
    ) => string | null,
  ) {}

  listWorkerActivity(
    options: { sessionId?: string; includeHistory?: boolean } = {},
  ): WorkerActivityListView {
    const linkedWorkerTaskIds = options.sessionId
      ? this.linkedWorkerTaskIdsForSession(options.sessionId)
      : new Set<string>();
    const plannedStore = new PlannedTaskStore(this.butlerData);
    const orchestrationStore = new WorkOrchestrationStore(this.butlerData);
    const keepInactiveLinkedReportingWorker = (
      worker: WorkerActivitySummary,
    ): boolean => {
      return shouldKeepInactiveLinkedReportingWorker({
        worker,
        sessionId: options.sessionId,
        linkedWorkerTaskIds,
        orchestration: worker.orchestration_id
          ? orchestrationStore.read(worker.orchestration_id)
          : null,
      });
    };
    const rawWorkers = new TaskStore(this.butlerData)
      .summaries(200)
      .map((task) => {
        const linkedToSession = linkedWorkerTaskIds.has(task.task_id);
        const linkedPlan =
          task.task_type === "planned"
            ? null
            : plannedStore.findByWorkerTaskId(task.task_id);
        const orchestrationId =
          task.task_type === "planned"
            ? task.task_id
            : linkedPlan?.record.taskId ??
              orchestrationStore.findByWorkerTaskId(task.task_id)?.record.id;
        const worker = workerActivityFromTaskSummary(task, orchestrationId);
        const appChatId = worker.session_id?.startsWith("butler/app-")
          ? this.chatIdForRuntimeSession(worker.session_id)
          : null;
        if (appChatId) return { ...worker, session_id: appChatId };
        if (linkedToSession && options.sessionId && !worker.session_id) {
          return { ...worker, session_id: options.sessionId };
        }
        return worker;
      })
      .filter((worker) =>
        options.includeHistory ||
        isActiveWorkerActivity(worker) ||
        keepInactiveLinkedReportingWorker(worker),
      )
      .filter(
        (worker) =>
          !options.sessionId ||
          worker.session_id === options.sessionId ||
          (worker.task_id && linkedWorkerTaskIds.has(worker.task_id)),
      );
    const projectedWorkers = relabelWorkerActivities(
      orderWorkerActivities(
        synthesizeOrchestrationParentActivities({
          workers: rawWorkers,
          orchestrationStore,
          sessionId: options.sessionId,
          includeHistory: options.includeHistory ?? false,
        }),
      ),
    );
    const workers = options.includeHistory
      ? projectedWorkers
      : projectedWorkers.filter(
          (worker) =>
            isActiveWorkerActivity(worker) ||
            keepInactiveLinkedReportingWorker(worker),
        );
    return { workers };
  }

  getWorkerActivity(workerId: string): WorkerActivitySummary {
    const worker = this.listWorkerActivity({
      includeHistory: true,
    }).workers.find((item) => item.worker_id === workerId);
    if (!worker) {
      throw new AppStoreOperationError(
        404,
        "worker_not_found",
        "Worker activity not found.",
      );
    }
    return worker;
  }

  listActiveWorkStreams(
    sessionId: string,
    runtimeSessionId = sessionHintForRow(sessionId),
    currentTurnId?: string,
  ): SessionView["work_streams"] {
    const workStreamStore = new WorkStreamStore(this.butlerData);
    const seenWorkStreams = new Set<string>();
    return [
      ...workStreamStore.listActive({ sessionId, currentTurnId }),
      ...workStreamStore.listActive({
        sessionId: runtimeSessionId,
        currentTurnId,
      }),
    ]
      .map((stream) => workStreamStore.read(stream.id))
      .filter((stream): stream is NonNullable<typeof stream> => Boolean(stream))
      .filter((stream) =>
        appWorkStreamVisibleInActiveProjection(stream, currentTurnId),
      )
      .filter((stream) => {
        if (seenWorkStreams.has(stream.id)) return false;
        seenWorkStreams.add(stream.id);
        return true;
      })
      .slice(0, 10)
      .map((stream) => ({
        id: stream.id,
        title: stream.title,
        owner_session_id: stream.owner_session_id ?? undefined,
        project_id: stream.project_id ?? undefined,
        state: stream.state,
        current_phase: stream.current_phase ?? undefined,
        active_step_id: stream.active_step_id ?? undefined,
        todo_list_id: stream.todo_list_id ?? undefined,
        terminal: workStreamTerminal(stream.state),
        updated_at: stream.updated_at,
      }));
  }

  private linkedWorkerTaskIdsForSession(sessionId: string): Set<string> {
    const runtimeSessionId = sessionHintForRow(sessionId);
    const workStreamStore = new WorkStreamStore(this.butlerData);
    const orchestrationStore = new WorkOrchestrationStore(this.butlerData);
    const workerTaskIds = new Set<string>();
    const seen = new Set<string>();
    for (const stream of [
      ...workStreamStore.list({ sessionId, includeTerminal: true }),
      ...workStreamStore.list({
        sessionId: runtimeSessionId,
        includeTerminal: true,
      }),
    ]) {
      if (seen.has(stream.id)) continue;
      seen.add(stream.id);
      const record = workStreamStore.read(stream.id);
      for (const workerTaskId of record?.linked_worker_task_ids ?? []) {
        workerTaskIds.add(workerTaskId);
      }
      for (const orchestrationId of record?.linked_orchestration_ids ?? []) {
        const orchestration = orchestrationStore.read(orchestrationId);
        for (const orchestrationStream of orchestration?.streams ?? []) {
          if (orchestrationStream.worker_task_id) {
            workerTaskIds.add(orchestrationStream.worker_task_id);
          }
        }
      }
    }
    return workerTaskIds;
  }
}
