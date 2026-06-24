import type { ButlerToolDefinition, ToolCapabilityMetadata } from "./types.ts";
import { webSearchToolDefinition, webSearchToolMetadata } from "./web-search/web_search/index.ts";
import { webReadToolDefinition, webReadToolMetadata } from "./web-read/web_read/index.ts";
import { transformPublicDataTableToolDefinition, transformPublicDataTableToolMetadata } from "./data-table/transform_public_data_table/index.ts";
import { runCommandToolDefinition, runCommandToolMetadata } from "./run-command/run_command/index.ts";
import { grepFilesToolDefinition, grepFilesToolMetadata, readFileToolDefinition, readFileToolMetadata, writeFileToolDefinition, writeFileToolMetadata } from "./file-tools/index.ts";
import { getWorkDashboardToolDefinition, getWorkDashboardToolMetadata } from "./project-ledger/get_work_dashboard/index.ts";
import { inspectProjectStatusToolDefinition, inspectProjectStatusToolMetadata } from "./project-ledger/inspect_project_status/index.ts";
import { queryProjectWorkToolDefinition, queryProjectWorkToolMetadata } from "./project-ledger/query_project_work/index.ts";
import { renderProjectDashboardToolDefinition, renderProjectDashboardToolMetadata } from "./project-ledger/render_project_dashboard/index.ts";
import { completeProjectWorkToolDefinition, completeProjectWorkToolMetadata } from "./project-ledger/complete_project_work/index.ts";
import { getContextMonitorToolDefinition, getContextMonitorToolMetadata } from "./monitoring/get_context_monitor/index.ts";
import { readToolOutputArtifactToolDefinition, readToolOutputArtifactToolMetadata } from "./monitoring/read_tool_output_artifact/index.ts";
import { getUsageMonitorToolDefinition, getUsageMonitorToolMetadata } from "./monitoring/get_usage_monitor/index.ts";
import { listToolCapabilitiesToolDefinition, listToolCapabilitiesToolMetadata } from "./monitoring/list_tool_capabilities/index.ts";
import { toolSearchToolDefinition, toolSearchToolMetadata } from "./tool-bridge/tool_search/index.ts";
import { toolDescribeToolDefinition, toolDescribeToolMetadata } from "./tool-bridge/tool_describe/index.ts";
import { toolCallToolDefinition, toolCallToolMetadata } from "./tool-bridge/tool_call/index.ts";
import { listMcpCapabilitiesToolDefinition, listMcpCapabilitiesToolMetadata } from "./mcp/list_mcp_capabilities/index.ts";
import { callMcpToolToolDefinition, callMcpToolToolMetadata } from "./mcp/call_mcp_tool/index.ts";
import { readMcpResourceToolDefinition, readMcpResourceToolMetadata } from "./mcp/read_mcp_resource/index.ts";
import { createAutomationToolDefinition, createAutomationToolMetadata } from "./automation/create_automation/index.ts";
import { listAutomationsToolDefinition, listAutomationsToolMetadata } from "./automation/list_automations/index.ts";
import { deleteAutomationToolDefinition, deleteAutomationToolMetadata } from "./automation/delete_automation/index.ts";
import { runDueAutomationsToolDefinition, runDueAutomationsToolMetadata } from "./automation/run_due_automations/index.ts";
import { updateTodoListToolDefinition, updateTodoListToolMetadata } from "./work-tracking/update_todo_list/index.ts";
import { listTodoListToolDefinition, listTodoListToolMetadata } from "./work-tracking/list_todo_list/index.ts";
import { listWorkStreamsToolDefinition, listWorkStreamsToolMetadata } from "./work-tracking/list_work_streams/index.ts";
import { updateWorkStreamStateToolDefinition, updateWorkStreamStateToolMetadata } from "./work-tracking/update_work_stream_state/index.ts";
import { controlWorkToolDefinition, controlWorkToolMetadata } from "./work-tracking/control_work/index.ts";
import { getMemoryHealthToolDefinition, getMemoryHealthToolMetadata } from "./monitoring/get_memory_health/index.ts";
import { ingestTaskMemoryToolDefinition, ingestTaskMemoryToolMetadata } from "./memory/ingest_task_memory/index.ts";
import { recallMemoryToolDefinition, recallMemoryToolMetadata } from "./memory/recall_memory/index.ts";
import { queryMemoryToolDefinition, queryMemoryToolMetadata } from "./memory/query_memory/index.ts";
import { summarizeUserProfileToolDefinition, summarizeUserProfileToolMetadata } from "./memory/summarize_user_profile/index.ts";
import { updateOnboardingProfileToolDefinition, updateOnboardingProfileToolMetadata } from "./memory/update_onboarding_profile/index.ts";
import { readConversationContextToolDefinition, readConversationContextToolMetadata } from "./memory/read_conversation_context/index.ts";
import { updateExplicitMemoryToolDefinition, updateExplicitMemoryToolMetadata } from "./memory/update_explicit_memory/index.ts";
import { listSkillsToolDefinition, listSkillsToolMetadata } from "./skills/list_skills/index.ts";
import { dispatchWorkerToolDefinition, dispatchWorkerToolMetadata } from "./worker/dispatch_worker/index.ts";
import { createPlannedTaskToolDefinition, createPlannedTaskToolMetadata } from "./planned-task/create_planned_task/index.ts";
import { runPlannedTaskToolDefinition, runPlannedTaskToolMetadata } from "./planned-task/run_planned_task/index.ts";
import { reviewPlannedTaskToolDefinition, reviewPlannedTaskToolMetadata } from "./planned-task/review_planned_task/index.ts";
import { repairPlannedTaskToolDefinition, repairPlannedTaskToolMetadata } from "./planned-task/repair_planned_task/index.ts";
import { requestPrincipalDecisionToolDefinition, requestPrincipalDecisionToolMetadata } from "./planned-task/request_principal_decision/index.ts";
import { writePlannedPublicReportToolDefinition, writePlannedPublicReportToolMetadata } from "./planned-task/write_planned_public_report/index.ts";
import { resumeWorkerToolDefinition, resumeWorkerToolMetadata } from "./worker/resume_worker/index.ts";
import { createWorkOrchestrationToolDefinition, createWorkOrchestrationToolMetadata } from "./orchestration/create_work_orchestration/index.ts";
import { runReadyWorkStreamsToolDefinition, runReadyWorkStreamsToolMetadata } from "./orchestration/run_ready_work_streams/index.ts";
import { syncWorkOrchestrationToolDefinition, syncWorkOrchestrationToolMetadata } from "./orchestration/sync_work_orchestration/index.ts";
import { writeWorkOrchestrationReportToolDefinition, writeWorkOrchestrationReportToolMetadata } from "./orchestration/write_work_orchestration_report/index.ts";
import { listTasksToolDefinition, listTasksToolMetadata } from "./worker/list_tasks/index.ts";
import { getTaskResultToolDefinition, getTaskResultToolMetadata } from "./worker/get_task_result/index.ts";

export const CORE_BUTLER_TOOLS = [
  webSearchToolDefinition,
  webReadToolDefinition,
  transformPublicDataTableToolDefinition,
  runCommandToolDefinition,
  readFileToolDefinition,
  writeFileToolDefinition,
  grepFilesToolDefinition,
  getWorkDashboardToolDefinition,
  inspectProjectStatusToolDefinition,
  queryProjectWorkToolDefinition,
  renderProjectDashboardToolDefinition,
  completeProjectWorkToolDefinition,
  getContextMonitorToolDefinition,
  readToolOutputArtifactToolDefinition,
  getUsageMonitorToolDefinition,
  listToolCapabilitiesToolDefinition,
  toolSearchToolDefinition,
  toolDescribeToolDefinition,
  toolCallToolDefinition,
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
  [readFileToolDefinition.name]: readFileToolMetadata,
  [writeFileToolDefinition.name]: writeFileToolMetadata,
  [grepFilesToolDefinition.name]: grepFilesToolMetadata,
  [getWorkDashboardToolDefinition.name]: getWorkDashboardToolMetadata,
  [inspectProjectStatusToolDefinition.name]: inspectProjectStatusToolMetadata,
  [queryProjectWorkToolDefinition.name]: queryProjectWorkToolMetadata,
  [renderProjectDashboardToolDefinition.name]: renderProjectDashboardToolMetadata,
  [completeProjectWorkToolDefinition.name]: completeProjectWorkToolMetadata,
  [getContextMonitorToolDefinition.name]: getContextMonitorToolMetadata,
  [readToolOutputArtifactToolDefinition.name]: readToolOutputArtifactToolMetadata,
  [getUsageMonitorToolDefinition.name]: getUsageMonitorToolMetadata,
  [listToolCapabilitiesToolDefinition.name]: listToolCapabilitiesToolMetadata,
  [toolSearchToolDefinition.name]: toolSearchToolMetadata,
  [toolDescribeToolDefinition.name]: toolDescribeToolMetadata,
  [toolCallToolDefinition.name]: toolCallToolMetadata,
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
