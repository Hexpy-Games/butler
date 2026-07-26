import type {
  AppEventEnvelope,
  DeveloperLogListView,
  AppInfoView,
  SystemEventListView,
  UpdateApplyRequest,
  UpdateApplyResult,
  UpdateCheckRequest,
  UpdateStatusView,
  UsageMonitorView,
} from "../../interface/protocol/app-protocol.ts";
import type {
  AgentTurnEvent,
  RuntimeTurnEventInput,
} from "../../../../agent/events/turn-events.ts";
import type { AppStoreKernel } from "../kernel/app-store-kernel.ts";

export interface AppStoreRuntimeApi {
  close(): void;
  butlerDataRoot(): string;
  getUpdateStatus(): Promise<UpdateStatusView>;
  checkUpdates(request?: UpdateCheckRequest): Promise<UpdateStatusView>;
  applyUpdate(request: UpdateApplyRequest): Promise<UpdateApplyResult>;
  getAppInfo(): AppInfoView;
  listSystemEvents(options?: {
    limit?: number;
    offset?: number;
  }): SystemEventListView;
  listDeveloperLogs(options?: {
    limit?: number;
    offset?: number;
    sessionId?: string;
    turnId?: string;
    kind?: "model_turn" | "model_turn_error";
    query?: string;
  }): DeveloperLogListView;
  getUsageMonitor(options?: {
    sessionId?: string;
    sinceTs?: number | null;
  }): UsageMonitorView;
  syncAllAppTransportEvents(): number;
  latestEventCursor(): number;
  replayEvents(cursor?: number): AppEventEnvelope[];
  subscribeEvents(listener: (event: AppEventEnvelope) => void): () => void;
  appendSafeServerEvent(
    type: string,
    payload: Record<string, unknown>,
  ): AppEventEnvelope;
  appendTurnEvent(
    sessionId: string,
    turnId: string,
    input: RuntimeTurnEventInput,
  ): AgentTurnEvent;
}

export function createRuntimeStoreApi(
  kernel: AppStoreKernel,
): AppStoreRuntimeApi {
  return {
    close() {
      if (kernel.closed) return;
      try {
        kernel.transportProjectionOwner.close();
        kernel.db.query("PRAGMA wal_checkpoint(TRUNCATE)").all();
      } finally {
        kernel.sessionBindingStore.close();
        kernel.db.close();
        kernel.closed = true;
      }
    },
    butlerDataRoot() {
      return kernel.butlerData;
    },
    async getUpdateStatus() {
      return await kernel.runtimeInfo.getUpdateStatus();
    },
    async checkUpdates(request = {}) {
      return await kernel.runtimeInfo.checkUpdates(request);
    },
    async applyUpdate(request) {
      return await kernel.runtimeInfo.applyUpdate(request);
    },
    getAppInfo() {
      return kernel.runtimeInfo.getAppInfo();
    },
    listSystemEvents(options = {}) {
      return kernel.systemMonitor.listSystemEvents(options);
    },
    listDeveloperLogs(options = {}) {
      const result = kernel.developerLogs.list(options);
      return {
        developer_mode_enabled: true,
        entries: result.entries,
        pagination: {
          limit: result.limit,
          offset: result.offset,
          total: result.total,
          has_more: result.offset + result.entries.length < result.total,
        },
        generated_at: new Date().toISOString(),
        raw_text_included: true,
      };
    },
    getUsageMonitor(options = {}) {
      return kernel.systemMonitor.getUsageMonitor(options);
    },
    syncAllAppTransportEvents() {
      return kernel.transportProjection.syncAll();
    },
    latestEventCursor() {
      return kernel.events.latestCursor();
    },
    replayEvents(cursor = 0) {
      return kernel.events.replay(cursor);
    },
    subscribeEvents(listener) {
      return kernel.events.subscribe(listener);
    },
    appendSafeServerEvent(type, payload) {
      return kernel.appendEvent(type, payload);
    },
    appendTurnEvent(sessionId, turnId, input) {
      return kernel.turnProgress.appendTurnEvent(sessionId, turnId, input);
    },
  };
}
