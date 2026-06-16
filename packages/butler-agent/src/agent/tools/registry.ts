import type { ButlerToolDefinition, ToolCapabilityMetadata } from "./types.ts";
import { webSearchToolDefinition, webSearchToolMetadata } from "./web-search/index.ts";
import { webReadToolDefinition, webReadToolMetadata } from "./web-read/index.ts";
import { transformPublicDataTableToolDefinition, transformPublicDataTableToolMetadata } from "./data-table/index.ts";
import { runCommandToolDefinition, runCommandToolMetadata } from "./run-command/index.ts";
import {
  completeProjectWorkToolDefinition,
  completeProjectWorkToolMetadata,
  getWorkDashboardToolDefinition,
  getWorkDashboardToolMetadata,
  inspectProjectStatusToolDefinition,
  inspectProjectStatusToolMetadata,
  queryProjectWorkToolDefinition,
  queryProjectWorkToolMetadata,
  renderProjectDashboardToolDefinition,
  renderProjectDashboardToolMetadata,
} from "./project-ledger/index.ts";
import {
  getContextMonitorToolDefinition,
  getContextMonitorToolMetadata,
  getMemoryHealthToolDefinition,
  getMemoryHealthToolMetadata,
  getUsageMonitorToolDefinition,
  getUsageMonitorToolMetadata,
  listToolCapabilitiesToolDefinition,
  listToolCapabilitiesToolMetadata,
  readToolOutputArtifactToolDefinition,
  readToolOutputArtifactToolMetadata,
} from "./monitoring/index.ts";
import { listMcpCapabilitiesToolDefinition, listMcpCapabilitiesToolMetadata } from "./list_mcp_capabilities/index.ts";
import { callMcpToolToolDefinition, callMcpToolToolMetadata } from "./call_mcp_tool/index.ts";
import { readMcpResourceToolDefinition, readMcpResourceToolMetadata } from "./read_mcp_resource/index.ts";
import { createAutomationToolDefinition, createAutomationToolMetadata } from "./create_automation/index.ts";
import { listAutomationsToolDefinition, listAutomationsToolMetadata } from "./list_automations/index.ts";
import { deleteAutomationToolDefinition, deleteAutomationToolMetadata } from "./delete_automation/index.ts";
import { runDueAutomationsToolDefinition, runDueAutomationsToolMetadata } from "./run_due_automations/index.ts";
import { updateTodoListToolDefinition, updateTodoListToolMetadata } from "./update_todo_list/index.ts";
import { listTodoListToolDefinition, listTodoListToolMetadata } from "./list_todo_list/index.ts";
import { listWorkStreamsToolDefinition, listWorkStreamsToolMetadata } from "./list_work_streams/index.ts";
import { updateWorkStreamStateToolDefinition, updateWorkStreamStateToolMetadata } from "./update_work_stream_state/index.ts";
import { controlWorkToolDefinition, controlWorkToolMetadata } from "./control_work/index.ts";
import { ingestTaskMemoryToolDefinition, ingestTaskMemoryToolMetadata } from "./ingest_task_memory/index.ts";
import { recallMemoryToolDefinition, recallMemoryToolMetadata } from "./recall_memory/index.ts";
import { queryMemoryToolDefinition, queryMemoryToolMetadata } from "./query_memory/index.ts";
import { summarizeUserProfileToolDefinition, summarizeUserProfileToolMetadata } from "./summarize_user_profile/index.ts";
import { updateOnboardingProfileToolDefinition, updateOnboardingProfileToolMetadata } from "./update_onboarding_profile/index.ts";
import { readConversationContextToolDefinition, readConversationContextToolMetadata } from "./read_conversation_context/index.ts";
import { updateExplicitMemoryToolDefinition, updateExplicitMemoryToolMetadata } from "./update_explicit_memory/index.ts";
import { listSkillsToolDefinition, listSkillsToolMetadata } from "./list_skills/index.ts";
import { dispatchWorkerToolDefinition, dispatchWorkerToolMetadata } from "./dispatch_worker/index.ts";
import { createPlannedTaskToolDefinition, createPlannedTaskToolMetadata } from "./create_planned_task/index.ts";
import { runPlannedTaskToolDefinition, runPlannedTaskToolMetadata } from "./run_planned_task/index.ts";
import { reviewPlannedTaskToolDefinition, reviewPlannedTaskToolMetadata } from "./review_planned_task/index.ts";
import { repairPlannedTaskToolDefinition, repairPlannedTaskToolMetadata } from "./repair_planned_task/index.ts";
import { requestPrincipalDecisionToolDefinition, requestPrincipalDecisionToolMetadata } from "./request_principal_decision/index.ts";
import { writePlannedPublicReportToolDefinition, writePlannedPublicReportToolMetadata } from "./write_planned_public_report/index.ts";
import { resumeWorkerToolDefinition, resumeWorkerToolMetadata } from "./resume_worker/index.ts";
import { createWorkOrchestrationToolDefinition, createWorkOrchestrationToolMetadata } from "./create_work_orchestration/index.ts";
import { runReadyWorkStreamsToolDefinition, runReadyWorkStreamsToolMetadata } from "./run_ready_work_streams/index.ts";
import { syncWorkOrchestrationToolDefinition, syncWorkOrchestrationToolMetadata } from "./sync_work_orchestration/index.ts";
import { writeWorkOrchestrationReportToolDefinition, writeWorkOrchestrationReportToolMetadata } from "./write_work_orchestration_report/index.ts";
import { listTasksToolDefinition, listTasksToolMetadata } from "./list_tasks/index.ts";
import { getTaskResultToolDefinition, getTaskResultToolMetadata } from "./get_task_result/index.ts";

export const CORE_BUTLER_TOOLS = [
  webSearchToolDefinition,
  webReadToolDefinition,
  transformPublicDataTableToolDefinition,
  runCommandToolDefinition,
  getWorkDashboardToolDefinition,
  inspectProjectStatusToolDefinition,
  queryProjectWorkToolDefinition,
  renderProjectDashboardToolDefinition,
  completeProjectWorkToolDefinition,
  getContextMonitorToolDefinition,
  readToolOutputArtifactToolDefinition,
  getUsageMonitorToolDefinition,
  listToolCapabilitiesToolDefinition,
  listMcpCapabilitiesToolDefinition,
  callMcpToolToolDefinition,
  readMcpResourceToolDefinition,
  createAutomationToolDefinition,
  listAutomationsToolDefinition,
  deleteAutomationToolDefinition,
  runDueAutomationsToolDefinition,
  updateTodoListToolDefinition,
  listTodoListToolDefinition,
  listWorkStreamsToolDefinition,
  updateWorkStreamStateToolDefinition,
  controlWorkToolDefinition,
  getMemoryHealthToolDefinition,
  ingestTaskMemoryToolDefinition,
  recallMemoryToolDefinition,
  queryMemoryToolDefinition,
  summarizeUserProfileToolDefinition,
  updateOnboardingProfileToolDefinition,
  readConversationContextToolDefinition,
  updateExplicitMemoryToolDefinition,
  listSkillsToolDefinition,
  dispatchWorkerToolDefinition,
  createPlannedTaskToolDefinition,
  runPlannedTaskToolDefinition,
  reviewPlannedTaskToolDefinition,
  repairPlannedTaskToolDefinition,
  requestPrincipalDecisionToolDefinition,
  writePlannedPublicReportToolDefinition,
  resumeWorkerToolDefinition,
  createWorkOrchestrationToolDefinition,
  runReadyWorkStreamsToolDefinition,
  syncWorkOrchestrationToolDefinition,
  writeWorkOrchestrationReportToolDefinition,
  listTasksToolDefinition,
  getTaskResultToolDefinition,
] satisfies ButlerToolDefinition[];

export const BUTLER_TOOLS = CORE_BUTLER_TOOLS;

export const TOOL_CAPABILITY_METADATA: Record<string, ToolCapabilityMetadata> = {
  [webSearchToolDefinition.name]: webSearchToolMetadata,
  [webReadToolDefinition.name]: webReadToolMetadata,
  [transformPublicDataTableToolDefinition.name]: transformPublicDataTableToolMetadata,
  [runCommandToolDefinition.name]: runCommandToolMetadata,
  [getWorkDashboardToolDefinition.name]: getWorkDashboardToolMetadata,
  [inspectProjectStatusToolDefinition.name]: inspectProjectStatusToolMetadata,
  [queryProjectWorkToolDefinition.name]: queryProjectWorkToolMetadata,
  [renderProjectDashboardToolDefinition.name]: renderProjectDashboardToolMetadata,
  [completeProjectWorkToolDefinition.name]: completeProjectWorkToolMetadata,
  [getContextMonitorToolDefinition.name]: getContextMonitorToolMetadata,
  [readToolOutputArtifactToolDefinition.name]: readToolOutputArtifactToolMetadata,
  [getUsageMonitorToolDefinition.name]: getUsageMonitorToolMetadata,
  [listToolCapabilitiesToolDefinition.name]: listToolCapabilitiesToolMetadata,
  [listMcpCapabilitiesToolDefinition.name]: listMcpCapabilitiesToolMetadata,
  [callMcpToolToolDefinition.name]: callMcpToolToolMetadata,
  [readMcpResourceToolDefinition.name]: readMcpResourceToolMetadata,
  [createAutomationToolDefinition.name]: createAutomationToolMetadata,
  [listAutomationsToolDefinition.name]: listAutomationsToolMetadata,
  [deleteAutomationToolDefinition.name]: deleteAutomationToolMetadata,
  [runDueAutomationsToolDefinition.name]: runDueAutomationsToolMetadata,
  [updateTodoListToolDefinition.name]: updateTodoListToolMetadata,
  [listTodoListToolDefinition.name]: listTodoListToolMetadata,
  [listWorkStreamsToolDefinition.name]: listWorkStreamsToolMetadata,
  [updateWorkStreamStateToolDefinition.name]: updateWorkStreamStateToolMetadata,
  [controlWorkToolDefinition.name]: controlWorkToolMetadata,
  [getMemoryHealthToolDefinition.name]: getMemoryHealthToolMetadata,
  [ingestTaskMemoryToolDefinition.name]: ingestTaskMemoryToolMetadata,
  [recallMemoryToolDefinition.name]: recallMemoryToolMetadata,
  [queryMemoryToolDefinition.name]: queryMemoryToolMetadata,
  [summarizeUserProfileToolDefinition.name]: summarizeUserProfileToolMetadata,
  [updateOnboardingProfileToolDefinition.name]: updateOnboardingProfileToolMetadata,
  [readConversationContextToolDefinition.name]: readConversationContextToolMetadata,
  [updateExplicitMemoryToolDefinition.name]: updateExplicitMemoryToolMetadata,
  [listSkillsToolDefinition.name]: listSkillsToolMetadata,
  [dispatchWorkerToolDefinition.name]: dispatchWorkerToolMetadata,
  [createPlannedTaskToolDefinition.name]: createPlannedTaskToolMetadata,
  [runPlannedTaskToolDefinition.name]: runPlannedTaskToolMetadata,
  [reviewPlannedTaskToolDefinition.name]: reviewPlannedTaskToolMetadata,
  [repairPlannedTaskToolDefinition.name]: repairPlannedTaskToolMetadata,
  [requestPrincipalDecisionToolDefinition.name]: requestPrincipalDecisionToolMetadata,
  [writePlannedPublicReportToolDefinition.name]: writePlannedPublicReportToolMetadata,
  [resumeWorkerToolDefinition.name]: resumeWorkerToolMetadata,
  [createWorkOrchestrationToolDefinition.name]: createWorkOrchestrationToolMetadata,
  [runReadyWorkStreamsToolDefinition.name]: runReadyWorkStreamsToolMetadata,
  [syncWorkOrchestrationToolDefinition.name]: syncWorkOrchestrationToolMetadata,
  [writeWorkOrchestrationReportToolDefinition.name]: writeWorkOrchestrationReportToolMetadata,
  [listTasksToolDefinition.name]: listTasksToolMetadata,
  [getTaskResultToolDefinition.name]: getTaskResultToolMetadata,
};
