import { createCreateWorkOrchestrationToolHandler } from "./create_work_orchestration/executor.ts";
import { createRunReadyWorkStreamsToolHandler } from "./run_ready_work_streams/executor.ts";
import { createSyncWorkOrchestrationToolHandler } from "./sync_work_orchestration/executor.ts";
import { createWriteWorkOrchestrationReportToolHandler } from "./write_work_orchestration_report/executor.ts";

export function createOrchestrationToolHandlers(input: Parameters<typeof createCreateWorkOrchestrationToolHandler>[0]) {
  return {
    "create_work_orchestration": createCreateWorkOrchestrationToolHandler(input),
    "run_ready_work_streams": createRunReadyWorkStreamsToolHandler(input),
    "sync_work_orchestration": createSyncWorkOrchestrationToolHandler(input),
    "write_work_orchestration_report": createWriteWorkOrchestrationReportToolHandler(input),
  };
}
