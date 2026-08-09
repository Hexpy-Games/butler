import type { ToolProgressSummary } from "../../tools/tool-support.ts";

export type WorkProgressTask = {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  taskOutcome: string;
  taskOrder: number;
  taskState: "planned" | "active" | "reviewing" | "completed" |
    "correction_required" | "stopped" | "blocked" | "skipped";
  workId: string;
  workTitle: string;
  workState: "planned" | "active" | "completed" | "cancelled";
};

export interface BtccTurnProgressObserver {
  stateChanged(update: {
    turnId: string;
    semanticState: string;
    turnRevision: number;
  }): void | Promise<void>;
  workProgressChanged?(update: {
    turnId: string;
    turnRevision: number;
    originTurnId?: string;
    sourceRevision?: number;
    programId: string;
    modelRef?: string;
    tasks: WorkProgressTask[];
  }): void | Promise<void>;
  phaseActivityChanged?(update: {
    turnId: string;
    semanticState: string;
    activityId: string;
    originTurnId?: string;
    sourceRevision?: number;
    displayStage?: "conception" | "planning" | "execution" | "review" |
      "validation" | "reporting";
    title: string;
    summary: string;
    rationale?: string;
    nextStep?: string;
    modelRef?: string;
  }): void | Promise<void>;
  operationChanged?(update: {
    turnId: string;
    semanticState: string;
    activityId: string;
    requestId: string;
    publicTitle: string;
    capabilityRef: string;
    status: "started" | "completed" | "failed" | "cancelled";
    inputLabel?: ToolProgressSummary["inputLabel"];
    detailRows?: ToolProgressSummary["detailRows"];
    resultRef?: { id: string; sha256: string };
    byteLength?: number;
  }): void | Promise<void>;
  modelRoundWaitingChanged?(update: {
    turnId: string;
    requestId: string;
    status: "started" | "completed" | "failed" | "cancelled";
    modelRef?: string;
  }): void | Promise<void>;
  operationalNoticeChanged?(update: {
    turnId: string;
    semanticState: string;
    status: "recovering" | "interrupted" | "cleared";
    code?: string;
    activationKind?: "automatic_storage_recovery" |
      "automatic_provider_recovery" | "cancelled";
    attempt?: number;
    maxAttempts?: number;
  }): void | Promise<void>;
  runtimeFaulted?(update: {
    turnId: string;
    sessionId: string;
    faultId: string;
    kind: "provider_transport_exhausted";
    retryable: true;
    publicSummary: string;
    operatorSummary: string;
    safeErrorCode: string;
    createdAt: string;
  }): void | Promise<void>;
}
