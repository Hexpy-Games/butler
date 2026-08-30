import type { ButlerToolDefinition, ToolCapabilityMetadata } from "./types.ts";
import { webSearchToolDefinition, webSearchToolMetadata } from "./web-search/web_search/index.ts";
import { webReadToolDefinition, webReadToolMetadata } from "./web-read/web_read/index.ts";
import { transformPublicDataTableToolDefinition, transformPublicDataTableToolMetadata } from "./data-table/transform_public_data_table/index.ts";
import { runCommandToolDefinition, runCommandToolMetadata } from "./run-command/run_command/index.ts";
import { editFileToolDefinition, editFileToolMetadata, grepFilesToolDefinition, grepFilesToolMetadata, listFilesToolDefinition, listFilesToolMetadata, readFileToolDefinition, readFileToolMetadata, writeFileToolDefinition, writeFileToolMetadata } from "./file-tools/index.ts";
import { getWorkDashboardToolDefinition, getWorkDashboardToolMetadata } from "./project-ledger/get_work_dashboard/index.ts";
import { inspectProjectStatusToolDefinition, inspectProjectStatusToolMetadata } from "./project-ledger/inspect_project_status/index.ts";
import { queryProjectWorkToolDefinition, queryProjectWorkToolMetadata } from "./project-ledger/query_project_work/index.ts";
import { renderProjectDashboardToolDefinition, renderProjectDashboardToolMetadata } from "./project-ledger/render_project_dashboard/index.ts";
import { completeProjectWorkToolDefinition, completeProjectWorkToolMetadata } from "./project-ledger/complete_project_work/index.ts";
import { projectLedgerNativeToolDefinitions, projectLedgerNativeToolMetadata } from "./project-ledger/native.ts";
import { getContextMonitorToolDefinition, getContextMonitorToolMetadata } from "./monitoring/get_context_monitor/index.ts";
import { readToolEvidenceArtifactToolDefinition, readToolEvidenceArtifactToolMetadata } from "./monitoring/read_tool_evidence_artifact/index.ts";
import { readToolOutputArtifactToolDefinition, readToolOutputArtifactToolMetadata } from "./monitoring/read_tool_output_artifact/index.ts";
import { getUsageMonitorToolDefinition, getUsageMonitorToolMetadata } from "./monitoring/get_usage_monitor/index.ts";
import { listToolCapabilitiesToolDefinition, listToolCapabilitiesToolMetadata } from "./monitoring/list_tool_capabilities/index.ts";
import { toolSearchToolDefinition, toolSearchToolMetadata } from "./tool-bridge/tool_search/index.ts";
import { toolDescribeToolDefinition, toolDescribeToolMetadata } from "./tool-bridge/tool_describe/index.ts";
import { toolCallToolDefinition, toolCallToolMetadata } from "./tool-bridge/tool_call/index.ts";
import { listMcpCapabilitiesToolDefinition, listMcpCapabilitiesToolMetadata } from "./mcp/list_mcp_capabilities/index.ts";
import { callMcpToolToolDefinition, callMcpToolToolMetadata } from "./mcp/call_mcp_tool/index.ts";
import { readMcpResourceToolDefinition, readMcpResourceToolMetadata } from "./mcp/read_mcp_resource/index.ts";
import {
  analyzeAttachedImageToolDefinition,
  analyzeAttachedImageToolMetadata,
} from "./image/index.ts";
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
import { listConversationSessionsToolDefinition, listConversationSessionsToolMetadata } from "./memory/list_conversation_sessions/index.ts";
import { readConversationSessionToolDefinition, readConversationSessionToolMetadata } from "./memory/read_conversation_session/index.ts";
import { updateExplicitMemoryToolDefinition, updateExplicitMemoryToolMetadata } from "./memory/update_explicit_memory/index.ts";
import { listSkillsToolDefinition, listSkillsToolMetadata } from "./skills/list_skills/index.ts";
import {
  bindSessionGitWorktreeToolDefinition,
  bindSessionGitWorktreeToolMetadata,
} from "./session-workspace/index.ts";
import {
  readOperationResultsToolDefinition,
  readOperationResultsToolMetadata,
} from "./monitoring/read_operation_results/index.ts";
import {
  cancelStewardToolDefinition,
  cancelStewardToolMetadata,
  delegateToStewardToolDefinition,
  delegateToStewardToolMetadata,
  delegateToWorkerToolDefinition,
  delegateToWorkerToolMetadata,
  steerStewardToolDefinition,
  steerStewardToolMetadata,
  steerWorkerToolDefinition,
  steerWorkerToolMetadata,
} from "./subsession/index.ts";

export const CORE_BUTLER_TOOLS = [
  webSearchToolDefinition,
  webReadToolDefinition,
  transformPublicDataTableToolDefinition,
  runCommandToolDefinition,
  readFileToolDefinition,
  writeFileToolDefinition,
  editFileToolDefinition,
  grepFilesToolDefinition,
  listFilesToolDefinition,
  bindSessionGitWorktreeToolDefinition,
  ...projectLedgerNativeToolDefinitions,
  getWorkDashboardToolDefinition,
  inspectProjectStatusToolDefinition,
  queryProjectWorkToolDefinition,
  renderProjectDashboardToolDefinition,
  completeProjectWorkToolDefinition,
  getContextMonitorToolDefinition,
  readOperationResultsToolDefinition,
  readToolEvidenceArtifactToolDefinition,
  readToolOutputArtifactToolDefinition,
  getUsageMonitorToolDefinition,
  listToolCapabilitiesToolDefinition,
  toolSearchToolDefinition,
  toolDescribeToolDefinition,
  toolCallToolDefinition,
  listMcpCapabilitiesToolDefinition,
  callMcpToolToolDefinition,
  readMcpResourceToolDefinition,
  analyzeAttachedImageToolDefinition,
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
  listConversationSessionsToolDefinition,
  readConversationSessionToolDefinition,
  updateExplicitMemoryToolDefinition,
  listSkillsToolDefinition,
  delegateToStewardToolDefinition,
  delegateToWorkerToolDefinition,
  steerStewardToolDefinition,
  steerWorkerToolDefinition,
  cancelStewardToolDefinition,
] satisfies ButlerToolDefinition[];

export const BUTLER_TOOLS = CORE_BUTLER_TOOLS;

export const TOOL_CAPABILITY_METADATA: Record<string, ToolCapabilityMetadata> = {
  [webSearchToolDefinition.name]: webSearchToolMetadata,
  [webReadToolDefinition.name]: webReadToolMetadata,
  [transformPublicDataTableToolDefinition.name]: transformPublicDataTableToolMetadata,
  [runCommandToolDefinition.name]: runCommandToolMetadata,
  [readFileToolDefinition.name]: readFileToolMetadata,
  [writeFileToolDefinition.name]: writeFileToolMetadata,
  [editFileToolDefinition.name]: editFileToolMetadata,
  [grepFilesToolDefinition.name]: grepFilesToolMetadata,
  [listFilesToolDefinition.name]: listFilesToolMetadata,
  [bindSessionGitWorktreeToolDefinition.name]: bindSessionGitWorktreeToolMetadata,
  ...projectLedgerNativeToolMetadata,
  [getWorkDashboardToolDefinition.name]: getWorkDashboardToolMetadata,
  [inspectProjectStatusToolDefinition.name]: inspectProjectStatusToolMetadata,
  [queryProjectWorkToolDefinition.name]: queryProjectWorkToolMetadata,
  [renderProjectDashboardToolDefinition.name]: renderProjectDashboardToolMetadata,
  [completeProjectWorkToolDefinition.name]: completeProjectWorkToolMetadata,
  [getContextMonitorToolDefinition.name]: getContextMonitorToolMetadata,
  [readOperationResultsToolDefinition.name]: readOperationResultsToolMetadata,
  [readToolEvidenceArtifactToolDefinition.name]: readToolEvidenceArtifactToolMetadata,
  [readToolOutputArtifactToolDefinition.name]: readToolOutputArtifactToolMetadata,
  [getUsageMonitorToolDefinition.name]: getUsageMonitorToolMetadata,
  [listToolCapabilitiesToolDefinition.name]: listToolCapabilitiesToolMetadata,
  [toolSearchToolDefinition.name]: toolSearchToolMetadata,
  [toolDescribeToolDefinition.name]: toolDescribeToolMetadata,
  [toolCallToolDefinition.name]: toolCallToolMetadata,
  [listMcpCapabilitiesToolDefinition.name]: listMcpCapabilitiesToolMetadata,
  [callMcpToolToolDefinition.name]: callMcpToolToolMetadata,
  [readMcpResourceToolDefinition.name]: readMcpResourceToolMetadata,
  [analyzeAttachedImageToolDefinition.name]: analyzeAttachedImageToolMetadata,
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
  [listConversationSessionsToolDefinition.name]: listConversationSessionsToolMetadata,
  [readConversationSessionToolDefinition.name]: readConversationSessionToolMetadata,
  [updateExplicitMemoryToolDefinition.name]: updateExplicitMemoryToolMetadata,
  [listSkillsToolDefinition.name]: listSkillsToolMetadata,
  [delegateToStewardToolDefinition.name]: delegateToStewardToolMetadata,
  [delegateToWorkerToolDefinition.name]: delegateToWorkerToolMetadata,
  [steerStewardToolDefinition.name]: steerStewardToolMetadata,
  [steerWorkerToolDefinition.name]: steerWorkerToolMetadata,
  [cancelStewardToolDefinition.name]: cancelStewardToolMetadata,
};
