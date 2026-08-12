import type {
  AutomationDetailView,
  AutomationListView,
  AutomationMutationResult,
  AutomationRunListView,
  AutomationRunResult,
  AutomationRunSummary,
  AutomationTargetSummary,
  CreateAutomationRequest,
  UpdateAutomationRequest,
  WorkerActivityControlRequest,
  WorkerActivityControlResult,
  WorkerActivityListView,
  WorkerActivitySummary,
} from "../../interface/protocol/app-protocol.ts";
import type {
  AppMessageResponder,
  SendMessageOptions,
} from "../../domain/sessions/message-responder-contract.ts";
import type { AppStoreKernel } from "../kernel/app-store-kernel.ts";

export interface AppStoreAutomationWorkerApi {
  listAutomations(options?: { targetSessionId?: string }): AutomationListView;
  getAutomation(automationId: string): AutomationDetailView;
  createAutomation(input: CreateAutomationRequest): AutomationMutationResult;
  updateAutomation(
    automationId: string,
    input: UpdateAutomationRequest,
  ): AutomationMutationResult;
  deleteAutomation(automationId: string): AutomationMutationResult;
  pauseAutomation(automationId: string): AutomationMutationResult;
  resumeAutomation(automationId: string): AutomationMutationResult;
  runAutomationNow(
    automationId: string,
    responder?: AppMessageResponder,
    options?: SendMessageOptions,
    trigger?: "run_now" | "scheduled",
  ): Promise<AutomationRunResult>;
  dispatchDueAutomations(
    responder?: AppMessageResponder,
    options?: SendMessageOptions,
    now?: Date,
  ): Promise<{ runs: AutomationRunSummary[] }>;
  listAutomationRuns(automationId: string): AutomationRunListView;
  listAutomationTargets(sessionId: string): AutomationTargetSummary[];
  listWorkerActivity(options?: {
    sessionId?: string;
    includeHistory?: boolean;
    limit?: number;
    offset?: number;
    cursor?: string;
  }): WorkerActivityListView;
  getWorkerActivity(workerId: string): WorkerActivitySummary;
  controlWorkerActivity(
    workerId: string,
    input: WorkerActivityControlRequest,
  ): WorkerActivityControlResult;
}

export function createAutomationWorkerStoreApi(
  kernel: AppStoreKernel,
): AppStoreAutomationWorkerApi {
  return {
    listAutomations(options = {}) {
      return kernel.automationStore.list(options);
    },
    getAutomation(automationId) {
      return kernel.automationStore.get(automationId);
    },
    createAutomation(input) {
      return kernel.automationStore.create(input);
    },
    updateAutomation(automationId, input) {
      return kernel.automationStore.update(automationId, input);
    },
    deleteAutomation(automationId) {
      return kernel.automationStore.delete(automationId);
    },
    pauseAutomation(automationId) {
      return kernel.automationStore.update(automationId, { state: "paused" });
    },
    resumeAutomation(automationId) {
      return kernel.automationStore.update(automationId, { state: "enabled" });
    },
    async runAutomationNow(
      automationId,
      responder,
      options = {},
      trigger = "run_now",
    ) {
      return await kernel.automationStore.runNow(
        automationId,
        responder,
        options,
        trigger,
      );
    },
    async dispatchDueAutomations(responder, options = {}, now = new Date()) {
      return await kernel.automationStore.dispatchDue(responder, options, now);
    },
    listAutomationRuns(automationId) {
      return kernel.automationStore.listRuns(automationId);
    },
    listAutomationTargets(sessionId) {
      return kernel.automationStore.listTargets(sessionId);
    },
    listWorkerActivity(options = {}) {
      return kernel.workers.listWorkerActivity(options);
    },
    getWorkerActivity(workerId) {
      return kernel.workers.getWorkerActivity(workerId);
    },
    controlWorkerActivity(workerId, input) {
      return kernel.workerControls.controlWorkerActivity(workerId, input);
    },
  };
}
