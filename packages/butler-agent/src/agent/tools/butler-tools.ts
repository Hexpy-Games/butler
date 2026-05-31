import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "fs";
import { extname, isAbsolute, join, relative, resolve } from "path";
import {
  createPlannedTaskId,
  missingReviewCriteria,
  plannedInternalGoal,
  PlannedTaskStore,
  type PlannedCriterionReview,
  type PlannedDecisionOption,
  type PlannedDecisionRequest,
  type PlannedGoalReview,
  type PlannedReviewVerdict,
  type PlannedTaskPlan,
} from "../work/planned-task.ts";
import { TaskStore, workSafetyForTask } from "../work/task-store.ts";
import {
  WorkOrchestrationStore,
  orchestrationWorkerPrompt,
  type WorkStreamInput,
} from "../work/work-orchestration.ts";
import {
  TodoListStore,
  type TodoItemInput,
  type TodoPhase,
  type TodoPriority,
  type TodoStatus,
} from "../work/todo-list.ts";
import {
  WorkStreamStore,
  type WorkStreamState,
} from "../work/work-stream.ts";
import { buildTaskOriginContext } from "../work/task-origin.ts";
import {
  createConfiguredWebSearchProvider,
  recordWebSearchMetric,
  type WebSearchInput,
  type WebSearchOutput,
  type WebSearchProvider,
} from "../../integrations/search/provider.ts";
import {
  createSmartSearchPlan,
  type SearchPlan,
  type SmartSearchPlanningInput,
  type SmartSearchPlanningResult,
} from "../../integrations/search/planning.ts";
import {
  readPageConfigured,
  type PageReaderBackendId,
  type PageReadResult,
} from "../../integrations/search/page-reader.ts";
import {
  projectLedgerProjectPath,
  projectLedgerRenderedViewEvidence,
  runProjectLedgerTool,
} from "../../integrations/project-ledger/client.ts";
import { butlerAgentScriptPath } from "../../runtime/paths.ts";
import { createWorkDashboard, performWorkControl } from "../work/work-dashboard.ts";
import { readContextMonitor } from "../../operations/metrics/context-monitor.ts";
import { AutomationStore, type AutomationSchedule } from "../../operations/service/automation-store.ts";
import { readUsageMonitor } from "../../operations/metrics/usage-monitor.ts";
import {
  ingestTaskOutcomeMemory,
  recallMemoryEvidence,
  readMemoryHealth,
  updateExplicitMemory,
} from "../cognition/memory/quality.ts";
import { queryMemory } from "../cognition/memory/exact-query.ts";
import { readReflectiveProfileSummary, type ProfilingMode } from "../../personalization/profiling.ts";
import {
  recordWeatherFeedback,
  runWeatherConsolidationReview,
  runWeatherKnowHow,
  type WeatherSourceId,
} from "../cognition/weather-knowhow.ts";
import {
  budgetToolOutput,
  readToolOutputArtifactSlice,
  type ShellCommandResult,
} from "../context/tool-output-budgeter.ts";
import {
  readConversationContext,
  type ConversationContextDirection,
} from "../context/conversation-context.ts";
import {
  updateFirstChatOnboarding,
  type FirstChatOnboardingPersonaPreset,
} from "../../personalization/onboarding.ts";
import {
  validateSkillCatalog,
} from "../../integrations/skills/catalog.ts";
import { loadRuntimeSkills } from "../../integrations/skills/manager.ts";
import {
  callMcpTool,
  listMcpServerCapabilities,
  readMcpResource,
} from "../../interfaces/mcp-client/client.ts";
import type { AgentLoopToolDefinition } from "../turn/agent-loop.ts";
import type {
  FunctionToolDefinition,
  FunctionToolPromptOptions,
} from "../../integrations/providers/provider.ts";
import type { ReasoningEffort } from "../../integrations/providers/model-catalog.ts";
import type {
  EvidenceArtifactRef,
  EvidenceReceipt,
  EvidenceReference,
  PublicWorkObligationKind,
} from "../turn/native-tool-types.ts";
import {
  evidenceReceiptsFromResult,
  satisfiedCompletionObligationsFromEvidenceReceipts,
} from "../output/evidence-receipts.ts";
import { sanitizePublicText } from "../events/turn-events.ts";

export interface ButlerToolDefinition extends FunctionToolDefinition {
  concurrencySafe: boolean;
  interruptBehavior: "continue" | "cancel";
  transcriptVisibility: "visible";
}

export type ButlerToolExecutor = FunctionToolPromptOptions["executeTool"];

type ToolCapabilityCategory =
  | "search"
  | "data"
  | "command"
  | "work"
  | "monitoring"
  | "automation"
  | "todo"
  | "memory"
  | "project"
  | "skill"
  | "mcp"
  | "dispatch"
  | "control";

interface ToolCapabilityMetadata {
  category: ToolCapabilityCategory;
  tags: string[];
  safetyNotes: string[];
  satisfiesCompletionObligations?: PublicWorkObligationKind[];
}

interface ToolCapabilityView {
  name: string;
  description: string;
  category: ToolCapabilityCategory;
  enabled: boolean;
  disabled_reason: string | null;
  concurrency_safe: boolean;
  interrupt_behavior: ButlerToolDefinition["interruptBehavior"];
  transcript_visibility: ButlerToolDefinition["transcriptVisibility"];
  tags: string[];
  safety_notes: string[];
}

const DEFAULT_TOOL_CAPABILITY: ToolCapabilityMetadata = {
  category: "control",
  tags: [],
  safetyNotes: ["Use only when the tool schema matches the user's intent."],
};

function evidenceReceipt(input: {
  producerName: string;
  receiptType: EvidenceReceipt["receiptType"];
  summary: string;
  covers?: string[];
  verified?: boolean;
  references?: EvidenceReference[];
  artifacts?: EvidenceArtifactRef[];
  satisfies?: PublicWorkObligationKind[];
  metrics?: Record<string, number>;
}): EvidenceReceipt {
  return {
    schema: "butler.evidence-receipt.v1",
    id: `receipt-${randomUUID().slice(0, 12)}`,
    producer: {
      kind: "tool",
      name: input.producerName,
    },
    receiptType: input.receiptType,
    verified: input.verified !== false,
    covers: input.covers ?? [],
    summary: sanitizePublicText(input.summary, "Tool evidence was produced.").slice(0, 280),
    references: input.references ?? [],
    ...(input.artifacts && input.artifacts.length > 0 ? { artifacts: input.artifacts } : {}),
    ...(input.satisfies && input.satisfies.length > 0 ? { satisfies: [...new Set(input.satisfies)] } : {}),
    ...(input.metrics ? { metrics: input.metrics } : {}),
  };
}

function urlReferences(urls: string[]): EvidenceReference[] {
  return [...new Set(urls.map((url) => url.trim()).filter(Boolean))]
    .slice(0, 12)
    .map((url) => ({
      kind: "url",
      ref: url,
    }));
}

const TOOL_CAPABILITY_METADATA: Record<string, ToolCapabilityMetadata> = {
  web_search: {
    category: "search",
    tags: ["web", "search", "current", "sources", "citations", "검색", "최신", "출처"],
    safetyNotes: ["Use citations from returned source URLs; do not invent sources."],
  },
  web_read: {
    category: "search",
    tags: ["web", "read", "page", "source", "evidence", "원문", "근거", "출처"],
    safetyNotes: ["Read bounded public page evidence; do not dump full pages into final answers."],
  },
  get_weather_with_knowhow: {
    category: "search",
    tags: ["weather", "forecast", "current", "freshness", "know-how", "날씨", "기상", "노하우"],
    safetyNotes: ["Fetches live weather source data and validates source timestamps before answering."],
  },
  record_weather_source_feedback: {
    category: "memory",
    tags: ["weather", "feedback", "source-quality", "know-how", "피드백", "날씨"],
    safetyNotes: ["Records explicit user feedback for immediate source suppression and later consolidation."],
  },
  run_weather_knowhow_consolidation: {
    category: "memory",
    tags: ["weather", "consolidation", "feedback", "know-how", "정리", "노하우"],
    safetyNotes: ["Applies active weather feedback to know-how state without exposing raw private text."],
  },
  transform_public_data_table: {
    category: "data",
    tags: ["data", "csv", "table", "transform", "정제", "표", "csv"],
    safetyNotes: ["Transforms bounded public rows only; do not include secrets or private transcript text."],
  },
  run_command: {
    category: "command",
    tags: ["bash", "shell", "command", "terminal", "verify", "file", "명령", "쉘", "검증", "파일"],
    safetyNotes: [
      "Runs non-interactive bash in the active session workspace.",
      "Generated Butler artifacts should be written under $BUTLER_ARTIFACTS_DIR instead of workspace-root artifacts/.",
      "Large stdout/stderr is compacted into Butler-owned tool-output artifacts.",
    ],
  },
  get_work_dashboard: {
    category: "work",
    tags: ["status", "dashboard", "work", "tasks", "상태", "작업"],
    safetyNotes: ["Use mode/safety fields before claiming completion."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  inspect_project_status: {
    category: "project",
    tags: ["project", "ledger", "status", "progress", "roadmap", "handoff"],
    safetyNotes: ["Returns bounded Project Ledger status; read referenced files only when needed."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  query_project_work: {
    category: "project",
    tags: ["project", "ledger", "query", "next", "blocked", "review", "risk"],
    safetyNotes: ["Use bounded query results before broad project-file reads."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  render_project_dashboard: {
    category: "project",
    tags: ["project", "ledger", "dashboard", "handoff", "roadmap", "render"],
    safetyNotes: ["Generated views are derived output, not source of truth."],
  },
  complete_project_work: {
    category: "project",
    tags: ["project", "ledger", "complete", "evidence", "review", "report"],
    safetyNotes: ["Requires validation, review, and report evidence before completing work."],
  },
  get_context_monitor: {
    category: "monitoring",
    tags: ["context", "tokens", "pressure", "prompt"],
    safetyNotes: ["Reports sizes and counters only, not raw private text."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  read_tool_output_artifact: {
    category: "monitoring",
    tags: ["tool", "artifact", "stdout", "stderr", "slice", "debug"],
    safetyNotes: ["Reads only bounded slices of Butler-owned artifacts; avoid dumping full raw output."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  get_usage_monitor: {
    category: "monitoring",
    tags: ["usage", "cost", "cache", "tokens", "tools"],
    safetyNotes: ["Report cost as unavailable unless the tool provides an authoritative estimate."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  list_tool_capabilities: {
    category: "control",
    tags: ["tools", "capabilities", "available", "disabled"],
    safetyNotes: ["Discovery only; does not execute the listed tools."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  list_mcp_capabilities: {
    category: "mcp",
    tags: ["mcp", "tools", "resources", "external", "connector", "server"],
    safetyNotes: ["Discovery only; returns configured MCP tools and resources without executing them."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  call_mcp_tool: {
    category: "mcp",
    tags: ["mcp", "tool", "call", "external", "connector", "server"],
    safetyNotes: ["Calls a configured MCP server tool; inspect tool schema and user intent first."],
  },
  read_mcp_resource: {
    category: "mcp",
    tags: ["mcp", "resource", "read", "external", "connector", "server"],
    safetyNotes: ["Reads a configured MCP resource URI through the selected server."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  create_automation: {
    category: "automation",
    tags: ["schedule", "automation", "reminder", "recurring", "자동화", "예약", "알림"],
    safetyNotes: ["Confirm critical or costly recurring actions before scheduling."],
  },
  list_automations: {
    category: "automation",
    tags: ["schedule", "automation", "list"],
    safetyNotes: ["Returns prompt previews, not full private prompts."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  delete_automation: {
    category: "automation",
    tags: ["schedule", "automation", "delete"],
    safetyNotes: ["Deletes by id; inspect existing automations first when unsure."],
  },
  run_due_automations: {
    category: "automation",
    tags: ["schedule", "automation", "due"],
    safetyNotes: ["Claims due work; do not run repeatedly unless scheduling state requires it."],
  },
  update_todo_list: {
    category: "todo",
    tags: ["todo", "plan", "progress", "checklist"],
    safetyNotes: ["Use for non-trivial multi-step work, not simple chat answers."],
  },
  list_todo_list: {
    category: "todo",
    tags: ["todo", "progress", "checklist"],
    safetyNotes: ["Use to inspect progress before updating or reporting it."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  list_work_streams: {
    category: "work",
    tags: ["workstream", "fsm", "state", "async", "project", "작업", "상태"],
    safetyNotes: ["Returns public-safe state summaries only, not hidden reasoning."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  update_work_stream_state: {
    category: "work",
    tags: ["workstream", "fsm", "state", "pause", "resume", "review"],
    safetyNotes: ["Validates state transitions before updating durable state."],
  },
  control_work: {
    category: "work",
    tags: ["status", "resume", "cancel", "retry", "result"],
    safetyNotes: ["Validates task state before returning a control intent."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  get_memory_health: {
    category: "memory",
    tags: ["memory", "health", "graph", "vector"],
    safetyNotes: ["Reports counts and freshness only, not private memory text."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  ingest_task_memory: {
    category: "memory",
    tags: ["memory", "ingest", "task"],
    safetyNotes: ["Ingest only completed task outcomes with durable evidence."],
  },
  recall_memory: {
    category: "memory",
    tags: ["memory", "recall", "association", "search"],
    safetyNotes: ["Treat recall as evidence to consider, not guaranteed truth."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  query_memory: {
    category: "memory",
    tags: ["memory", "query", "transcript", "exact", "date", "earliest", "latest"],
    safetyNotes: ["Use for exact transcript/history dates, counts, earliest/latest evidence, not associative recall."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  summarize_user_profile: {
    category: "memory",
    tags: ["profile", "personalization", "reflection", "user", "프로필", "개인화", "사용자"],
    safetyNotes: ["Returns a reflective summary only; it never exposes raw profile tables, candidates, or private evidence."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  update_onboarding_profile: {
    category: "memory",
    tags: ["onboarding", "profile", "persona", "rapport", "개인화", "온보딩", "페르소나"],
    safetyNotes: ["Persist only explicit first-chat onboarding answers; return raw-text-free status summaries."],
  },
  read_conversation_context: {
    category: "memory",
    tags: ["conversation", "transcript", "context", "reference", "대화", "이전", "위에서"],
    safetyNotes: ["Read bounded local transcript slices only; do not dump raw private logs."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  update_explicit_memory: {
    category: "memory",
    tags: ["memory", "rules", "preference"],
    safetyNotes: ["Use only for explicit user preferences or rules with provenance."],
  },
  list_skills: {
    category: "skill",
    tags: ["skills", "strategy", "catalog"],
    safetyNotes: ["Lists strategy skills, not executable tools."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  dispatch_worker: {
    category: "dispatch",
    tags: ["worker", "background", "simple", "task", "워커", "백그라운드"],
    safetyNotes: ["Do not claim dispatch unless the tool succeeds."],
  },
  create_planned_task: {
    category: "dispatch",
    tags: ["planned", "review", "acceptance", "complex", "계획", "검토", "복잡"],
    safetyNotes: ["Creates a plan only; run_planned_task is needed to start work."],
  },
  run_planned_task: {
    category: "dispatch",
    tags: ["planned", "worker", "execute"],
    safetyNotes: ["Starts planned work that must be reviewed before public reporting."],
  },
  review_planned_task: {
    category: "dispatch",
    tags: ["planned", "review", "evidence", "criteria"],
    safetyNotes: ["Every acceptance criterion needs evidence before completion can pass."],
  },
  repair_planned_task: {
    category: "dispatch",
    tags: ["planned", "repair", "retry"],
    safetyNotes: ["Respect retry caps and critical-decision boundaries."],
  },
  request_principal_decision: {
    category: "control",
    tags: ["decision", "principal", "approval", "choice"],
    safetyNotes: ["Use only for critical tradeoffs; include a recommendation."],
  },
  write_planned_public_report: {
    category: "dispatch",
    tags: ["planned", "report", "public", "review"],
    safetyNotes: ["Only after review/reporting guards allow public reporting; report content must be user-facing."],
  },
  resume_worker: {
    category: "dispatch",
    tags: ["worker", "resume", "recoverable", "continue"],
    safetyNotes: ["Use only for recoverable workers with durable context."],
  },
  create_work_orchestration: {
    category: "dispatch",
    tags: ["orchestration", "multi-agent", "streams", "roles", "계획", "역할", "병렬"],
    safetyNotes: ["Creates role-aware streams only; run_ready_work_streams is needed to dispatch work."],
  },
  run_ready_work_streams: {
    category: "dispatch",
    tags: ["orchestration", "dispatch", "dependencies", "streams", "워커", "의존성"],
    safetyNotes: ["Dispatches only dependency-ready pending streams and records worker ids before returning."],
  },
  sync_work_orchestration: {
    category: "dispatch",
    tags: ["orchestration", "sync", "results", "workers", "결과"],
    safetyNotes: ["Promotes streams only from durable worker task state."],
  },
  write_work_orchestration_report: {
    category: "dispatch",
    tags: ["orchestration", "report", "synthesis", "review", "보고"],
    safetyNotes: ["Only reports after all streams are terminal; partial outcomes must not claim completion."],
  },
  list_tasks: {
    category: "work",
    tags: ["tasks", "status", "workers"],
    safetyNotes: ["Use mode/safety fields before reporting task outcomes."],
    satisfiesCompletionObligations: ["source_verified"],
  },
  get_task_result: {
    category: "work",
    tags: ["tasks", "result", "status", "evidence"],
    safetyNotes: ["Answer from durable evidence and respect reporting guards."],
    satisfiesCompletionObligations: ["source_verified"],
  },
};

export const BUTLER_TOOLS: ButlerToolDefinition[] = [
  {
    type: "function",
    name: "web_search",
    description:
      "Search the public web for current or external information. Use this for recent information, public sources, and research that needs citations; Butler may plan multiple focused searches internally when smart search planning is enabled.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Search request or query." },
        allowed_domains: {
          type: "array",
          description: "Only include results from these domains.",
          items: { type: "string" },
        },
        blocked_domains: {
          type: "array",
          description: "Exclude results from these domains.",
          items: { type: "string" },
        },
        recency_days: {
          type: "integer",
          description: "Optional freshness hint in days.",
        },
        max_results: {
          type: "integer",
          description: "Maximum number of results to return.",
        },
      },
      required: ["query"],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "web_read",
    description:
      "Read a public URL through Butler's configured page-reader stack and return bounded page evidence. Use after web_search when snippets are insufficient for exact quotes, current news, or source-backed claims.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", description: "Public http(s) URL to read." },
        max_chars: {
          type: "integer",
          description: "Maximum markdown characters returned to the model.",
        },
        max_chunks: {
          type: "integer",
          description: "Maximum evidence chunks returned.",
        },
        backend: {
          type: "string",
          enum: ["auto", "lightpanda", "lightweight", "jina-hosted", "disabled"],
          description: "Optional page reader backend override.",
        },
      },
      required: ["url"],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "get_weather_with_knowhow",
    description:
      "Get current weather from live timestamped weather sources using Butler Cognition know-how.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        latitude: {
          type: "number",
          description: "WGS84 latitude for the weather location.",
        },
        longitude: {
          type: "number",
          description: "WGS84 longitude for the weather location.",
        },
        location: {
          type: "string",
          description: "Human-readable location name.",
        },
      },
      required: ["latitude", "longitude"],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "record_weather_source_feedback",
    description:
      "Record explicit user feedback that a weather source or weather know-how result was inaccurate, unwanted, or should be avoided next time. If source is omitted, Butler attaches the feedback to the latest weather source used in this session when available.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: {
          type: "string",
          enum: ["open-meteo", "nws"],
          description: "Weather source receiving the feedback.",
        },
        text: {
          type: "string",
          description: "User feedback text.",
        },
      },
      required: ["text"],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "run_weather_knowhow_consolidation",
    description:
      "Apply active weather feedback to Butler Cognition weather know-how state during a manual consolidation review.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "transform_public_data_table",
    description:
      "Create a bounded CSV artifact and preview from a small set of public, non-secret row objects.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: {
          type: "string",
          description: "Short public label for the transformed table.",
        },
        columns: {
          type: "array",
          description: "Column names to keep in the CSV, in output order.",
          items: { type: "string" },
        },
        rows: {
          type: "array",
          description: "Public row objects with primitive values only.",
          items: {
            type: "object",
            additionalProperties: {
              type: ["string", "number", "boolean", "null"],
            },
          },
        },
      },
      required: ["columns", "rows"],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "run_command",
    description:
      "Run a single non-interactive bash command in the active Butler or Steward session workspace and return structured stdout, stderr, exit status, timeout state, and compacted output artifact references when needed. For generated artifacts that are not intentional project/workspace files, write under $BUTLER_ARTIFACTS_DIR instead of creating a workspace-root artifacts/ directory. Prefer focused output over broad dumps: use structured extraction or case-insensitive search for manifest/config/script/log questions, and do not infer absence from one exact case-sensitive match. Keep the command argument JSON-safe: prefer one-line commands, avoid literal newlines inside the command string, and split long scripts into small commands when needed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          description: "The non-interactive bash command to execute.",
        },
        cwd: {
          type: "string",
          description: "Optional working directory. Relative paths resolve from the active session workspace.",
        },
        timeout_ms: {
          type: "integer",
          description: "Optional timeout in milliseconds.",
        },
        max_output_tokens: {
          type: "integer",
          description: "Optional model-facing stdout/stderr token budget before artifact compaction.",
        },
        output_paths: {
          type: "array",
          description: "Relative workspace paths or Butler data artifact labels this command is expected to create or verify. Use artifacts/generated/... for files written through $BUTLER_ARTIFACTS_DIR.",
          items: { type: "string" },
        },
        output_mode: {
          type: "string",
          enum: ["auto", "silent_on_success", "full"],
          description: "Optional output behavior: 'auto' suppresses validation command output on success and bounds failures (default), 'silent_on_success' suppresses all successful output, 'full' preserves all output.",
        },
      },
      required: ["command"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "get_work_dashboard",
    description:
      "Read Butler's canonical work dashboard: active work, recoverable work, failures, report-ready items, and delivery backlog.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        debug: {
          type: "boolean",
          description: "When true, include raw task and delivery identifiers for operator troubleshooting.",
        },
        limit: {
          type: "integer",
          description: "Maximum items per dashboard section.",
        },
      },
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "inspect_project_status",
    description:
      "Inspect a repo-local Project Ledger status summary without reading broad project files.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        project_path: {
          type: "string",
          description: "Absolute project path. Defaults to the Butler repository.",
        },
      },
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "query_project_work",
    description:
      "Query a repo-local Project Ledger for bounded project-management references such as next actions, blockers, missing specs, risks, and stale views.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        project_path: {
          type: "string",
          description: "Absolute project path. Defaults to the Butler repository.",
        },
        kind: {
          type: "string",
          enum: [
            "next-actions",
            "blocked",
            "review",
            "missing-spec",
            "stale-view",
            "recent-completed",
            "completion-gaps",
            "stale-index",
            "decision-without-implementation",
            "risk-without-mitigation",
          ],
          description: "Project Ledger query family.",
        },
      },
      required: ["kind"],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "render_project_dashboard",
    description:
      "Render Project Ledger dashboard, handoff, or roadmap views for a repo-local project.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        project_path: {
          type: "string",
          description: "Absolute project path. Defaults to the Butler repository.",
        },
        view: {
          type: "string",
          enum: ["dashboard", "handoff", "roadmap"],
          description: "Generated view to render.",
        },
        write: {
          type: "boolean",
          description: "When true, write the generated view under .project-ledger/views.",
        },
      },
      required: ["view"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "complete_project_work",
    description:
      "Complete a Project Ledger work item through the same evidence gate used by the CLI.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        project_path: {
          type: "string",
          description: "Absolute project path. Defaults to the Butler repository.",
        },
        id: { type: "string", description: "Work id to complete." },
        validation: { type: "string", description: "Validation evidence summary or path." },
        review: { type: "string", description: "Review evidence summary or path." },
        report: { type: "string", description: "Completion report path." },
      },
      required: ["id", "validation", "review", "report"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "get_context_monitor",
    description:
      "Inspect safe context pressure telemetry for the active session: prompt sizes, recall size, transcript growth, and estimated token pressure without raw prompt text.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        session_id: {
          type: "string",
          description: "Optional session id. Defaults to the active Butler session when available.",
        },
      },
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "read_tool_output_artifact",
    description:
      "Read a bounded stdout/stderr slice from a Butler-owned tool-output artifact by artifact id or artifact path. Use this when a compact tool preview is insufficient.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        artifact_id: {
          type: "string",
          description: "Artifact id from a compacted tool-output preview.",
        },
        path: {
          type: "string",
          description: "Absolute artifact path under Butler's tool-output artifact root.",
        },
        stream: {
          type: "string",
          enum: ["stdout", "stderr", "both"],
          description: "Which stream to read. Defaults to both.",
        },
        offset_lines: {
          type: "integer",
          description: "Zero-based starting line. Defaults to 0.",
        },
        limit_lines: {
          type: "integer",
          description: "Maximum lines to return. Defaults to 80.",
        },
        max_tokens: {
          type: "integer",
          description: "Maximum estimated tokens to return. Defaults to 1200.",
        },
      },
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "get_usage_monitor",
    description:
      "Inspect safe model/cache, web-search, and tool usage counters without raw prompts, messages, tool arguments, or tool results.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        session_id: {
          type: "string",
          description: "Optional session id for transcript-derived tool usage.",
        },
        since_hours: {
          type: "number",
          description: "Optional lookback window in hours for timestamped metrics.",
        },
      },
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "list_tool_capabilities",
    description:
      "List Butler's available and disabled native tools with categories, safety notes, and disabled reasons.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        category: { type: "string", description: "Optional category filter." },
        include_disabled: { type: "boolean", description: "Whether to include disabled tools. Defaults to true." },
      },
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "list_mcp_capabilities",
    description:
      "List configured MCP servers and their available tools, resources, and resource templates. Use before calling an external MCP tool or reading an MCP resource.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        include_disabled: {
          type: "boolean",
          description: "Include disabled MCP servers in the listing.",
        },
      },
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "call_mcp_tool",
    description:
      "Call a tool exposed by a configured, enabled MCP server. Use list_mcp_capabilities first when the server id or tool schema is not already known.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        server_id: {
          type: "string",
          description: "Configured MCP server id.",
        },
        tool_name: {
          type: "string",
          description: "MCP tool name on that server.",
        },
        arguments: {
          type: "object",
          description: "Tool arguments matching the server-provided MCP schema.",
          additionalProperties: true,
        },
      },
      required: ["server_id", "tool_name"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "read_mcp_resource",
    description:
      "Read a resource URI exposed by a configured, enabled MCP server. Use list_mcp_capabilities first when the resource URI is not already known.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        server_id: {
          type: "string",
          description: "Configured MCP server id.",
        },
        uri: {
          type: "string",
          description: "Resource URI to read.",
        },
      },
      required: ["server_id", "uri"],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "create_automation",
    description:
      "Create a native Butler automation: a one-shot or interval scheduled prompt routed back into a Butler session.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Optional safe automation id." },
        title: { type: "string", description: "Short user-facing title." },
        prompt: { type: "string", description: "Prompt to run when the automation fires." },
        session_id: { type: "string", description: "Target session id. Defaults to active session." },
        schedule_type: { type: "string", enum: ["once", "interval"] },
        run_at: { type: "string", description: "ISO timestamp for one-shot automations." },
        interval_minutes: { type: "number", description: "Interval in minutes for recurring automations." },
        start_at: { type: "string", description: "Optional ISO start timestamp for interval automations." },
      },
      required: ["prompt", "schedule_type"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "list_automations",
    description:
      "List native Butler automations with prompt previews, schedule, next run, and run counts.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        include_deleted: { type: "boolean" },
      },
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "delete_automation",
    description: "Mark a native Butler automation as deleted.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Automation id." },
      },
      required: ["id"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "run_due_automations",
    description:
      "Claim due native Butler automations and return transport-neutral inbound events for gateway processing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        now: { type: "string", description: "Optional ISO timestamp for deterministic runs." },
      },
      required: [],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "update_todo_list",
    description:
      "Create or replace Butler's durable checklist for the current non-trivial multi-step work. Use proactively for complex work; keep at most one item in_progress.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        list_id: {
          type: "string",
          description: "Safe list id. Defaults to main.",
        },
        title: {
          type: "string",
          description: "Optional user-facing checklist title.",
        },
        todos: {
          type: "array",
          description: "Full current ordered todo list.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
                description: "Optional stable safe id. Butler assigns one when omitted.",
              },
              content: {
                type: "string",
                description: "Imperative form, e.g. Run validation.",
              },
              active_form: {
                type: "string",
                description: "Present continuous form, e.g. Running validation.",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "cancelled"],
              },
              phase: {
                type: "string",
                enum: ["conception", "planning", "execution", "review", "consolidation", "reporting"],
                description: "Optional Butler Turn Cognition Cycle phase for this step.",
              },
              priority: {
                type: "string",
                enum: ["low", "normal", "high"],
              },
              blocked_by: {
                type: "array",
                items: { type: "string" },
              },
              note: {
                type: "string",
              },
            },
            required: ["content", "active_form", "status"],
          },
        },
      },
      required: ["todos"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "list_todo_list",
    description:
      "Read Butler's durable checklist for the current work, including progress counts and the current in-progress item.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        list_id: {
          type: "string",
          description: "Safe list id. Defaults to main.",
        },
        include_completed: {
          type: "boolean",
          description: "When true, include completed and cancelled items.",
        },
      },
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "list_work_streams",
    description:
      "List Butler-owned durable WorkStreams for the active session or project. Use to preserve context switching across multiple async issues.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        session_id: {
          type: "string",
          description: "Optional session id. Defaults to the active session.",
        },
        project_id: {
          type: "string",
          description: "Optional project id filter.",
        },
        include_terminal: {
          type: "boolean",
          description: "When true, include complete and failed streams.",
        },
      },
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "update_work_stream_state",
    description:
      "Advance or pause the active Butler-owned WorkStream through the issue-level state machine. Use for waiting_user, paused, recoverable, and explicit review/reporting transitions.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        work_stream_id: {
          type: "string",
          description: "Optional work stream id. Defaults to the active stream for this session.",
        },
        state: {
          type: "string",
          enum: [
            "routing",
            "conception",
            "planning",
            "executing",
            "reviewing",
            "consolidating",
            "reporting",
            "waiting_user",
            "paused",
            "complete",
            "failed",
            "recoverable",
          ],
        },
        active_step_id: {
          type: "string",
          description: "Optional active step id when the state points to a known todo step.",
        },
        status_note: {
          type: "string",
          description: "Short public-safe status note. Do not include hidden reasoning or raw private text.",
        },
      },
      required: ["state"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "control_work",
    description:
      "Validate or perform a transport-neutral work control action: view a result, validate resume/cancel intent, or retry failed delivery.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["view_result", "resume", "retry_delivery", "cancel"],
          description: "Control action to validate or execute.",
        },
        task_id: {
          type: "string",
          description: "Task id for view_result, resume, or cancel.",
        },
        notification_id: {
          type: "string",
          description: "Delivery notification id for retry_delivery.",
        },
      },
      required: ["action"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "get_memory_health",
    description:
      "Read Butler memory freshness, ingestion backlog, transcript count, task-memory count, and diagnostics.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "ingest_task_memory",
    description:
      "Ingest a completed task outcome or reviewed public report into durable task memory with provenance.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: { type: "string", description: "Completed or failed task id to ingest." },
      },
      required: ["task_id"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "recall_memory",
    description:
      "Recall relevant local Butler memory for prior task outcomes, hot-cache context, explicit rules, and associative context. Use results[].text as the primary safe memory evidence; items are ranking diagnostics. Treat results as candidate memory evidence, not exact chronological database truth.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        cue: { type: "string", description: "Memory recall cue text." },
        limit: { type: "integer", description: "Maximum number of memory recall results." },
      },
      required: ["cue"],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "query_memory",
    description:
      "Query durable Butler conversation transcripts for exact memory/history evidence such as dates, counts, first/last, earliest/latest, speaker-specific, or text-filtered transcript facts. Use when exact transcript evidence is needed. Returns conversational inbound/outbound text only, never tool payloads.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Optional exact text or terms to match in conversational transcript text. Omit to inspect all matching conversation events.",
        },
        scope: {
          type: "string",
          enum: ["all_sessions", "session"],
          description: "Search all durable Butler sessions, or only the active/requested session.",
        },
        session_id: {
          type: "string",
          description: "Session id to search when scope is session. Defaults to the current session when available.",
        },
        speaker: {
          type: "string",
          enum: ["any", "user", "butler"],
          description: "Filter to user inbound messages, Butler outbound messages, or both.",
        },
        event_kind: {
          type: "string",
          enum: ["any", "inbound", "outbound"],
          description: "Filter by transcript event kind.",
        },
        order: {
          type: "string",
          enum: ["earliest", "latest"],
          description: "Return chronological earliest or latest matching conversation events first.",
        },
        match_mode: {
          type: "string",
          enum: ["any", "all", "phrase"],
          description: "How query terms should match transcript text.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of exact transcript matches to return.",
        },
        date_from: {
          type: "string",
          description: "Optional inclusive lower timestamp/date bound parseable by Date.parse.",
        },
        date_to: {
          type: "string",
          description: "Optional inclusive upper timestamp/date bound parseable by Date.parse.",
        },
        include_internal: {
          type: "boolean",
          description: "Include internal steward/session events. Defaults to false for user-facing memory queries.",
        },
        include_placeholders: {
          type: "boolean",
          description: "Include mock or epoch placeholder transcript events. Defaults to false.",
        },
      },
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "summarize_user_profile",
    description:
      "Return Butler's reflective understanding of the principal from the consent-gated profile black box. Use when the user asks how Butler understands them. Does not expose raw profile internals.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        locale: {
          type: "string",
          enum: ["en", "ko"],
          description: "Language for the reflective summary.",
        },
      },
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "update_onboarding_profile",
    description:
      "Persist explicit answers from Butler's first-chat onboarding, including naming preferences, interests, work/main field, Butler nickname, desired treatment style, selected persona, and profile-learning consent. Use only for confirmed onboarding answers.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        principal_name: {
          type: "string",
          description: "The principal's name, if explicitly provided.",
        },
        preferred_address: {
          type: "string",
          description: "How Butler should address the principal.",
        },
        butler_nickname: {
          type: "string",
          description: "The name the principal wants Butler to use.",
        },
        interests: {
          type: "string",
          description: "Explicitly shared likes or interests.",
        },
        work: {
          type: "string",
          description: "Explicitly shared job, profession, or main field.",
        },
        service_preference: {
          type: "string",
          description: "How the principal wants Butler to behave or treat them.",
        },
        persona_preset: {
          type: "string",
          description:
            "Selected persona preset name exactly as listed in the first-chat onboarding context, or custom when the user wrote their own.",
        },
        persona_custom: {
          type: "string",
          description: "Custom persona/treatment text when persona_preset is custom.",
        },
        profiling_mode: {
          type: "string",
          enum: ["off", "basic", "deep"],
          description: "Consent-gated profile learning mode from first-chat onboarding. Set off when the principal declines or does not explicitly accept profile learning; set basic/deep only after explicit acceptance.",
        },
        skipped_fields: {
          type: "array",
          items: { type: "string" },
          description: "Onboarding field ids the principal chose to skip.",
        },
        complete: {
          type: "boolean",
          description: "Set true only when onboarding is finished or the principal asks to stop onboarding.",
        },
        locale: {
          type: "string",
          enum: ["en", "ko"],
          description: "Language of the onboarding interaction.",
        },
      },
      required: [],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "read_conversation_context",
    description:
      "Read bounded local conversation transcript slices for the active session. Use this to resolve references such as above, earlier, first, that one, or Korean equivalents when compact prompt context is insufficient.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Optional transcript search terms.",
        },
        anchor_event_id: {
          type: "string",
          description: "Optional transcript event id to read around.",
        },
        direction: {
          type: "string",
          enum: ["before", "after", "around"],
          description: "Slice direction relative to query hits or anchor event.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of conversational events to return.",
        },
        max_chars: {
          type: "integer",
          description: "Maximum character budget for returned conversation text.",
        },
      },
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "update_explicit_memory",
    description:
      "Write an explicit durable rule memory with provenance. Use only for user corrections, explicit preferences, or durable instructions.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["rule"], description: "Memory destination." },
        text: { type: "string", description: "Explicit memory text." },
        source: { type: "string", description: "Provenance summary, e.g. user correction message id." },
      },
      required: ["kind", "text", "source"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "list_skills",
    description:
      "List Butler's machine-readable strategy skills, applicability notes, allowed tools, dispatch preference, review requirement, and validation issues.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "dispatch_worker",
    description:
      "Start a background Butler worker for work that should leave the current chat turn and report later. Use this only when the user asks for background, async, worker, or delegated execution, or when the task is too long, risky, or review-heavy for turn-local tools.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        task: {
          type: "string",
          description: "Concrete worker task description and success criteria.",
        },
        project_path: {
          type: "string",
          description: "Absolute project path. Defaults to the Butler repository.",
        },
      },
      required: ["task"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "create_planned_task",
    description:
      "Create a durable autonomous plan for complex work before any worker starts. Use this for coding, research, migrations, risky work, or tasks that need acceptance criteria and review.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal: {
          type: "string",
          description: "User-facing objective for the planned work.",
        },
        internal_goal: {
          type: "string",
          description:
            "Internal BTCC GOAL to keep cycling against until review proves it complete. Defaults to goal.",
        },
        project_path: {
          type: "string",
          description: "Absolute project path. Defaults to the Butler repository.",
        },
        acceptance_criteria: {
          type: "array",
          description: "Specific criteria the review cycle must verify before public reporting.",
          items: { type: "string" },
        },
        verification_commands: {
          type: "array",
          description: "Commands or checks expected to verify the planned work.",
          items: { type: "string" },
        },
        risk_notes: {
          type: "array",
          description: "Known risks, constraints, or boundaries for autonomous execution.",
          items: { type: "string" },
        },
        repair_policy: {
          type: "object",
          description: "Autonomous repair policy for failed review cycles.",
          additionalProperties: false,
          properties: {
            max_attempts: {
              type: "integer",
              description: "Maximum autonomous repair attempts after the first worker attempt.",
            },
            allow_autonomous_repair: {
              type: "boolean",
              description: "Whether Butler may repair within the original objective without asking.",
            },
          },
          required: [],
        },
        public_report_policy: {
          type: "string",
          description: "How the final user-facing report should be shaped.",
        },
      },
      required: ["goal", "acceptance_criteria"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "run_planned_task",
    description:
      "Start the worker attempt for an existing durable planned task. Use this only after create_planned_task has produced a plan.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: {
          type: "string",
          description: "Planned task id returned by create_planned_task.",
        },
      },
      required: ["task_id"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "review_planned_task",
    description:
      "Review a completed planned worker attempt against every acceptance criterion before any public completion report is generated.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: {
          type: "string",
          description: "Planned task id to review.",
        },
        attempt: {
          type: "integer",
          description: "Planned attempt number to review.",
        },
        worker_task_id: {
          type: "string",
          description: "Linked worker task id from the planned-review event.",
        },
        review_event_id: {
          type: "string",
          description: "Planned-review event id used to reject stale review turns.",
        },
        criteria: {
          type: "array",
          description: "Per-criterion review results with evidence.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              criterion_index: {
                type: "integer",
                description:
                  "Preferred stable 1-based acceptance-criterion index, for example 1 for AC1.",
              },
              criterion: { type: "string" },
              verdict: { type: "string", enum: ["PASS", "FAIL", "INCONCLUSIVE"] },
              evidence: { type: "string" },
            },
            required: ["verdict", "evidence"],
          },
        },
        goal_review: {
          type: "object",
          description:
            "Internal GOAL completion review. PASS is required before a planned task can become reportable.",
          additionalProperties: false,
          properties: {
            verdict: { type: "string", enum: ["PASS", "FAIL", "INCONCLUSIVE"] },
            evidence: {
              type: "string",
              description: "Evidence that the internal GOAL is complete, blocked, or still incomplete.",
            },
          },
          required: ["verdict", "evidence"],
        },
        missing_evidence: {
          type: "array",
          description: "Evidence that is missing or insufficient.",
          items: { type: "string" },
        },
        repair_recommendation: {
          type: "string",
          description: "Recommended autonomous repair, or empty when no repair is needed.",
        },
      },
      required: ["task_id", "criteria"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "repair_planned_task",
    description:
      "Start an autonomous repair worker for a failed or inconclusive planned task review when the repair policy allows it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: {
          type: "string",
          description: "Planned task id to repair.",
        },
        repair_objective: {
          type: "string",
          description: "Specific repair objective. Defaults to the latest review recommendation.",
        },
        attempt: {
          type: "integer",
          description: "Review event attempt number when called from a hidden planned-review turn.",
        },
        worker_task_id: {
          type: "string",
          description: "Linked worker task id from the planned-review event.",
        },
        review_event_id: {
          type: "string",
          description: "Planned-review event id used to reject stale repair turns.",
        },
      },
      required: ["task_id"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "request_principal_decision",
    description:
      "Pause a planned task only for a critical decision that belongs to the principal, with Butler's recommendation and concrete options.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: { type: "string", description: "Planned task id to pause." },
        situation: { type: "string", description: "Critical decision situation." },
        recommended_option_id: { type: "string", description: "Butler's recommended option id." },
        options: {
          type: "array",
          description: "Concrete options the principal can choose.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              description: { type: "string" },
            },
            required: ["id", "label", "description"],
          },
        },
        tradeoffs: {
          type: "array",
          description: "Important tradeoffs behind the options.",
          items: { type: "string" },
        },
        expires_at: {
          type: "string",
          description: "Optional ISO timestamp for decision expiry.",
        },
      },
      required: ["task_id", "situation", "recommended_option_id", "options"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "write_planned_public_report",
    description:
      "Write the final user-facing report for a reviewed planned task. Use only after review passes or a failure/partial report is ready. The report must answer the user's requested deliverable, not summarize Butler's internal review.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: { type: "string", description: "Planned task id to report." },
        report: {
          type: "string",
          description:
            "Complete user-facing final answer, shaped by the planned task public_report_policy. Do not include review verdicts, PASS/FAIL criterion evidence, internal ids, raw worker prompts, or full worker/review artifacts unless explicitly requested by the user.",
        },
        outcome: { type: "string", description: "Legacy concise final outcome; prefer report." },
        what_was_done: { type: "array", items: { type: "string" }, description: "Legacy fallback bullets; prefer report." },
        residual_risk: { type: "array", items: { type: "string" }, description: "Legacy fallback risks; prefer report." },
        next_action: { type: "string", description: "Legacy fallback next action; prefer report." },
      },
      required: ["task_id", "report"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "resume_worker",
    description:
      "Resume a recoverable Butler worker that was interrupted by a restart, crash, or dead process. Use this when the user says to continue, resume, pick up the worker, or asks about a RUNNING/RECOVERABLE worker that did not finish normally.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: {
          type: "string",
          description: "Recoverable task id. If omitted, Butler resumes the most recent RECOVERABLE task.",
        },
      },
      required: [],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "create_work_orchestration",
    description:
      "Create a durable role-aware orchestration with dependency-aware work streams for complex multi-worker tasks.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Optional safe orchestration id." },
        title: { type: "string", description: "Short user-facing title." },
        goal: { type: "string", description: "Overall orchestration goal." },
        streams: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              role: { type: "string" },
              objective: { type: "string" },
              acceptance_criteria: { type: "array", items: { type: "string" } },
              depends_on: { type: "array", items: { type: "string" } },
            },
            required: ["role", "objective", "acceptance_criteria"],
          },
        },
      },
      required: ["goal", "streams"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "run_ready_work_streams",
    description:
      "Dispatch dependency-ready pending streams for a work orchestration and record worker task ids before returning.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        orchestration_id: { type: "string" },
        max_streams: { type: "number" },
      },
      required: ["orchestration_id"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "sync_work_orchestration",
    description:
      "Sync a work orchestration from durable worker task state, promoting linked streams to done or failed from evidence.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        orchestration_id: { type: "string" },
      },
      required: ["orchestration_id"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "write_work_orchestration_report",
    description:
      "Write a public orchestration report after every work stream is terminal. Completion can be claimed only when every non-skipped stream is done.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        orchestration_id: { type: "string" },
        report: { type: "string" },
      },
      required: ["orchestration_id", "report"],
    },
    concurrencySafe: false,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "list_tasks",
    description: "List recent Butler worker tasks and their statuses.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          description: "Maximum number of recent tasks to return.",
        },
      },
      required: [],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
  {
    type: "function",
    name: "get_task_result",
    description:
      "Read a Butler worker task status, result.md content, and observed worker log summary when result.md is absent or incomplete.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: {
          type: "string",
          description: "Task id from dispatch_worker or list_tasks.",
        },
      },
      required: ["task_id"],
    },
    concurrencySafe: true,
    interruptBehavior: "continue",
    transcriptVisibility: "visible",
  },
];

export function butlerToolsForAgentLoop(): AgentLoopToolDefinition[] {
  return BUTLER_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as AgentLoopToolDefinition["inputSchema"],
    concurrencySafe: tool.concurrencySafe,
  }));
}

function createTaskId(): string {
  return `${Math.floor(Date.now() / 1000)}${process.pid}${Math.floor(Math.random() * 10_000)}`;
}

function createDecisionId(): string {
  return randomUUID();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function runWebSearchWithOptionalPlanning(input: {
  butlerData: string;
  provider: WebSearchProvider;
  searchInput: Required<Pick<WebSearchInput, "query">> & WebSearchInput;
  turnContext?: string;
  originalRequest?: string;
  plannerModel?: string;
  planner?: (input: SmartSearchPlanningInput) => Promise<SmartSearchPlanningResult>;
}): Promise<WebSearchOutput & {
  search_plan?: Record<string, unknown>;
}> {
  const planResult = await (input.planner ?? createSmartSearchPlan)({
    butlerData: input.butlerData,
    query: input.searchInput.query,
    originalRequest:
      input.originalRequest?.trim() ||
      boundedSearchPlannerOriginalRequest(input.turnContext),
    allowedDomains: input.searchInput.allowed_domains,
    blockedDomains: input.searchInput.blocked_domains,
    recencyDays: input.searchInput.recency_days,
    maxResults: input.searchInput.max_results,
    model: input.plannerModel,
  });

  if (!planResult.plan) {
    const direct = await input.provider.search(input.searchInput);
    return {
      ...direct,
      search_plan: {
        mode: "direct",
        planner_used: planResult.usedPlanner,
        planner_attempts: planResult.attempts,
        fallback_reason: planResult.fallbackReason ?? null,
        original_query: input.searchInput.query,
      },
    };
  }

  const output = await executePlannedWebSearch({
    provider: input.provider,
    searchInput: input.searchInput,
    plan: planResult.plan,
  });
  return {
    ...output,
    search_plan: compactSearchPlan(planResult.plan, planResult.attempts),
  };
}

function boundedSearchPlannerOriginalRequest(value: string | undefined): string | undefined {
  const compact = boundedPlannedSourceContext(value);
  if (!compact) return undefined;
  const maxChars = 3_000;
  if (compact.length <= maxChars) return compact;
  const marker = "\n[...current turn context trimmed for search planner...]\n";
  const headChars = Math.floor((maxChars - marker.length) * 0.7);
  const tailChars = maxChars - marker.length - headChars;
  return [
    compact.slice(0, headChars).trimEnd(),
    marker.trim(),
    compact.slice(Math.max(0, compact.length - tailChars)).trimStart(),
  ].filter(Boolean).join("\n");
}

async function executePlannedWebSearch(input: {
  provider: WebSearchProvider;
  searchInput: Required<Pick<WebSearchInput, "query">> & WebSearchInput;
  plan: SearchPlan;
}): Promise<WebSearchOutput> {
  const start = Date.now();
  const finalLimit = Math.max(
    1,
    Math.min(10, Math.trunc(input.searchInput.max_results ?? 10)),
  );
  const perQueryLimit = Math.max(2, Math.min(5, finalLimit));
  const plannedInputs = input.plan.queries.map((query) => ({
    ...input.searchInput,
    query: query.query,
    max_results: perQueryLimit,
  }));
  const outputs = await Promise.all(
    plannedInputs.map((plannedInput) => input.provider.search(plannedInput)),
  );

  const results = interleaveSearchResults(outputs, finalLimit);
  const providers = Array.from(new Set(outputs.map((output) => output.provider)));
  return {
    query: input.searchInput.query,
    results,
    duration_ms: Math.max(0, Date.now() - start),
    provider: providers.length === 1 ? providers[0]! : providers.join("+"),
    usage: {
      search_requests: outputs.reduce(
        (sum, output) => sum + (output.usage?.search_requests ?? 1),
        0,
      ),
    },
  };
}

function interleaveSearchResults(
  outputs: WebSearchOutput[],
  finalLimit: number,
): WebSearchOutput["results"] {
  const seenUrls = new Set<string>();
  const results: WebSearchOutput["results"] = [];
  const maxRows = Math.max(0, ...outputs.map((output) => output.results.length));
  for (let row = 0; row < maxRows && results.length < finalLimit; row += 1) {
    for (const output of outputs) {
      const result = output.results[row];
      if (!result) continue;
      const key = result.url.trim();
      if (!key || seenUrls.has(key)) continue;
      seenUrls.add(key);
      results.push(result);
      if (results.length >= finalLimit) break;
    }
  }
  return results;
}

function compactSearchPlan(
  plan: SearchPlan,
  attempts: number,
): Record<string, unknown> {
  return {
    mode: plan.mode,
    depth: plan.depth,
    intent: plan.intent,
    scope: plan.scope,
    parallelizable: plan.parallelizable,
    verification_required: plan.verificationRequired,
    planner_attempts: attempts,
    decomposition: plan.decomposition.map((bucket) => ({
      id: bucket.id,
      label: bucket.label,
      priority: bucket.priority,
    })),
    queries: plan.queries.map((query) => ({
      bucket_id: query.bucketId ?? null,
      query: query.query,
      purpose: query.purpose,
      priority: query.priority,
      expected_source_type: query.expectedSourceType ?? null,
    })),
  };
}

function readRequirementForSearchOutput(output: WebSearchOutput & {
  search_plan?: Record<string, unknown>;
}): Record<string, unknown> {
  const plan = output.search_plan;
  const depth = typeof plan?.depth === "string" ? plan.depth : "";
  const verificationRequired = plan?.verification_required === true;
  const readRequired = verificationRequired || depth === "deep" || depth === "verification";
  if (!readRequired) return {};
  return {
    read_required: true,
    read_reason: "The search plan requires page evidence before making confident source-backed claims.",
    recommended_read_urls: output.results
      .map((result) => result.url)
      .filter((url) => typeof url === "string" && url.trim().length > 0)
      .slice(0, 4),
  };
}

function coverageBudgetForSearchOutput(output: WebSearchOutput & {
  search_plan?: Record<string, unknown>;
}, requestedLimit: number): Record<string, unknown> {
  return {
    mode: "coverage_based",
    result_count: output.results.length,
    stop_reason: output.results.length === 0
      ? "no_source_candidates"
      : output.results.length >= requestedLimit
        ? "candidate_limit_reached"
        : "provider_results_exhausted",
    next_search_guidance:
      "Run another search only for a specific missing outcome field, category, source type, or verification gap.",
  };
}

function transformPublicDataTable(input: {
  butlerData: string;
  args: Record<string, unknown>;
}): Record<string, unknown> {
  const columns = stringArray(input.args.columns)
    .map((column) => sanitizePublicText(column, ""))
    .filter(Boolean)
    .slice(0, 12);
  if (columns.length === 0) throw new Error("transform_public_data_table requires at least one column");
  if (!Array.isArray(input.args.rows)) throw new Error("transform_public_data_table requires rows");
  const rows = input.args.rows
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object" && !Array.isArray(row)))
    .slice(0, 50)
    .map((row) => Object.fromEntries(columns.map((column) => [
      column,
      publicDataCell(row[column]),
    ])));
  if (rows.length === 0) throw new Error("transform_public_data_table requires at least one row");
  const title = sanitizePublicText(input.args.title, "public-data-table");
  const artifactId = `public-data-${randomUUID().slice(0, 10)}`;
  const artifactName = `${safeArtifactSlug(title)}-${artifactId}.csv`;
  const artifactDir = join(input.butlerData, "artifacts", "public-data");
  mkdirSync(artifactDir, { recursive: true });
  const csv = [
    columns.map(csvEscape).join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column] ?? "")).join(",")),
  ].join("\n");
  writeFileSync(join(artifactDir, artifactName), `${csv}\n`, "utf8");
  return {
    ok: true,
    durable_artifact_created: true,
    artifact_kind: "csv_file",
    artifact_id: artifactId,
    artifact_label: artifactName,
    artifact_note: "CSV file artifact has been written; use artifact_label as the user-facing file name.",
    title,
    columns,
    row_count: rows.length,
    csv_preview: csv.split("\n").slice(0, 6).join("\n"),
    evidence_receipts: [
      evidenceReceipt({
        producerName: "transform_public_data_table",
        receiptType: "deliverable",
        summary: "A structured public data table artifact was created.",
        covers: ["durable_deliverable", "structured_table"],
        artifacts: [{
          id: artifactId,
          label: artifactName,
          mediaType: "text/csv",
          role: "table",
        }],
        satisfies: ["durable_artifact", "data_table_created"],
        metrics: {
          row_count: rows.length,
          column_count: columns.length,
        },
      }),
    ],
  };
}

function publicDataCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
  const raw = String(value).trim();
  if (/^(?:\/Users\/|\/var\/|\/tmp\/|[A-Za-z]:\\|\\\\)/u.test(raw)) return "[redacted-path]";
  const text = sanitizePublicText(value, "");
  return text;
}

function csvEscape(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replace(/"/gu, "\"\"")}"` : value;
}

function safeArtifactSlug(value: string): string {
  const slug = value
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9가-힣_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return slug || "public-data-table";
}

function scopedTodoListId(rawListId: unknown, turnId?: string): string {
  const listId = typeof rawListId === "string" && rawListId.trim()
    ? rawListId.trim()
    : "main";
  if (listId !== "main" || !turnId?.trim()) return listId;
  const safeTurnId = turnId.trim().replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 70);
  return `${safeTurnId || "turn"}:main`.slice(0, 80);
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 300_000;
const MAX_COMMAND_CAPTURE_CHARS = 5_000_000;
const COMMAND_GENERATED_ARTIFACT_DIR = "generated";
const COMMAND_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "SHELL",
  "BUTLER_BUN",
] as const;

function commandArtifactDataRoot(butlerData: string): string {
  return join(butlerData, "artifacts");
}

function commandGeneratedArtifactRoot(butlerData: string): string {
  return join(commandArtifactDataRoot(butlerData), COMMAND_GENERATED_ARTIFACT_DIR);
}

function boundedInteger(value: unknown, input: {
  fallback: number;
  min: number;
  max: number;
}): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return input.fallback;
  return Math.max(input.min, Math.min(input.max, Math.trunc(value)));
}

function commandWorkingDirectory(input: {
  workspacePath: string;
  cwd?: unknown;
}): string {
  const workspace = resolve(input.workspacePath);
  if (typeof input.cwd !== "string" || !input.cwd.trim()) return workspace;
  const cwd = input.cwd.trim();
  const resolved = isAbsolute(cwd) ? resolve(cwd) : resolve(workspace, cwd);
  if (!isPathInsideWorkspace({ path: resolved, workspace })) {
    throw new Error("run_command cwd must stay under the active session workspace");
  }
  return resolved;
}

function realpathIfExists(path: string): string {
  if (!existsSync(path)) return path;
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function isPathInsideWorkspace(input: {
  path: string;
  workspace: string;
}): boolean {
  const workspace = realpathIfExists(resolve(input.workspace));
  const target = realpathIfExists(resolve(input.path));
  const rel = relative(workspace, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

type CommandArtifactKind = "csv_file" | "table_file" | "chart_file" | "file";

interface CommandArtifactEvidence {
  path: string;
  artifact_kind: CommandArtifactKind;
  size_bytes: number;
  modified_at: string;
}

const COMMAND_ARTIFACT_SCAN_IGNORES = new Set([
  ".git",
  ".project-ledger",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "build",
  "node_modules",
]);

const MAX_COMMAND_ARTIFACT_SCAN_FILES = 20_000;
const MAX_COMMAND_ARTIFACT_EVIDENCE = 24;

function artifactKindForPath(path: string): CommandArtifactKind {
  const ext = extname(path).toLocaleLowerCase("en-US");
  if (ext === ".csv") return "csv_file";
  if (ext === ".tsv") return "table_file";
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg", ".pdf"].includes(ext)) return "chart_file";
  return "file";
}

function safeCommandArtifactLabel(input: {
  path: string;
  cwd: string;
  butlerData: string;
}): string {
  const artifactRoot = resolve(commandArtifactDataRoot(input.butlerData));
  const artifactRelativePath = relative(artifactRoot, input.path);
  if (artifactRelativePath && !artifactRelativePath.startsWith("..") && !isAbsolute(artifactRelativePath)) {
    return join("artifacts", artifactRelativePath);
  }
  const relativePath = relative(input.cwd, input.path);
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) return relativePath;
  return relative(resolve(input.cwd), input.path) || "command-output";
}

function verifiedCommandArtifact(input: {
  path: string;
  cwd: string;
  workspace: string;
  butlerData: string;
}): CommandArtifactEvidence | null {
  const resolved = resolve(input.cwd, input.path);
  const artifactRoot = commandArtifactDataRoot(input.butlerData);
  const isAllowedWorkspaceFile = isPathInsideWorkspace({ path: resolved, workspace: input.workspace });
  const isAllowedDataArtifact = isPathInsideWorkspace({ path: resolved, workspace: artifactRoot });
  if (!isAllowedWorkspaceFile && !isAllowedDataArtifact) return null;
  if (!existsSync(resolved)) return null;
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return {
    path: safeCommandArtifactLabel({
      path: resolved,
      cwd: input.cwd,
      butlerData: input.butlerData,
    }),
    artifact_kind: artifactKindForPath(resolved),
    size_bytes: stat.size,
    modified_at: new Date(stat.mtimeMs).toISOString(),
  };
}

function expandCommandArtifactEnvPath(path: string, butlerData: string): string {
  const replacements: Array<[string, string]> = [
    ["${BUTLER_ARTIFACTS_DIR}", commandGeneratedArtifactRoot(butlerData)],
    ["$BUTLER_ARTIFACTS_DIR", commandGeneratedArtifactRoot(butlerData)],
    ["${BUTLER_ARTIFACT_DIR}", commandGeneratedArtifactRoot(butlerData)],
    ["$BUTLER_ARTIFACT_DIR", commandGeneratedArtifactRoot(butlerData)],
    ["${BUTLER_DATA}", butlerData],
    ["$BUTLER_DATA", butlerData],
  ];
  for (const [token, value] of replacements) {
    if (path === token) return value;
    if (path.startsWith(`${token}/`)) return join(value, path.slice(token.length + 1));
  }
  return path;
}

function commandArtifactPathCandidates(path: string, cwd: string, butlerData: string): string[] {
  const expanded = expandCommandArtifactEnvPath(path.trim(), butlerData);
  if (!expanded) return [];
  if (isAbsolute(expanded)) return [resolve(expanded)];
  return Array.from(new Set([
    resolve(cwd, expanded),
    resolve(butlerData, expanded),
    resolve(commandGeneratedArtifactRoot(butlerData), expanded),
  ]));
}

function declaredCommandArtifacts(
  args: Record<string, unknown>,
  cwd: string,
  workspace: string,
  butlerData: string,
): CommandArtifactEvidence[] {
  return stringArray(args.output_paths)
    .slice(0, MAX_COMMAND_ARTIFACT_EVIDENCE)
    .map((path) => {
      for (const candidate of commandArtifactPathCandidates(path, cwd, butlerData)) {
        const artifact = verifiedCommandArtifact({
          path: candidate,
          cwd,
          workspace,
          butlerData,
        });
        if (artifact) return artifact;
      }
      return null;
    })
    .filter((artifact): artifact is CommandArtifactEvidence => Boolean(artifact));
}

function recentCommandArtifacts(input: {
  cwd: string;
  workspace: string;
  butlerData: string;
  startedAtMs: number;
}): CommandArtifactEvidence[] {
  const artifacts: CommandArtifactEvidence[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  const visit = (dir: string, depth: number) => {
    if (artifacts.length >= MAX_COMMAND_ARTIFACT_EVIDENCE || scanned >= MAX_COMMAND_ARTIFACT_SCAN_FILES || depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (artifacts.length >= MAX_COMMAND_ARTIFACT_EVIDENCE || scanned >= MAX_COMMAND_ARTIFACT_SCAN_FILES) return;
      if (COMMAND_ARTIFACT_SCAN_IGNORES.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      if (seen.has(fullPath)) continue;
      seen.add(fullPath);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.mtimeMs + 1_000 < input.startedAtMs) continue;
      const artifact = verifiedCommandArtifact({
        path: fullPath,
        cwd: input.cwd,
        workspace: input.workspace,
        butlerData: input.butlerData,
      });
      if (artifact) artifacts.push(artifact);
    }
  };
  visit(input.cwd, 0);
  visit(commandGeneratedArtifactRoot(input.butlerData), 0);
  return artifacts;
}

function commandArtifactEvidenceFields(artifacts: CommandArtifactEvidence[]): Record<string, unknown> {
  if (artifacts.length === 0) return {};
  const labels = Array.from(new Set(artifacts.map((artifact) => artifact.path)));
  const kinds = Array.from(new Set(artifacts.map((artifact) => artifact.artifact_kind)));
  const dataTableCreated = artifacts.some((artifact) =>
    artifact.artifact_kind === "csv_file" || artifact.artifact_kind === "table_file");
  const chartRendered = artifacts.some((artifact) => artifact.artifact_kind === "chart_file");
  return {
    durable_artifact_created: true,
    verified_output_files: artifacts,
    written_files: labels,
    written_file: labels[0],
    artifact_labels: labels,
    artifact_label: labels[0],
    artifact_kinds: kinds,
    artifact_kind: kinds[0],
    ...(dataTableCreated ? { data_table_created: true } : {}),
    ...(chartRendered ? { chart_rendered: true } : {}),
  };
}

function commandArtifactMediaType(artifact: CommandArtifactEvidence): string {
  const ext = extname(artifact.path).toLocaleLowerCase("en-US");
  if (artifact.artifact_kind === "csv_file") return "text/csv";
  if (artifact.artifact_kind === "table_file") return "text/tab-separated-values";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function commandArtifactRole(artifact: CommandArtifactEvidence): string {
  if (artifact.artifact_kind === "csv_file" || artifact.artifact_kind === "table_file") return "table";
  if (artifact.artifact_kind === "chart_file") return "chart";
  return "file";
}

function commandEvidenceReceipts(input: {
  success: boolean;
  artifacts: CommandArtifactEvidence[];
}): EvidenceReceipt[] {
  const receipts: EvidenceReceipt[] = [
    evidenceReceipt({
      producerName: "run_command",
      receiptType: "execution",
      summary: input.success
        ? "A local command executed successfully."
        : "A local command was executed but did not complete successfully.",
      covers: ["execution_result"],
      verified: input.success,
      satisfies: input.success ? ["command_executed"] : [],
    }),
  ];
  if (input.artifacts.length > 0) {
    const satisfies = new Set<PublicWorkObligationKind>(["durable_artifact"]);
    if (input.artifacts.some((artifact) =>
      artifact.artifact_kind === "csv_file" || artifact.artifact_kind === "table_file",
    )) {
      satisfies.add("data_table_created");
    }
    if (input.artifacts.some((artifact) => artifact.artifact_kind === "chart_file")) {
      satisfies.add("chart_rendered");
    }
    receipts.push(evidenceReceipt({
      producerName: "run_command",
      receiptType: "deliverable",
      summary: "The command produced verified durable output file evidence.",
      covers: ["durable_deliverable"],
      artifacts: input.artifacts.map((artifact) => ({
        label: artifact.path,
        path: artifact.path,
        mediaType: commandArtifactMediaType(artifact),
        role: commandArtifactRole(artifact),
      })),
      satisfies: [...satisfies],
      metrics: {
        artifact_count: input.artifacts.length,
      },
    }));
  }
  return receipts;
}

function commandEnvironment(input: {
  butlerData?: string;
} = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of COMMAND_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (input.butlerData) {
    const artifactRoot = commandGeneratedArtifactRoot(input.butlerData);
    env.BUTLER_DATA = input.butlerData;
    env.BUTLER_ARTIFACTS_DIR = artifactRoot;
    env.BUTLER_ARTIFACT_DIR = artifactRoot;
  }
  return env;
}

function appendCapturedText(current: string, chunk: Buffer | string): {
  text: string;
  truncated: boolean;
} {
  if (current.length >= MAX_COMMAND_CAPTURE_CHARS) return { text: current, truncated: true };
  const next = current + chunk.toString();
  if (next.length <= MAX_COMMAND_CAPTURE_CHARS) return { text: next, truncated: false };
  return {
    text: next.slice(0, MAX_COMMAND_CAPTURE_CHARS),
    truncated: true,
  };
}

async function executeBashCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  butlerData: string;
}): Promise<ShellCommandResult> {
  return await new Promise((resolveCommand, reject) => {
    const child = spawn("/bin/bash", ["-lc", input.command], {
      cwd: input.cwd,
      env: commandEnvironment({ butlerData: input.butlerData }),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 500).unref?.();
    }, input.timeoutMs);

    child.stdout.on("data", (chunk) => {
      const next = appendCapturedText(stdout, chunk);
      stdout = next.text;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const next = appendCapturedText(stderr, chunk);
      stderr = next.text;
      stderrTruncated ||= next.truncated;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const truncationNotes = [
        stdoutTruncated ? `[stdout truncated after ${MAX_COMMAND_CAPTURE_CHARS} chars]` : "",
        stderrTruncated ? `[stderr truncated after ${MAX_COMMAND_CAPTURE_CHARS} chars]` : "",
      ].filter(Boolean);
      resolveCommand({
        stdout: stdoutTruncated ? `${stdout}\n${truncationNotes[0] ?? ""}` : stdout,
        stderr: stderrTruncated ? `${stderr}\n${truncationNotes.at(-1) ?? ""}` : stderr,
        exit_code: timedOut ? null : code,
        timed_out: timedOut,
      });
    });
  });
}

function isValidationCommand(command: string): boolean {
  const trimmed = command
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/u, "");
  const validationPatterns = [
    /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+check(?::run|:verbose)?\b/,
    /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+test:unit(?::run)?\b/,
    /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+test\b/,
    /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+ops\/scripts\/validate\.ts\s+(?:check:run|test:unit:run)\b/,
    /^bun\s+test\b/,
    /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+lint\b/,
    /^(?:bun|\$\{BUTLER_BUN:-bun\})(?:\s+--silent)?\s+run(?:\s+--silent)?\s+typecheck\b/,
    /^npm\s+--prefix\s+\S+\s+run(?:\s+--silent)?\s+(?:lint|typecheck|test)\b/,
    /^(?:project-ledger|packages\/project-ledger\/bin\/project-ledger|resources\/skills\/project-ledger\/bin\/project-ledger)\s+check\b/,
    /^git\s+diff\b.*\s--check\b/,
  ];
  return validationPatterns.some((pattern) => pattern.test(trimmed));
}

function sliceLastCharacters(value: string, maxChars: number): string {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return chars.slice(-maxChars).join("");
}

function boundOutputOnFailure(output: string, maxLines: number = 20, maxChars: number = 1000): string {
  if (!output) return output;
  const lines = output.split("\n");
  if (lines.length <= maxLines && Array.from(output).length <= maxChars) return output;

  const lastLines = lines.slice(-maxLines);
  let result = lastLines.join("\n");

  if (Array.from(result).length > maxChars) {
    result = sliceLastCharacters(result, maxChars);
    const newlineIndex = result.indexOf("\n");
    if (newlineIndex > 0) {
      result = result.slice(newlineIndex + 1);
    }
  }

  return `...[output truncated]\n${result}`;
}

async function runCommandTool(input: {
  butlerData: string;
  workspacePath: string;
  args: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const command = typeof input.args.command === "string" ? input.args.command.trim() : "";
  if (!command) throw new Error("run_command requires command");
  const cwd = commandWorkingDirectory({
    workspacePath: input.workspacePath,
    cwd: input.args.cwd,
  });
  const timeoutMs = boundedInteger(input.args.timeout_ms, {
    fallback: DEFAULT_COMMAND_TIMEOUT_MS,
    min: 1_000,
    max: MAX_COMMAND_TIMEOUT_MS,
  });
  const maxModelTokens = boundedInteger(input.args.max_output_tokens, {
    fallback: 1_200,
    min: 200,
    max: 8_000,
  });
  const outputMode = typeof input.args.output_mode === "string" &&
    ["auto", "silent_on_success", "full"].includes(input.args.output_mode)
    ? input.args.output_mode
    : "auto";

  const commandStartedAtMs = Date.now();
  mkdirSync(commandGeneratedArtifactRoot(input.butlerData), { recursive: true });
  const raw = await executeBashCommand({
    command,
    cwd,
    timeoutMs,
    butlerData: input.butlerData,
  });

  const success = raw.exit_code === 0 && raw.timed_out === false;
  const shouldSuppressOutput = success && (
    outputMode === "silent_on_success" ||
    (outputMode === "auto" && isValidationCommand(command))
  );

  let processedResult = raw;
  if (shouldSuppressOutput) {
    processedResult = {
      stdout: "",
      stderr: "",
      exit_code: raw.exit_code,
      timed_out: raw.timed_out,
    };
  } else if (!success && (outputMode === "silent_on_success" || outputMode === "auto")) {
    processedResult = {
      stdout: boundOutputOnFailure(raw.stdout),
      stderr: boundOutputOnFailure(raw.stderr),
      exit_code: raw.exit_code,
      timed_out: raw.timed_out,
    };
  }

  const budgeted = budgetToolOutput({
    result: processedResult,
    butlerData: input.butlerData,
    command,
    cwd,
    maxModelTokens,
  });
  const workspace = resolve(input.workspacePath);
  const declaredArtifacts = declaredCommandArtifacts(input.args, cwd, workspace, input.butlerData);
  const discoveredArtifacts = declaredArtifacts.length > 0
    ? []
    : recentCommandArtifacts({
      cwd,
      workspace,
      butlerData: input.butlerData,
      startedAtMs: commandStartedAtMs,
    });
  const artifactEvidence = commandArtifactEvidenceFields([
    ...declaredArtifacts,
    ...discoveredArtifacts,
  ]);
  const artifacts = [
    ...declaredArtifacts,
    ...discoveredArtifacts,
  ];
  return {
    ok: budgeted.exit_code === 0 && budgeted.timed_out === false,
    command,
    cwd,
    exit_code: budgeted.exit_code,
    timed_out: budgeted.timed_out,
    stdout: budgeted.stdout,
    stderr: budgeted.stderr,
    ...(budgeted.butler_tool_artifact
      ? { butler_tool_artifact: budgeted.butler_tool_artifact }
      : {}),
    ...artifactEvidence,
    evidence_receipts: commandEvidenceReceipts({
      success: budgeted.exit_code === 0 && budgeted.timed_out === false,
      artifacts,
    }),
  };
}

function pageReaderBackend(value: unknown): PageReaderBackendId | undefined {
  if (
    value === "auto" ||
    value === "lightpanda" ||
    value === "lightweight" ||
    value === "jina-hosted" ||
    value === "disabled"
  ) {
    return value;
  }
  return undefined;
}

function boundedText(value: string, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, Math.max(0, maxChars - 16)).trimEnd()}\n...[truncated]`,
    truncated: true,
  };
}

function boundedPageReadToolResult(result: PageReadResult, options: {
  maxChars: number;
  maxChunks: number;
  chunkTextChars: number;
}): Record<string, unknown> {
  const markdown = boundedText(result.markdown || result.text || "", options.maxChars);
  const chunkTextChars = Math.max(120, Math.min(1_500, Math.trunc(options.chunkTextChars)));
  return {
    ok: result.ok,
    reader: result.reader,
    requested_url: result.requestedUrl,
    final_url: result.finalUrl,
    source_url: result.finalUrl,
    status: result.status,
    title: result.title,
    method: result.method,
    warnings: result.warnings,
    render_recommended: result.renderRecommended,
    duration_ms: result.durationMs,
    markdown: markdown.text,
    truncated: markdown.truncated || result.chunks.length > options.maxChunks,
    chunks: result.chunks.slice(0, options.maxChunks).map((chunk) => ({
      id: chunk.id,
      index: chunk.index,
      title: chunk.title,
      url: chunk.url,
      text: boundedText(chunk.text, Math.min(chunkTextChars, options.maxChars)).text,
      char_count: chunk.charCount,
    })),
    evidence_quality: result.ok && result.text.length >= 500 && result.warnings.length === 0
      ? "good"
      : result.ok && result.text.length > 0
        ? "limited"
        : "unavailable",
    error: result.error,
  };
}

function reviewVerdict(value: unknown): PlannedReviewVerdict {
  return value === "PASS" || value === "FAIL" || value === "INCONCLUSIVE"
    ? value
    : "INCONCLUSIVE";
}

function criterionReviews(value: unknown): PlannedCriterionReview[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      criterion_index:
        typeof item.criterion_index === "number" &&
        Number.isInteger(item.criterion_index) &&
        item.criterion_index > 0
          ? item.criterion_index
          : undefined,
      criterion: typeof item.criterion === "string" ? item.criterion.trim() : "",
      verdict: reviewVerdict(item.verdict),
      evidence: typeof item.evidence === "string" ? item.evidence.trim() : "",
    }))
    .filter((item) => (item.criterion || item.criterion_index) && item.evidence);
}

function canonicalPlannedCriterionReviews(
  record: NonNullable<ReturnType<PlannedTaskStore["read"]>>,
  reviews: PlannedCriterionReview[],
): PlannedCriterionReview[] {
  return reviews.map((review) => {
    const index = review.criterion_index;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 1 ||
      index > record.plan.acceptance_criteria.length
    ) {
      return review;
    }
    return {
      ...review,
      criterion: record.plan.acceptance_criteria[index - 1]?.trim() || review.criterion,
    };
  });
}

function plannedGoalReview(
  value: unknown,
  record: NonNullable<ReturnType<PlannedTaskStore["read"]>>,
  criteriaVerdict: PlannedReviewVerdict,
): {
  review: PlannedGoalReview;
  supplied: boolean;
} {
  const goal = plannedInternalGoal(record.plan);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const evidence = typeof input.evidence === "string" ? input.evidence.trim() : "";
    if (evidence) {
      return {
        supplied: true,
        review: {
          goal,
          verdict: reviewVerdict(input.verdict),
          evidence,
        },
      };
    }
  }
  return {
    supplied: false,
    review: {
      goal,
      verdict: criteriaVerdict === "FAIL" ? "FAIL" : "INCONCLUSIVE",
      evidence: criteriaVerdict === "FAIL"
        ? "Acceptance-criterion review failed before the internal GOAL could pass."
        : "Internal GOAL review evidence was not supplied.",
    },
  };
}

function decisionOptions(value: unknown): PlannedDecisionOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      id: typeof item.id === "string" ? item.id.trim() : "",
      label: typeof item.label === "string" ? item.label.trim() : "",
      description: typeof item.description === "string" ? item.description.trim() : "",
    }))
    .filter((option) => option.id && option.label && option.description);
}

function todoStatus(value: unknown): TodoStatus {
  if (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new Error("todo status must be pending, in_progress, completed, or cancelled");
}

function todoPriority(value: unknown): TodoPriority | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "low" || value === "normal" || value === "high") return value;
  throw new Error("todo priority must be low, normal, or high");
}

function todoPhase(value: unknown): TodoPhase | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    value === "conception" ||
    value === "planning" ||
    value === "execution" ||
    value === "review" ||
    value === "consolidation" ||
    value === "reporting"
  ) {
    return value;
  }
  throw new Error("todo phase must be conception, planning, execution, review, consolidation, or reporting");
}

function todoInputs(value: unknown): TodoItemInput[] {
  if (!Array.isArray(value)) throw new Error("update_todo_list requires todos");
  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("todo item must be an object");
    }
    const input = item as Record<string, unknown>;
    return {
      id: typeof input.id === "string" ? input.id : undefined,
      content: typeof input.content === "string" ? input.content : "",
      active_form: typeof input.active_form === "string" ? input.active_form : "",
      status: todoStatus(input.status),
      phase: todoPhase(input.phase),
      priority: todoPriority(input.priority),
      blocked_by: stringArray(input.blocked_by),
      note: typeof input.note === "string" ? input.note : undefined,
    };
  });
}

function workStreamState(value: unknown): WorkStreamState {
  if (
    value === "routing" ||
    value === "conception" ||
    value === "planning" ||
    value === "executing" ||
    value === "reviewing" ||
    value === "consolidating" ||
    value === "reporting" ||
    value === "waiting_user" ||
    value === "paused" ||
    value === "complete" ||
    value === "failed" ||
    value === "recoverable"
  ) {
    return value;
  }
  throw new Error("work stream state is invalid");
}

function workStreamInputs(value: unknown): WorkStreamInput[] {
  if (!Array.isArray(value)) throw new Error("create_work_orchestration requires streams");
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : undefined,
      role: typeof item.role === "string" ? item.role : "",
      objective: typeof item.objective === "string" ? item.objective : "",
      acceptance_criteria: stringArray(item.acceptance_criteria),
      depends_on: stringArray(item.depends_on),
    }));
}

function automationSchedule(args: Record<string, unknown>): AutomationSchedule {
  const scheduleType = typeof args.schedule_type === "string" ? args.schedule_type.trim() : "";
  if (scheduleType === "once") {
    if (typeof args.run_at !== "string" || !args.run_at.trim()) {
      throw new Error("create_automation once schedule requires run_at");
    }
    return {
      type: "once",
      run_at: args.run_at.trim(),
    };
  }
  if (scheduleType === "interval") {
    if (typeof args.interval_minutes !== "number") {
      throw new Error("create_automation interval schedule requires interval_minutes");
    }
    return {
      type: "interval",
      interval_minutes: args.interval_minutes,
      start_at: typeof args.start_at === "string" && args.start_at.trim()
        ? args.start_at.trim()
        : undefined,
    };
  }
  throw new Error("create_automation requires schedule_type once or interval");
}

function automationNow(value: unknown): Date {
  if (typeof value !== "string" || !value.trim()) return new Date();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("run_due_automations now must be a valid ISO date");
  return date;
}

function toolCategory(value: unknown): ToolCapabilityCategory | undefined {
  if (
    value === "search" ||
    value === "data" ||
    value === "command" ||
    value === "work" ||
    value === "monitoring" ||
    value === "automation" ||
    value === "todo" ||
    value === "memory" ||
    value === "project" ||
    value === "skill" ||
    value === "mcp" ||
    value === "dispatch" ||
    value === "control"
  ) return value;
  return undefined;
}

function capabilityAvailability(tool: ButlerToolDefinition, input: {
  butlerData: string;
  webSearchProvider?: WebSearchProvider;
}): { enabled: boolean; disabled_reason: string | null } {
  if (tool.name !== "web_search") return { enabled: true, disabled_reason: null };
  const provider = createConfiguredWebSearchProvider({
    butlerData: input.butlerData,
    provider: input.webSearchProvider,
  });
  if (provider.id === "disabled") {
    return {
      enabled: false,
      disabled_reason: "web search provider is disabled by configuration",
    };
  }
  return { enabled: true, disabled_reason: null };
}

function listToolCapabilities(input: {
  butlerData: string;
  webSearchProvider?: WebSearchProvider;
  category?: ToolCapabilityCategory;
  includeDisabled?: boolean;
}): ToolCapabilityView[] {
  const includeDisabled = input.includeDisabled !== false;
  return BUTLER_TOOLS
    .map((tool) => {
      const metadata = TOOL_CAPABILITY_METADATA[tool.name] ?? DEFAULT_TOOL_CAPABILITY;
      const availability = capabilityAvailability(tool, input);
      return {
        name: tool.name,
        description: tool.description,
        category: metadata.category,
        enabled: availability.enabled,
        disabled_reason: availability.disabled_reason,
        concurrency_safe: tool.concurrencySafe,
        interrupt_behavior: tool.interruptBehavior,
        transcript_visibility: tool.transcriptVisibility,
        tags: metadata.tags,
        safety_notes: metadata.safetyNotes,
      };
    })
    .filter((capability) => !input.category || capability.category === input.category)
    .filter((capability) => includeDisabled || capability.enabled)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

export function satisfiedCompletionObligationsForToolResult(
  toolName: string,
  result: unknown,
): PublicWorkObligationKind[] {
  if (!toolResultSucceeded(result)) return [];
  const receiptSatisfied = satisfiedCompletionObligationsFromEvidenceReceipts(
    evidenceReceiptsFromResult(result),
  );
  if (receiptSatisfied.length > 0) return receiptSatisfied;
  const metadata = TOOL_CAPABILITY_METADATA[toolName] ?? DEFAULT_TOOL_CAPABILITY;
  return [...new Set(metadata.satisfiesCompletionObligations ?? [])];
}

function toolResultSucceeded(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return true;
  const record = result as Record<string, unknown>;
  if (record.ok === false) return false;
  if (record.timed_out === true) return false;
  if (typeof record.exit_code === "number" && record.exit_code !== 0) return false;
  return true;
}

function optionalToolString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function onboardingPersonaPreset(value: unknown): FirstChatOnboardingPersonaPreset | "custom" | undefined {
  if (value === "custom") return "custom";
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function onboardingProfilingMode(value: unknown): ProfilingMode | undefined {
  return value === "off" || value === "basic" || value === "deep" ? value : undefined;
}

function decisionReplyMarkup(decision: PlannedDecisionRequest): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: decision.options.map((option) => {
      const callbackData = `pd:${decision.decision_id}:${option.id}`;
      if (new TextEncoder().encode(callbackData).length > 64) {
        throw new Error(`principal decision callback_data exceeds 64 bytes for option ${option.id}`);
      }
      return [{
        text: option.id === decision.recommended_option_id ? `Recommended: ${option.label}` : option.label,
        callback_data: callbackData,
      }];
    }),
  };
}

function publicReportText(input: {
  record: NonNullable<ReturnType<PlannedTaskStore["read"]>>;
  report: string;
  outcome: string;
  whatWasDone: string[];
  residualRisk: string[];
  nextAction: string;
}): string {
  const report = cleanPublicReport(input.report);
  if (report) return report;
  const lines = [
    input.outcome,
    "",
    "## What Was Done",
    ...input.whatWasDone.map((item) => `- ${item}`),
    "",
    "## Residual Risk",
    ...(input.residualRisk.length > 0 ? input.residualRisk.map((item) => `- ${item}`) : ["- None identified."]),
  ];
  if (input.nextAction) {
    lines.push("", "## Next Action", input.nextAction);
  }
  return lines.join("\n");
}

function cleanPublicReport(value: string): string {
  const text = Array.from(value.trim(), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 && character !== "\n" && character !== "\t" ? " " : character;
  }).join("");
  return text.replace(/\n{4,}/gu, "\n\n\n").trim();
}

function overallReviewVerdict(criteria: PlannedCriterionReview[]): PlannedReviewVerdict {
  if (criteria.some((criterion) => criterion.verdict === "FAIL")) return "FAIL";
  if (criteria.length === 0 || criteria.some((criterion) => criterion.verdict === "INCONCLUSIVE")) {
    return "INCONCLUSIVE";
  }
  return "PASS";
}

function combinedPlannedReviewVerdict(verdicts: PlannedReviewVerdict[]): PlannedReviewVerdict {
  if (verdicts.some((verdict) => verdict === "FAIL")) return "FAIL";
  if (verdicts.some((verdict) => verdict === "INCONCLUSIVE")) return "INCONCLUSIVE";
  return "PASS";
}

function repairPolicy(value: unknown): PlannedTaskPlan["repair_policy"] {
  if (!value || typeof value !== "object") {
    return { max_attempts: 2, allow_autonomous_repair: true };
  }
  const input = value as Record<string, unknown>;
  const maxAttempts = typeof input.max_attempts === "number" && Number.isFinite(input.max_attempts)
    ? Math.max(0, Math.trunc(input.max_attempts))
    : 2;
  const allowAutonomousRepair = typeof input.allow_autonomous_repair === "boolean"
    ? input.allow_autonomous_repair
    : true;
  return {
    max_attempts: maxAttempts,
    allow_autonomous_repair: allowAutonomousRepair,
  };
}

function publicPlanSummary(plan: PlannedTaskPlan): {
  goal: string;
  project: string;
  acceptance_criteria_count: number;
  verification_commands: string[];
  autonomous_repair: boolean;
  max_repair_attempts: number;
  report_policy: string;
} {
  return {
    goal: plan.goal,
    project: plan.project,
    acceptance_criteria_count: plan.acceptance_criteria.length,
    verification_commands: plan.verification_commands,
    autonomous_repair: plan.repair_policy.allow_autonomous_repair,
    max_repair_attempts: plan.repair_policy.max_attempts,
    report_policy: plan.public_report_policy,
  };
}

function boundedPlannedSourceContext(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const compact = compactPlannedSourceContext(text);
  const maxChars = 8_000;
  if (compact.length <= maxChars) return compact;
  const marker = "\n[...original turn context trimmed for planned worker...]\n";
  const headChars = Math.floor((maxChars - marker.length) * 0.65);
  const tailChars = maxChars - marker.length - headChars;
  return [
    compact.slice(0, headChars).trimEnd(),
    marker.trim(),
    compact.slice(Math.max(0, compact.length - tailChars)).trimStart(),
  ].filter(Boolean).join("\n");
}

function compactPlannedSourceContext(text: string): string {
  const keepTitles = new Set([
    "Runtime State",
    "Current Attachment References",
    "Current User Input",
  ]);
  const chunks: string[] = [];
  const hashMatch = text.match(/^Live Configuration Hash: [^\n]+/u);
  if (hashMatch) chunks.push(hashMatch[0]);

  const sectionPattern = /^## ([^\n]+)\n([\s\S]*?)(?=\n---\n\n## |\n## [^\n]+\n|$)/gmu;
  for (const match of text.matchAll(sectionPattern)) {
    const title = match[1]?.trim() ?? "";
    const body = match[2]?.trim() ?? "";
    if (!keepTitles.has(title) || !body) continue;
    chunks.push(`## ${title}\n${body}`);
  }

  return chunks.length > 0 ? chunks.join("\n\n---\n\n") : text;
}

function plannedSourceContextLines(plan: PlannedTaskPlan): string[] {
  const sourceContext = plan.source_context?.trim();
  if (!sourceContext) return [];
  return [
    "",
    "Original Turn Source Context:",
    "Use this bounded context for user-provided files, recent attachments, and immediate conversation references that may not exist in the project workspace.",
    sourceContext,
  ];
}

function plannedWorkerPrompt(plan: PlannedTaskPlan, attempt: number): string {
  return [
    `Execute planned Butler task ${plan.task_id}, attempt ${attempt}.`,
    "",
    `GOAL: ${plannedInternalGoal(plan)}`,
    `User-facing objective: ${plan.goal}`,
    `Project: ${plan.project}`,
    ...plannedSourceContextLines(plan),
    "",
    "Acceptance Criteria:",
    ...plan.acceptance_criteria.map((criterion, index) => `- AC${index + 1}: ${criterion}`),
    "",
    "Verification Commands:",
    ...(plan.verification_commands.length > 0
      ? plan.verification_commands.map((command) => `- ${command}`)
      : ["- Evidence review only; no command is required by this plan."]),
    "",
    "Risk Notes:",
    ...((plan.risk_notes ?? []).length > 0
      ? (plan.risk_notes ?? []).map((note) => `- ${note}`)
      : ["- Stay within the original objective and avoid unrelated changes."]),
    "",
    "Instructions:",
    "- Complete the planned work autonomously within the GOAL and risk boundary.",
    "- Produce evidence for every acceptance criterion.",
    "- Do not report completion unless the GOAL is satisfied or safely failed with evidence.",
    "- Do not ask the principal for routine implementation choices.",
    "- If you hit a critical decision, report the tradeoff clearly instead of guessing.",
  ].join("\n");
}

function plannedRepairPrompt(input: {
  plan: PlannedTaskPlan;
  attempt: number;
  latestResult: string | null;
  review: NonNullable<ReturnType<PlannedTaskStore["read"]>>["review"];
  repairObjective: string;
}): string {
  return [
    `Repair planned Butler task ${input.plan.task_id}, attempt ${input.attempt}.`,
    "",
    `GOAL: ${plannedInternalGoal(input.plan)}`,
    `User-facing objective: ${input.plan.goal}`,
    `Project: ${input.plan.project}`,
    ...plannedSourceContextLines(input.plan),
    "",
    "Repair Objective:",
    input.repairObjective,
    "",
    "Acceptance Criteria:",
    ...input.plan.acceptance_criteria.map((criterion, index) => `- AC${index + 1}: ${criterion}`),
    "",
    "Latest Review:",
    ...(input.review?.criteria.map((criterion) =>
      `- ${criterion.verdict}: ${criterion.criterion}\n  Evidence: ${criterion.evidence}`,
    ) ?? ["- No review details were recorded."]),
    "",
    "Missing Evidence:",
    ...((input.review?.missing_evidence ?? []).length > 0
      ? input.review!.missing_evidence.map((item) => `- ${item}`)
      : ["- None recorded."]),
    "",
    "Repair Recommendation:",
    input.review?.repair_recommendation ?? "Repair the failed or inconclusive criteria.",
    "",
    "Prior Result:",
    input.latestResult ?? "No prior result was recorded.",
    "",
    "Instructions:",
    "- Stay within the original GOAL and risk envelope.",
    "- Fix only the failed or inconclusive criteria unless a dependency is required.",
    "- Produce evidence that the internal GOAL is now complete or safely blocked.",
    "- Produce evidence for every acceptance criterion so the next review can pass.",
  ].join("\n");
}

function repairAttemptsUsed(record: NonNullable<ReturnType<PlannedTaskStore["read"]>>): number {
  return Math.max(0, record.attempts.length - 1);
}

function latestPlannedAttemptNumber(record: NonNullable<ReturnType<PlannedTaskStore["read"]>>): number {
  const latest = Number.parseInt(record.attempts.at(-1) ?? "0", 10);
  return Number.isFinite(latest) ? latest : 0;
}

function plannedAttemptWorkerTaskId(
  record: NonNullable<ReturnType<PlannedTaskStore["read"]>>,
  attempt: number,
): string {
  try {
    return readFileSync(
      join(record.taskDir, "attempts", String(attempt).padStart(3, "0"), "worker-task-id"),
      "utf8",
    ).trim();
  } catch {
    return "";
  }
}

function plannedReviewOwnershipMismatch(input: {
  record: NonNullable<ReturnType<PlannedTaskStore["read"]>>;
  attempt: number;
  workerTaskId?: string;
}): string | null {
  const latestAttempt = latestPlannedAttemptNumber(input.record);
  if (latestAttempt > 0 && input.attempt !== latestAttempt) {
    return `review event targets attempt ${input.attempt}, but latest attempt is ${latestAttempt}`;
  }
  const expectedWorkerTaskId = plannedAttemptWorkerTaskId(input.record, input.attempt);
  if (input.workerTaskId && expectedWorkerTaskId && input.workerTaskId !== expectedWorkerTaskId) {
    return "review event worker task does not match the current planned attempt";
  }
  return null;
}

function stalePlannedReviewResult(input: {
  taskId: string;
  attempt: number;
  status: string;
  reason: string;
  reviewEventId?: string;
}): Record<string, unknown> {
  return {
    ok: false,
    task_id: input.taskId,
    attempt: input.attempt,
    status: input.status,
    classification: "STALE_REVIEW_EVENT",
    review_event_id: input.reviewEventId || null,
    message: "This review event is stale and did not change planned task state.",
    reason: input.reason,
  };
}

function writeRepairFailureReport(input: {
  store: PlannedTaskStore;
  taskId: string;
  reason: string;
  record: NonNullable<ReturnType<PlannedTaskStore["read"]>>;
}): ReturnType<PlannedTaskStore["read"]> {
  const reasonText = input.reason === "repair_cap_exhausted"
    ? "The available autonomous repair attempts have already been used."
    : input.reason === "autonomous_repair_disabled"
      ? "Autonomous repair is disabled for this planned task."
      : "The planned task cannot safely continue without a new decision.";
  const latestReview = input.record.review
    ? `${input.record.review.verdict}: ${input.record.review.repair_recommendation ?? "No specific repair recommendation was recorded."}`
    : "No review was recorded.";
  const lines = [
    "Planned work status report",
    "",
    "What was requested",
    input.record.plan.goal,
    "",
    "What was completed",
    input.record.latestResult
      ? "A worker attempt produced durable result evidence and Butler reviewed it against the plan."
      : "Butler created the plan, but there is not enough durable worker evidence to claim completion.",
    "",
    "Problem found",
    latestReview,
    "",
    "Why Butler is not claiming completion",
    reasonText,
    "",
    "Recommended next action",
    "Review the summarized gap and decide whether to continue with a fresh instruction, adjust the plan, or stop here.",
  ];
  input.store.transition(input.taskId, "FAILED_PUBLIC_REPORT_READY");
  input.store.writePublicReport(input.taskId, lines.join("\n"));
  return input.store.read(input.taskId);
}

function dispatchBackgroundTask(input: {
  butlerHome: string;
  butlerData: string;
  task: string;
  projectPath: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): { task_id: string; status: "RUNNING"; message: string } {
  const taskId = createTaskId();
  mkdirSync(join(input.butlerData, "tasks"), { recursive: true });
  const dispatchScript = butlerAgentScriptPath(input.butlerHome, "dispatch.sh");
  if (!existsSync(dispatchScript)) {
    throw new Error(`worker dispatch script not found: ${dispatchScript}`);
  }
  const args = [dispatchScript, input.task, input.projectPath];
  const model = input.model?.trim();
  if (model) args.push(model);

  const child = spawn(
    "/bin/bash",
    args,
    {
      cwd: input.butlerHome,
      detached: true,
      stdio: "ignore",
      env: {
        ...commandEnvironment(),
        BUTLER_HOME: input.butlerHome,
        BUTLER_DATA: input.butlerData,
        TASK_ID_OVERRIDE: taskId,
        ...(input.reasoningEffort ? { BUTLER_OPENAI_REASONING_EFFORT: input.reasoningEffort } : {}),
      },
    },
  );
  child.unref();
  return {
    task_id: taskId,
    status: "RUNNING",
    message: "Worker started in the background. The result monitor will report completion.",
  };
}

function recoverableResumePrompt(task: NonNullable<ReturnType<TaskStore["read"]>>): string {
  const parts = [
    `Resume interrupted worker task ${task.taskId}.`,
    "",
    "This worker did not finish normally. Continue from the last reliable state instead of starting over blindly.",
    "First inspect the project and prior task artifacts if needed, then complete the original request.",
    "",
    "Original request:",
    task.request || "(missing)",
  ];
  if (task.origin?.task_summary) {
    parts.push("", "Original task summary:", task.origin.task_summary);
  }
  if (task.observedResult) {
    parts.push("", "Previous observed result or partial result:", task.observedResult.slice(0, 4_000));
  }
  if (task.logTail) {
    parts.push("", "Previous worker log tail:", task.logTail.slice(-4_000));
  }
  parts.push("", `Previous task directory: ${task.taskDir}`);
  return parts.join("\n");
}

type WorkerModelRulePreference = "deep" | "routine";

interface WorkerModelSelectionRule {
  id?: string;
  label?: string;
  condition?: string;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  enabled?: boolean;
}

function selectWorkerModel(
  input: {
    workerModel?: string;
    workerModelRules?: WorkerModelSelectionRule[];
  },
  preference: WorkerModelRulePreference,
): { model?: string; reasoningEffort?: ReasoningEffort } {
  const rules = (input.workerModelRules ?? [])
    .filter((rule) => rule.enabled !== false && typeof rule.model === "string" && rule.model.trim());
  const preferredRule = rules.find((rule) => workerRuleMatchesPreference(rule, preference)) ?? rules[0];
  if (preferredRule?.model) {
    return {
      model: preferredRule.model.trim(),
      reasoningEffort: preferredRule.reasoning_effort,
    };
  }
  return { model: input.workerModel };
}

function workerRuleMatchesPreference(
  rule: WorkerModelSelectionRule,
  preference: WorkerModelRulePreference,
): boolean {
  const marker = `${rule.id ?? ""} ${rule.label ?? ""}`.toLocaleLowerCase("en-US");
  if (preference === "deep") return /\bdeep(?:[_ -]?work)?\b/u.test(marker);
  return /\broutine(?:[_ -]?work)?\b/u.test(marker);
}

export function createButlerToolExecutor(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath?: string;
  workspacePath?: string;
  sessionId?: string;
  projectId?: string;
  turnId?: string;
  turnContext?: string;
  searchPlannerOriginalRequest?: string;
  workerModel?: string;
  workerModelRules?: WorkerModelSelectionRule[];
  searchPlannerModel?: string;
  dispatchTask?: typeof dispatchBackgroundTask;
  webSearchProvider?: WebSearchProvider;
  searchPlanner?: (input: SmartSearchPlanningInput) => Promise<SmartSearchPlanningResult>;
  pageReader?: typeof readPageConfigured;
}): ButlerToolExecutor {
  const taskStore = new TaskStore(input.butlerData);
  const plannedTaskStore = new PlannedTaskStore(input.butlerData);
  const todoListStore = new TodoListStore(input.butlerData);
  const workStreamStore = new WorkStreamStore(input.butlerData);
  const automationStore = new AutomationStore(input.butlerData);
  const orchestrationStore = new WorkOrchestrationStore(input.butlerData);
  const dispatchTask = input.dispatchTask ?? dispatchBackgroundTask;
  let smartSearchPlanningConsumed = false;
  const pageReadCache = new Map<string, PageReadResult>();
  return async (call) => {
    if (call.name === "get_work_dashboard") {
      return {
        ok: true,
        ...createWorkDashboard({
          butlerData: input.butlerData,
          debug: call.args.debug === true,
          limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
        }),
      };
    }

    if (call.name === "inspect_project_status") {
      return runProjectLedgerTool(input, [
        "status",
        "--project",
        projectLedgerProjectPath(input, call.args),
      ]);
    }

    if (call.name === "query_project_work") {
      const kind = typeof call.args.kind === "string" ? call.args.kind.trim() : "";
      if (!kind) throw new Error("query_project_work requires kind");
      return runProjectLedgerTool(input, [
        "query",
        "--project",
        projectLedgerProjectPath(input, call.args),
        "--kind",
        kind,
      ]);
    }

    if (call.name === "render_project_dashboard") {
      const view = typeof call.args.view === "string" ? call.args.view.trim() : "";
      if (!view) throw new Error("render_project_dashboard requires view");
      const projectPath = projectLedgerProjectPath(input, call.args);
      const args = [
        "render",
        "--project",
        projectPath,
        view,
      ];
      if (call.args.write === true) args.push("--write");
      const result = runProjectLedgerTool(input, args);
      return {
        ...result,
        ...projectLedgerRenderedViewEvidence({
          projectPath,
          result,
          view,
          write: call.args.write === true,
        }),
      };
    }

    if (call.name === "complete_project_work") {
      const id = typeof call.args.id === "string" ? call.args.id.trim() : "";
      const validation = typeof call.args.validation === "string" ? call.args.validation.trim() : "";
      const review = typeof call.args.review === "string" ? call.args.review.trim() : "";
      const report = typeof call.args.report === "string" ? call.args.report.trim() : "";
      if (!id) throw new Error("complete_project_work requires id");
      if (!validation || !review || !report) {
        throw new Error("complete_project_work requires validation review and report");
      }
      return runProjectLedgerTool(input, [
        "work",
        "complete",
        "--project",
        projectLedgerProjectPath(input, call.args),
        "--id",
        id,
        "--validation",
        validation,
        "--review",
        review,
        "--report",
        report,
      ]);
    }

    if (call.name === "get_context_monitor") {
      return {
        ok: true,
        ...readContextMonitor({
          butlerData: input.butlerData,
          sessionId: typeof call.args.session_id === "string" && call.args.session_id.trim()
            ? call.args.session_id.trim()
            : input.sessionId,
        }),
      };
    }

    if (call.name === "read_tool_output_artifact") {
      return readToolOutputArtifactSlice({
        butlerData: input.butlerData,
        artifactId: typeof call.args.artifact_id === "string" && call.args.artifact_id.trim()
          ? call.args.artifact_id.trim()
          : undefined,
        path: typeof call.args.path === "string" && call.args.path.trim()
          ? call.args.path.trim()
          : undefined,
        stream:
          call.args.stream === "stdout" || call.args.stream === "stderr" || call.args.stream === "both"
            ? call.args.stream
            : undefined,
        offsetLines: typeof call.args.offset_lines === "number" ? call.args.offset_lines : undefined,
        limitLines: typeof call.args.limit_lines === "number" ? call.args.limit_lines : undefined,
        maxTokens: typeof call.args.max_tokens === "number" ? call.args.max_tokens : undefined,
      });
    }

    if (call.name === "get_usage_monitor") {
      const sinceHours = typeof call.args.since_hours === "number" && call.args.since_hours > 0
        ? call.args.since_hours
        : null;
      return {
        ok: true,
        ...readUsageMonitor({
          butlerData: input.butlerData,
          sessionId: typeof call.args.session_id === "string" && call.args.session_id.trim()
            ? call.args.session_id.trim()
            : input.sessionId,
          sinceTs: sinceHours === null ? null : Date.now() - sinceHours * 60 * 60 * 1000,
        }),
      };
    }

    if (call.name === "list_tool_capabilities") {
      const category = toolCategory(call.args.category);
      return {
        ok: true,
        capabilities: listToolCapabilities({
          butlerData: input.butlerData,
          webSearchProvider: input.webSearchProvider,
          category,
          includeDisabled: call.args.include_disabled !== false,
        }),
      };
    }

    if (call.name === "list_mcp_capabilities") {
      return {
        ok: true,
        ...await listMcpServerCapabilities({
          butlerData: input.butlerData,
          includeDisabled: call.args.include_disabled === true,
        }),
      };
    }

    if (call.name === "call_mcp_tool") {
      const serverId = typeof call.args.server_id === "string" ? call.args.server_id.trim() : "";
      const toolName = typeof call.args.tool_name === "string" ? call.args.tool_name.trim() : "";
      if (!serverId) throw new Error("call_mcp_tool requires server_id");
      if (!toolName) throw new Error("call_mcp_tool requires tool_name");
      const mcpArguments = call.args.arguments &&
        typeof call.args.arguments === "object" &&
        !Array.isArray(call.args.arguments)
        ? call.args.arguments as Record<string, unknown>
        : {};
      return {
        ok: true,
        ...await callMcpTool({
          butlerData: input.butlerData,
          serverId,
          toolName,
          args: mcpArguments,
        }),
      };
    }

    if (call.name === "read_mcp_resource") {
      const serverId = typeof call.args.server_id === "string" ? call.args.server_id.trim() : "";
      const uri = typeof call.args.uri === "string" ? call.args.uri.trim() : "";
      if (!serverId) throw new Error("read_mcp_resource requires server_id");
      if (!uri) throw new Error("read_mcp_resource requires uri");
      return {
        ok: true,
        ...await readMcpResource({
          butlerData: input.butlerData,
          serverId,
          uri,
        }),
      };
    }

    if (call.name === "create_automation") {
      const prompt = typeof call.args.prompt === "string" ? call.args.prompt : "";
      const sessionId = typeof call.args.session_id === "string" && call.args.session_id.trim()
        ? call.args.session_id.trim()
        : input.sessionId ?? "butler/main";
      return {
        ok: true,
        automation: automationStore.create({
          id: typeof call.args.id === "string" && call.args.id.trim() ? call.args.id.trim() : undefined,
          title: typeof call.args.title === "string" ? call.args.title : undefined,
          prompt,
          sessionId,
          schedule: automationSchedule(call.args),
        }),
      };
    }

    if (call.name === "list_automations") {
      return {
        ok: true,
        automations: automationStore.list({
          includeDeleted: call.args.include_deleted === true,
        }),
      };
    }

    if (call.name === "delete_automation") {
      const id = typeof call.args.id === "string" ? call.args.id.trim() : "";
      if (!id) throw new Error("delete_automation requires id");
      return {
        ok: true,
        automation: automationStore.delete(id),
      };
    }

    if (call.name === "run_due_automations") {
      const runs = automationStore.claimDue(automationNow(call.args.now));
      return {
        ok: true,
        claimed: runs.length,
        runs,
      };
    }

    if (call.name === "update_todo_list") {
      const listId = scopedTodoListId(call.args.list_id, input.turnId);
      const view = todoListStore.update({
        listId,
        title: typeof call.args.title === "string" ? call.args.title : undefined,
        items: todoInputs(call.args.todos),
      });
      const workStream = workStreamStore.updateFromTodoList({
        ownerSessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
        listId,
        title: view.list.title ?? undefined,
        items: view.list.items,
      });
      return {
        ok: true,
        list_id: view.list.list_id,
        title: view.list.title,
        items: view.items,
        progress: view.progress,
        work_stream: workStream,
      };
    }

    if (call.name === "list_todo_list") {
      const listId = scopedTodoListId(call.args.list_id, input.turnId);
      const view = todoListStore.view(
        listId,
        { includeCompleted: call.args.include_completed === true },
      );
      return {
        ok: true,
        list_id: view.list.list_id,
        title: view.list.title,
        updated_at: view.list.updated_at,
        items: view.items,
        progress: view.progress,
      };
    }

    if (call.name === "list_work_streams") {
      const sessionId = typeof call.args.session_id === "string" && call.args.session_id.trim()
        ? call.args.session_id.trim()
        : input.sessionId;
      const projectId = typeof call.args.project_id === "string" && call.args.project_id.trim()
        ? call.args.project_id.trim()
        : undefined;
      return {
        ok: true,
        work_streams: workStreamStore.list({
          sessionId,
          projectId,
          includeTerminal: call.args.include_terminal === true,
        }),
      };
    }

    if (call.name === "update_work_stream_state") {
      const requestedId = typeof call.args.work_stream_id === "string" && call.args.work_stream_id.trim()
        ? call.args.work_stream_id.trim()
        : undefined;
      const active = requestedId ? workStreamStore.read(requestedId) : workStreamStore.activeForSession(input.sessionId);
      if (!active) throw new Error("update_work_stream_state requires an active work stream");
      return {
        ok: true,
        work_stream: workStreamStore.transition({
          id: active.id,
          state: workStreamState(call.args.state),
          activeStepId: typeof call.args.active_step_id === "string" ? call.args.active_step_id : undefined,
          statusNote: typeof call.args.status_note === "string" ? call.args.status_note : undefined,
        }),
      };
    }

    if (call.name === "control_work") {
      const action = typeof call.args.action === "string" ? call.args.action.trim() : "";
      if (
        action !== "view_result" &&
        action !== "resume" &&
        action !== "retry_delivery" &&
        action !== "cancel"
      ) {
        throw new Error("control_work requires a valid action");
      }
      return performWorkControl({
        butlerData: input.butlerData,
        action,
        taskId: typeof call.args.task_id === "string" ? call.args.task_id : undefined,
        notificationId: typeof call.args.notification_id === "string" ? call.args.notification_id : undefined,
      });
    }

    if (call.name === "get_memory_health") {
      return {
        ok: true,
        ...readMemoryHealth({
          butlerData: input.butlerData,
        }),
      };
    }

    if (call.name === "ingest_task_memory") {
      const taskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      if (!taskId) throw new Error("ingest_task_memory requires task_id");
      return ingestTaskOutcomeMemory({
        butlerData: input.butlerData,
        taskId,
      });
    }

    if (call.name === "recall_memory") {
      const cue = typeof call.args.cue === "string" ? call.args.cue.trim() : "";
      if (!cue) throw new Error("recall_memory requires cue");
      return {
        ok: true,
        ...recallMemoryEvidence({
          butlerData: input.butlerData,
          cue,
          limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
        }),
      };
    }

    if (call.name === "query_memory") {
      const scope = call.args.scope === "session" ? "session" : "all_sessions";
      const sessionId = typeof call.args.session_id === "string" && call.args.session_id.trim()
        ? call.args.session_id.trim()
        : input.sessionId;
      return {
        ok: true,
        ...queryMemory({
          butlerData: input.butlerData,
          appMessageDbPath: input.appMessageDbPath,
          query: typeof call.args.query === "string" ? call.args.query : undefined,
          scope,
          sessionId,
          speaker: call.args.speaker === "user" || call.args.speaker === "butler" ? call.args.speaker : "any",
          eventKind: call.args.event_kind === "inbound" || call.args.event_kind === "outbound"
            ? call.args.event_kind
            : "any",
          order: call.args.order === "latest" ? "latest" : "earliest",
          matchMode: call.args.match_mode === "all" || call.args.match_mode === "phrase"
            ? call.args.match_mode
            : "any",
          limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
          dateFrom: typeof call.args.date_from === "string" ? call.args.date_from : undefined,
          dateTo: typeof call.args.date_to === "string" ? call.args.date_to : undefined,
          includeInternal: call.args.include_internal === true,
          includePlaceholders: call.args.include_placeholders === true,
        }),
      };
    }

    if (call.name === "summarize_user_profile") {
      const locale = call.args.locale === "en" ? "en" : "ko";
      return readReflectiveProfileSummary(input.butlerData, locale);
    }

    if (call.name === "update_onboarding_profile") {
      const personaPreset = onboardingPersonaPreset(call.args.persona_preset);
      const profilingMode = onboardingProfilingMode(call.args.profiling_mode);
      return updateFirstChatOnboarding(input.butlerData, {
        principal_name: optionalToolString(call.args.principal_name),
        preferred_address: optionalToolString(call.args.preferred_address),
        butler_nickname: optionalToolString(call.args.butler_nickname),
        interests: optionalToolString(call.args.interests),
        work: optionalToolString(call.args.work),
        service_preference: optionalToolString(call.args.service_preference),
        persona_preset: personaPreset,
        persona_custom: optionalToolString(call.args.persona_custom),
        profiling_mode: profilingMode,
        skipped_fields: Array.isArray(call.args.skipped_fields)
          ? call.args.skipped_fields.filter((item): item is string => typeof item === "string")
          : undefined,
        complete: call.args.complete === true,
        locale: call.args.locale === "en" ? "en" : "ko",
        butlerHome: input.butlerHome,
      });
    }

    if (call.name === "read_conversation_context") {
      const direction = call.args.direction === "before" ||
        call.args.direction === "after" ||
        call.args.direction === "around"
        ? call.args.direction as ConversationContextDirection
        : undefined;
      return readConversationContext({
        sessionId: input.sessionId ?? "butler/main",
        query: typeof call.args.query === "string" ? call.args.query : undefined,
        anchorEventId: typeof call.args.anchor_event_id === "string"
          ? call.args.anchor_event_id
          : undefined,
        direction,
        limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
        maxChars: typeof call.args.max_chars === "number" ? call.args.max_chars : undefined,
      });
    }

    if (call.name === "update_explicit_memory") {
      const kind = typeof call.args.kind === "string" ? call.args.kind.trim() : "";
      if (kind !== "rule") {
        throw new Error("update_explicit_memory requires kind rule");
      }
      const text = typeof call.args.text === "string" ? call.args.text.trim() : "";
      const source = typeof call.args.source === "string" ? call.args.source.trim() : "";
      if (!text) throw new Error("update_explicit_memory requires text");
      if (!source) throw new Error("update_explicit_memory requires source");
      return updateExplicitMemory({
        butlerData: input.butlerData,
        update: {
          kind,
          text,
          source,
        },
      });
    }

    if (call.name === "list_skills") {
      const skills = loadRuntimeSkills({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        projectId: input.projectId,
      });
      return {
        ok: true,
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          applicability: skill.applicability,
          allowed_tools: skill.allowedTools,
          dispatch: skill.dispatchPreference,
          review: skill.reviewRequirement,
          reporting: skill.reporting,
          user_invocable: skill.userInvocable,
        })),
        validation_issues: validateSkillCatalog(skills),
      };
    }

    if (call.name === "web_search") {
      const query = typeof call.args.query === "string" ? call.args.query.trim() : "";
      if (query.length < 2) {
        throw new Error("web_search requires a query with at least 2 characters");
      }
      const allowedDomains = stringArray(call.args.allowed_domains);
      const blockedDomains = stringArray(call.args.blocked_domains);
      if (allowedDomains.length > 0 && blockedDomains.length > 0) {
        throw new Error("web_search cannot use allowed_domains and blocked_domains together");
      }
      const provider = createConfiguredWebSearchProvider({
        butlerData: input.butlerData,
        provider: input.webSearchProvider,
      });
      try {
        const allowSmartPlanning = !smartSearchPlanningConsumed;
        const output = await runWebSearchWithOptionalPlanning({
          butlerData: input.butlerData,
          provider,
          turnContext: input.turnContext,
          originalRequest: input.searchPlannerOriginalRequest,
          plannerModel: input.searchPlannerModel ?? input.workerModel,
          planner: allowSmartPlanning
            ? input.searchPlanner ?? (
              input.webSearchProvider
                ? async () => ({
                  plan: null,
                  usedPlanner: false,
                  attempts: 0,
                  fallbackReason: "test provider bypasses search planning",
                })
                : undefined
            )
            : async () => ({
              plan: null,
              usedPlanner: false,
              attempts: 0,
              fallbackReason: "smart search planning already ran in this turn; direct follow-up search used",
            }),
          searchInput: {
            query,
            allowed_domains: allowedDomains.length > 0 ? allowedDomains : undefined,
            blocked_domains: blockedDomains.length > 0 ? blockedDomains : undefined,
            recency_days: typeof call.args.recency_days === "number" ? Math.max(1, Math.trunc(call.args.recency_days)) : undefined,
            max_results: typeof call.args.max_results === "number" ? Math.max(1, Math.min(10, Math.trunc(call.args.max_results))) : undefined,
          },
        });
        if (output.search_plan?.mode === "smart" || output.search_plan?.planner_used === true) {
          smartSearchPlanningConsumed = true;
        }
        recordWebSearchMetric({
          butlerData: input.butlerData,
          provider: output.provider,
          query,
        });
        return {
          ok: true,
          ...output,
          evidence_receipts: [
            evidenceReceipt({
              producerName: "web_search",
              receiptType: "coverage",
              summary: "Search returned public source candidates for the requested evidence.",
              verified: output.results.length > 0,
              covers: ["source_candidates"],
              references: urlReferences(output.results.map((result) => result.url)),
              metrics: {
                result_count: output.results.length,
                search_requests: output.usage?.search_requests ?? 1,
              },
            }),
          ],
          citation_required: true,
          coverage_budget: coverageBudgetForSearchOutput(
            output,
            typeof call.args.max_results === "number" ? Math.max(1, Math.min(10, Math.trunc(call.args.max_results))) : 10,
          ),
          ...readRequirementForSearchOutput(output),
          source_urls: output.results.map((result) => result.url),
        };
      } catch (error) {
        recordWebSearchMetric({
          butlerData: input.butlerData,
          provider: provider.id,
          query,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    if (call.name === "web_read") {
      const url = typeof call.args.url === "string" ? call.args.url.trim() : "";
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("web_read requires a valid URL");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("web_read only supports http(s) URLs");
      }
      const requestedMaxChunks = call.args.max_chunks;
      const maxChars = typeof call.args.max_chars === "number"
        ? Math.max(500, Math.min(8_000, Math.trunc(call.args.max_chars)))
        : 2_000;
      const maxChunks = typeof requestedMaxChunks === "number"
        ? Math.max(1, Math.min(8, Math.trunc(requestedMaxChunks)))
        : 1;
      const backend = pageReaderBackend(call.args.backend);
      const readPage = input.pageReader ?? readPageConfigured;
      const cacheKey = `${backend}:${parsed.href}`;
      const cached = pageReadCache.get(cacheKey);
      const result = cached ?? await readPage({
        butlerData: input.butlerData,
        url,
        backend,
      });
      if (!cached) pageReadCache.set(cacheKey, result);
      const bounded = boundedPageReadToolResult(result, {
        maxChars,
        maxChunks,
        chunkTextChars: 320,
      });
      const sourceUrl = typeof bounded.source_url === "string" && bounded.source_url.trim()
        ? bounded.source_url.trim()
        : parsed.href;
      return {
        ...bounded,
          evidence_receipts: [
            evidenceReceipt({
              producerName: "web_read",
              receiptType: "source",
              summary: "A public source page was read and bounded page evidence was returned.",
              verified: bounded.ok !== false,
              covers: ["source_verified"],
              references: urlReferences([sourceUrl]),
              satisfies: ["source_verified"],
            }),
        ],
        cache_hit: Boolean(cached),
      };
    }

    if (call.name === "get_weather_with_knowhow") {
      const latitude = typeof call.args.latitude === "number" ? call.args.latitude : Number(call.args.latitude);
      const longitude = typeof call.args.longitude === "number" ? call.args.longitude : Number(call.args.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error("get_weather_with_knowhow requires numeric latitude and longitude");
      }
      return {
        ok: true,
        ...await runWeatherKnowHow({
          butlerData: input.butlerData,
          latitude,
          longitude,
          locationName: typeof call.args.location === "string" ? call.args.location : undefined,
        }),
      };
    }

    if (call.name === "record_weather_source_feedback") {
      const source = weatherSourceFromValue(call.args.source) ??
        latestWeatherSourceFromTranscript(input.butlerData, input.sessionId);
      if (!source) throw new Error("record_weather_source_feedback requires source or a prior weather result");
      const text = typeof call.args.text === "string" ? call.args.text.trim() : "";
      if (!text) throw new Error("record_weather_source_feedback requires text");
      return {
        ok: true,
        entry: recordWeatherFeedback(input.butlerData, {
          sourceId: source,
          text,
        }),
      };
    }

    if (call.name === "run_weather_knowhow_consolidation") {
      return {
        ok: true,
        ...runWeatherConsolidationReview(input.butlerData),
      };
    }

    if (call.name === "transform_public_data_table") {
      return transformPublicDataTable({
        butlerData: input.butlerData,
        args: call.args,
      });
    }

    if (call.name === "run_command") {
      return await runCommandTool({
        butlerData: input.butlerData,
        workspacePath: input.workspacePath ?? input.butlerHome,
        args: call.args,
      });
    }

    if (call.name === "dispatch_worker") {
      const task = typeof call.args.task === "string" ? call.args.task.trim() : "";
      if (!task) {
        throw new Error("dispatch_worker requires a non-empty task");
      }
      const projectPath =
        typeof call.args.project_path === "string" && call.args.project_path.trim()
          ? call.args.project_path.trim()
          : input.butlerHome;
      const workerModel = selectWorkerModel(input, "routine");
      const worker = dispatchTask({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        task,
        projectPath,
        model: workerModel.model,
        reasoningEffort: workerModel.reasoningEffort,
      });
      const linkedStream = workStreamStore.link({
        sessionId: input.sessionId,
        workerTaskIds: [worker.task_id],
      });
      return {
        ok: true,
        ...worker,
        work_stream: linkedStream,
      };
    }

    if (call.name === "create_planned_task") {
      const goal = typeof call.args.goal === "string" ? call.args.goal.trim() : "";
      if (!goal) {
        throw new Error("create_planned_task requires a non-empty goal");
      }
      const internalGoal =
        typeof call.args.internal_goal === "string" && call.args.internal_goal.trim()
          ? call.args.internal_goal.trim()
          : goal;
      const project =
        typeof call.args.project_path === "string" && call.args.project_path.trim()
          ? call.args.project_path.trim()
          : input.butlerHome;
      const plan: PlannedTaskPlan = {
        task_id: createPlannedTaskId(),
        type: "planned",
        goal,
        internal_goal: internalGoal,
        project,
        created_at: new Date().toISOString(),
        origin_session_id: input.sessionId,
        source_context: boundedPlannedSourceContext(input.turnContext),
        decision_policy:
          "Autonomous by default. Pause only for critical decisions with meaningful tradeoffs.",
        acceptance_criteria: stringArray(call.args.acceptance_criteria),
        verification_commands: stringArray(call.args.verification_commands),
        review_policy:
          "Review every acceptance criterion before producing a public completion report.",
        repair_policy: repairPolicy(call.args.repair_policy),
        public_report_policy:
          typeof call.args.public_report_policy === "string" && call.args.public_report_policy.trim()
            ? call.args.public_report_policy.trim()
            : "Report the reviewed outcome, evidence, residual risk, and next useful action concisely.",
        risk_notes: stringArray(call.args.risk_notes),
      };
      const record = plannedTaskStore.create(plan);
      if (input.sessionId) {
        taskStore.writeOrigin(record.taskId, buildTaskOriginContext({
          sessionId: input.sessionId,
          taskSummary: goal,
          project: input.projectId ?? project,
          topicSummary: "Planned Butler task",
        }));
      }
      const linkedStream = workStreamStore.link({
        sessionId: input.sessionId,
        plannedTaskIds: [record.taskId],
      });
      return {
        ok: true,
        task_id: record.taskId,
        status: record.status,
        public_plan_summary: publicPlanSummary(plan),
        work_stream: linkedStream,
      };
    }

    if (call.name === "run_planned_task") {
      const taskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      if (!taskId) {
        throw new Error("run_planned_task requires task_id");
      }
      const record = plannedTaskStore.read(taskId);
      if (!record) {
        throw new Error(`planned task ${taskId} not found`);
      }
      if (record.status !== "PLANNED" && record.status !== "REPAIRING") {
        throw new Error(`invalid planned task transition ${record.status} -> PLANNED_RUNNING`);
      }
      const attempt = record.attempts.length + 1;
      const prompt = plannedWorkerPrompt(record.plan, attempt);
      const workerModel = selectWorkerModel(input, "deep");
      const worker = dispatchTask({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        task: prompt,
        projectPath: record.plan.project,
        model: workerModel.model,
        reasoningEffort: workerModel.reasoningEffort,
      });
      if (input.sessionId) {
        taskStore.writeOrigin(worker.task_id, buildTaskOriginContext({
          sessionId: input.sessionId,
          taskSummary: record.plan.goal,
          project: input.projectId ?? record.plan.project,
          topicSummary: "Planned Butler worker attempt",
        }));
      }
      plannedTaskStore.writeAttemptDispatch(taskId, attempt, {
        worker_task_id: worker.task_id,
        prompt,
      });
      const updated = plannedTaskStore.transition(taskId, "PLANNED_RUNNING");
      const linkedStream = workStreamStore.link({
        sessionId: input.sessionId,
        plannedTaskIds: [updated.taskId],
        workerTaskIds: [worker.task_id],
      });
      return {
        ok: true,
        task_id: updated.taskId,
        worker_task_id: worker.task_id,
        attempt,
        status: updated.status,
        message: "Planned worker attempt started. Review will run before public reporting.",
        work_stream: linkedStream,
      };
    }

    if (call.name === "review_planned_task") {
      const taskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      if (!taskId) {
        throw new Error("review_planned_task requires task_id");
      }
      const record = plannedTaskStore.read(taskId);
      if (!record) {
        throw new Error(`planned task ${taskId} not found`);
      }
      const attempt = typeof call.args.attempt === "number" && Number.isFinite(call.args.attempt)
        ? Math.max(1, Math.trunc(call.args.attempt))
        : record.attempts.length || 1;
      if (!record.attempts.includes(String(attempt).padStart(3, "0"))) {
        throw new Error(`planned task ${taskId} has no attempt ${attempt}`);
      }
      const workerTaskId = typeof call.args.worker_task_id === "string" ? call.args.worker_task_id.trim() : "";
      const reviewEventId = typeof call.args.review_event_id === "string" ? call.args.review_event_id.trim() : "";
      const ownershipMismatch = plannedReviewOwnershipMismatch({
        record,
        attempt,
        workerTaskId,
      });
      if (ownershipMismatch) {
        return stalePlannedReviewResult({
          taskId,
          attempt,
          status: record.status,
          reason: ownershipMismatch,
          reviewEventId,
        });
      }
      if (record.status !== "WORKER_DONE") {
        if (workerTaskId || reviewEventId) {
          return stalePlannedReviewResult({
            taskId,
            attempt,
            status: record.status,
            reason: `review event cannot mutate state ${record.status}`,
            reviewEventId,
          });
        }
        throw new Error(`invalid planned task transition ${record.status} -> REVIEWING`);
      }
      const reviews = canonicalPlannedCriterionReviews(record, criterionReviews(call.args.criteria));
      if (reviews.length === 0) {
        throw new Error("review_planned_task requires criterion evidence");
      }
      const missingCriteria = missingReviewCriteria(record, reviews);
      const requestedVerdict = overallReviewVerdict(reviews);
      const criteriaVerdict = requestedVerdict === "PASS" && missingCriteria.length > 0
        ? "INCONCLUSIVE"
        : requestedVerdict;
      const goalReview = plannedGoalReview(call.args.goal_review, record, criteriaVerdict);
      const verdict = combinedPlannedReviewVerdict([criteriaVerdict, goalReview.review.verdict]);
      const missingGoalEvidence = (
        criteriaVerdict === "PASS" &&
        goalReview.review.verdict !== "PASS"
      )
        ? [`Internal GOAL review: ${goalReview.review.evidence}`]
        : [];
      plannedTaskStore.transition(taskId, "REVIEWING");
      plannedTaskStore.writeReview({
        task_id: taskId,
        attempt,
        verdict,
        reviewed_at: new Date().toISOString(),
        goal_review: goalReview.review,
        criteria: reviews,
        missing_evidence: [
          ...stringArray(call.args.missing_evidence),
          ...missingCriteria,
          ...missingGoalEvidence,
        ],
        repair_recommendation:
          typeof call.args.repair_recommendation === "string" && call.args.repair_recommendation.trim()
            ? call.args.repair_recommendation.trim()
            : missingCriteria.length > 0
              ? "Review every acceptance criterion before preparing a public completion report."
              : goalReview.review.verdict !== "PASS"
                ? "Continue the BTCC cycle until the internal GOAL is complete or safely failed with evidence."
              : null,
      });
      const nextStatus = verdict === "PASS"
        ? "REVIEW_PASSED"
        : verdict === "FAIL"
          ? "REVIEW_FAILED"
          : "REVIEW_INCONCLUSIVE";
      const updated = plannedTaskStore.transition(taskId, nextStatus);
      return {
        ok: true,
        task_id: taskId,
        attempt,
        verdict,
        status: updated.status,
        criteria: reviews,
        missing_evidence: updated.review?.missing_evidence ?? [],
        repair_recommendation: updated.review?.repair_recommendation ?? null,
      };
    }

    if (call.name === "repair_planned_task") {
      const taskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      if (!taskId) {
        throw new Error("repair_planned_task requires task_id");
      }
      const record = plannedTaskStore.read(taskId);
      if (!record) {
        throw new Error(`planned task ${taskId} not found`);
      }
      const eventAttempt = typeof call.args.attempt === "number" && Number.isFinite(call.args.attempt)
        ? Math.max(1, Math.trunc(call.args.attempt))
        : null;
      const eventWorkerTaskId = typeof call.args.worker_task_id === "string" ? call.args.worker_task_id.trim() : "";
      const eventReviewId = typeof call.args.review_event_id === "string" ? call.args.review_event_id.trim() : "";
      if (eventAttempt) {
        const ownershipMismatch = plannedReviewOwnershipMismatch({
          record,
          attempt: eventAttempt,
          workerTaskId: eventWorkerTaskId,
        });
        if (ownershipMismatch) {
          return stalePlannedReviewResult({
            taskId,
            attempt: eventAttempt,
            status: record.status,
            reason: ownershipMismatch,
            reviewEventId: eventReviewId,
          });
        }
      }
      if (
        record.status !== "REVIEW_FAILED" &&
        record.status !== "REVIEW_INCONCLUSIVE" &&
        record.status !== "WORKER_FAILED"
      ) {
        throw new Error(`invalid planned task repair state ${record.status}`);
      }
      if (!record.plan.repair_policy.allow_autonomous_repair) {
        const failed = writeRepairFailureReport({
          store: plannedTaskStore,
          taskId,
          reason: "autonomous_repair_disabled",
          record,
        });
        return {
          ok: false,
          task_id: taskId,
          status: failed?.status,
          reason: "autonomous_repair_disabled",
          message: "Autonomous repair is disabled for this planned task.",
        };
      }
      if (repairAttemptsUsed(record) >= record.plan.repair_policy.max_attempts) {
        const failed = writeRepairFailureReport({
          store: plannedTaskStore,
          taskId,
          reason: "repair_cap_exhausted",
          record,
        });
        return {
          ok: false,
          task_id: taskId,
          status: failed?.status,
          reason: "repair_cap_exhausted",
          message: "The available autonomous repair attempts have already been used.",
        };
      }

      const repairObjective =
        typeof call.args.repair_objective === "string" && call.args.repair_objective.trim()
          ? call.args.repair_objective.trim()
          : record.review?.repair_recommendation ?? "Repair the failed or inconclusive planned criteria.";
      plannedTaskStore.transition(taskId, "REPAIRING");
      const repairing = plannedTaskStore.read(taskId)!;
      const attempt = repairing.attempts.length + 1;
      const prompt = plannedRepairPrompt({
        plan: repairing.plan,
        attempt,
        latestResult: repairing.latestResult,
        review: repairing.review,
        repairObjective,
      });
      const workerModel = selectWorkerModel(input, "deep");
      const worker = dispatchTask({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        task: prompt,
        projectPath: repairing.plan.project,
        model: workerModel.model,
        reasoningEffort: workerModel.reasoningEffort,
      });
      if (input.sessionId) {
        taskStore.writeOrigin(worker.task_id, buildTaskOriginContext({
          sessionId: input.sessionId,
          taskSummary: repairing.plan.goal,
          project: input.projectId ?? repairing.plan.project,
          topicSummary: "Planned Butler repair attempt",
        }));
      }
      plannedTaskStore.writeAttemptDispatch(taskId, attempt, {
        worker_task_id: worker.task_id,
        prompt,
      });
      const updated = plannedTaskStore.transition(taskId, "PLANNED_RUNNING");
      const linkedStream = workStreamStore.link({
        sessionId: input.sessionId,
        plannedTaskIds: [updated.taskId],
        workerTaskIds: [worker.task_id],
      });
      return {
        ok: true,
        task_id: taskId,
        worker_task_id: worker.task_id,
        attempt,
        status: updated.status,
        message: "Planned repair worker attempt started. Review will run again before public reporting.",
        work_stream: linkedStream,
      };
    }

    if (call.name === "request_principal_decision") {
      const taskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      const situation = typeof call.args.situation === "string" ? call.args.situation.trim() : "";
      const recommendedOptionId = typeof call.args.recommended_option_id === "string"
        ? call.args.recommended_option_id.trim()
        : "";
      const options = decisionOptions(call.args.options);
      if (!taskId) throw new Error("request_principal_decision requires task_id");
      if (!situation) throw new Error("request_principal_decision requires situation");
      if (options.length < 2) throw new Error("request_principal_decision requires at least two options");
      if (!options.some((option) => option.id === recommendedOptionId)) {
        throw new Error("request_principal_decision recommended option must match an option id");
      }
      const record = plannedTaskStore.read(taskId);
      if (!record) throw new Error(`planned task ${taskId} not found`);
      const decision: PlannedDecisionRequest = {
        decision_id: createDecisionId(),
        task_id: taskId,
        situation,
        recommended_option_id: recommendedOptionId,
        options,
        tradeoffs: stringArray(call.args.tradeoffs),
        expires_at: typeof call.args.expires_at === "string" && call.args.expires_at.trim()
          ? call.args.expires_at.trim()
          : null,
        created_at: new Date().toISOString(),
        response: null,
      };
      const replyMarkup = decisionReplyMarkup(decision);
      if (record.status !== "BLOCKED_WAITING_PRINCIPAL") {
        plannedTaskStore.transition(taskId, "BLOCKED_WAITING_PRINCIPAL");
      }
      plannedTaskStore.writeDecision(taskId, decision);
      return {
        ok: true,
        task_id: taskId,
        status: "BLOCKED_WAITING_PRINCIPAL",
        decision,
        outbound_event: {
          kind: "principal_decision_requested",
          text: [
            "A critical decision is needed.",
            "",
            situation,
            "",
            `Recommendation: ${recommendedOptionId}`,
          ].join("\n"),
          metadata: {
            replyMarkup,
            decisionId: decision.decision_id,
          },
        },
      };
    }

    if (call.name === "write_planned_public_report") {
      const taskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      const userReport = typeof call.args.report === "string" ? call.args.report.trim() : "";
      const outcome = typeof call.args.outcome === "string" ? call.args.outcome.trim() : "";
      if (!taskId) throw new Error("write_planned_public_report requires task_id");
      if (!userReport && !outcome) throw new Error("write_planned_public_report requires report");
      const record = plannedTaskStore.read(taskId);
      if (!record) throw new Error(`planned task ${taskId} not found`);
      if (record.status !== "REVIEW_PASSED" && record.status !== "FAILED_PUBLIC_REPORT_READY") {
        throw new Error(`invalid planned task public report state ${record.status}`);
      }
      if (!record.review) {
        throw new Error("write_planned_public_report requires a recorded planned review");
      }
      if (record.status === "REVIEW_PASSED" && record.review.goal_review?.verdict !== "PASS") {
        throw new Error("write_planned_public_report requires a passing internal GOAL review");
      }
      if (record.status === "FAILED_PUBLIC_REPORT_READY" && record.publicReport) {
        throw new Error("planned failure public report is already ready");
      }
      const report = publicReportText({
        record,
        report: userReport,
        outcome,
        whatWasDone: stringArray(call.args.what_was_done),
        residualRisk: stringArray(call.args.residual_risk),
        nextAction: typeof call.args.next_action === "string" ? call.args.next_action.trim() : "",
      });
      plannedTaskStore.writePublicReport(taskId, report);
      const updated = record.status === "REVIEW_PASSED"
        ? plannedTaskStore.transition(taskId, "PUBLIC_REPORT_READY")
        : plannedTaskStore.read(taskId)!;
      return {
        ok: true,
        task_id: taskId,
        status: updated.status,
        report,
      };
    }

    if (call.name === "resume_worker") {
      taskStore.reconcileRecoverableTasks();
      const requestedTaskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      const task = requestedTaskId
        ? taskStore.read(requestedTaskId)
        : taskStore.latestRecoverableTask();
      if (!task) {
        return {
          ok: false,
          error: requestedTaskId
            ? `task ${requestedTaskId} not found`
            : "no recoverable worker task found",
        };
      }
      if (task.status !== "RECOVERABLE") {
        return {
          ok: false,
          task_id: task.taskId,
          status: task.status,
          error: "task is not recoverable",
        };
      }
      const projectPath = task.project && task.project.startsWith("/")
        ? task.project
          : task.origin?.project && task.origin.project.startsWith("/")
            ? task.origin.project
            : input.butlerHome;
      const workerModel = selectWorkerModel(input, "routine");
      const resumed = dispatchTask({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        task: recoverableResumePrompt(task),
        projectPath,
        model: workerModel.model,
        reasoningEffort: workerModel.reasoningEffort,
      });
      return {
        ok: true,
        original_task_id: task.taskId,
        ...resumed,
        message: "Recoverable worker was resumed in a new background task.",
      };
    }

    if (call.name === "create_work_orchestration") {
      const goal = typeof call.args.goal === "string" ? call.args.goal.trim() : "";
      if (!goal) throw new Error("create_work_orchestration requires goal");
      const requestedOriginSessionId = typeof call.args.origin_session_id === "string"
        ? call.args.origin_session_id.trim()
        : "";
      if (requestedOriginSessionId && requestedOriginSessionId !== input.sessionId) {
        throw new Error("create_work_orchestration origin_session_id must match active session");
      }
      const orchestration = orchestrationStore.create({
        id: typeof call.args.id === "string" && call.args.id.trim() ? call.args.id.trim() : undefined,
        title: typeof call.args.title === "string" ? call.args.title : undefined,
        goal,
        originSessionId: input.sessionId ?? null,
        streams: workStreamInputs(call.args.streams),
      });
      const linkedStream = workStreamStore.link({
        sessionId: input.sessionId,
        orchestrationIds: [orchestration.id],
      });
      return {
        ok: true,
        orchestration,
        work_stream: linkedStream,
      };
    }

    if (call.name === "run_ready_work_streams") {
      const orchestrationId = typeof call.args.orchestration_id === "string" ? call.args.orchestration_id.trim() : "";
      if (!orchestrationId) throw new Error("run_ready_work_streams requires orchestration_id");
      const record = orchestrationStore.read(orchestrationId);
      if (!record) throw new Error(`work orchestration ${orchestrationId} not found`);
      const maxStreams = typeof call.args.max_streams === "number" && Number.isFinite(call.args.max_streams)
        ? Math.max(1, Math.min(10, Math.trunc(call.args.max_streams)))
        : 10;
      const ready = orchestrationStore.readyStreams(orchestrationId).slice(0, maxStreams);
      const dispatches = ready.map((stream) => {
        const workerModel = selectWorkerModel(input, "deep");
        const worker = dispatchTask({
          butlerHome: input.butlerHome,
          butlerData: input.butlerData,
          task: orchestrationWorkerPrompt({ orchestration: record, stream }),
          projectPath: input.butlerHome,
          model: workerModel.model,
          reasoningEffort: workerModel.reasoningEffort,
        });
        return {
          stream_id: stream.id,
          worker_task_id: worker.task_id,
        };
      });
      const linkedStream = workStreamStore.link({
        sessionId: input.sessionId,
        orchestrationIds: [orchestrationId],
        workerTaskIds: dispatches.map((dispatch) => dispatch.worker_task_id),
      });
      return {
        ok: true,
        dispatched: dispatches,
        orchestration: orchestrationStore.markDispatched(orchestrationId, dispatches),
        work_stream: linkedStream,
      };
    }

    if (call.name === "sync_work_orchestration") {
      const orchestrationId = typeof call.args.orchestration_id === "string" ? call.args.orchestration_id.trim() : "";
      if (!orchestrationId) throw new Error("sync_work_orchestration requires orchestration_id");
      return {
        ok: true,
        orchestration: orchestrationStore.syncFromTasks(orchestrationId, taskStore),
      };
    }

    if (call.name === "write_work_orchestration_report") {
      const orchestrationId = typeof call.args.orchestration_id === "string" ? call.args.orchestration_id.trim() : "";
      const report = typeof call.args.report === "string" ? call.args.report.trim() : "";
      if (!orchestrationId) throw new Error("write_work_orchestration_report requires orchestration_id");
      if (!report) throw new Error("write_work_orchestration_report requires report");
      return {
        ok: true,
        orchestration: orchestrationStore.writeReport(orchestrationId, report),
        work_stream: workStreamStore.link({
          sessionId: input.sessionId,
          orchestrationIds: [orchestrationId],
        }),
      };
    }

    if (call.name === "list_tasks") {
      const limit = typeof call.args.limit === "number" && Number.isFinite(call.args.limit)
        ? Math.max(1, Math.min(25, Math.trunc(call.args.limit)))
        : 10;
      const tasks = taskStore.summaries(limit).map((task) => {
        const summary = { ...task };
        delete (summary as Partial<typeof task>).activity_phase;
        delete (summary as Partial<typeof task>).activity_status_line;
        delete (summary as Partial<typeof task>).activity_current_title;
        delete (summary as Partial<typeof task>).activity_work_blocks;
        delete (summary as Partial<typeof task>).activity_updated_at;
        return {
          ...summary,
          ...(task.activity_phase ? { activity_phase: task.activity_phase } : {}),
          ...(task.activity_status_line ? { activity_status_line: task.activity_status_line } : {}),
          ...(task.activity_current_title ? { activity_current_title: task.activity_current_title } : {}),
          ...(task.activity_updated_at ? { activity_updated_at: task.activity_updated_at } : {}),
        };
      });
      return { ok: true, tasks };
    }

    if (call.name === "get_task_result") {
      const taskId = typeof call.args.task_id === "string" ? call.args.task_id.trim() : "";
      if (!taskId) {
        throw new Error("get_task_result requires task_id");
      }
      const task = taskStore.read(taskId);
      if (!task) {
        return { ok: false, task_id: taskId, error: "task not found" };
      }
      const safety = workSafetyForTask(task);
      return {
        ok: true,
        task_id: taskId,
        status: task.status,
        work_mode: safety.work_mode,
        safe_to_report: safety.safe_to_report,
        completion_claim_allowed: safety.completion_claim_allowed,
        guard_reason: safety.guard_reason,
        can_resume: task.status === "RECOVERABLE",
        user_summary: task.origin?.task_summary
          ? `${task.origin.task_summary}: ${task.status}`
          : `${task.request?.slice(0, 160) || `worker task ${task.taskId}`}: ${task.status}`,
        next_step: task.status === "RECOVERABLE"
          ? "Use resume_worker if the principal asks to continue this interrupted task."
          : task.status === "RUNNING"
            ? "Tell the principal this task is still running and avoid claiming completion."
            : "Answer from the durable result and observed log evidence.",
        result: task.result,
        observed_result: task.observedResult,
        log_tail: task.logTail,
        origin: task.origin,
      };
    }

    throw new Error(`Unknown Butler tool: ${call.name}`);
  };
}

function weatherSourceFromValue(value: unknown): WeatherSourceId | null {
  if (value === "open-meteo" || value === "nws") return value;
  return null;
}

function latestWeatherSourceFromTranscript(butlerData: string, sessionId?: string): WeatherSourceId | null {
  if (!sessionId) return null;
  const path = join(butlerData, "transcripts", `${sanitizeTranscriptSessionId(sessionId)}.jsonl`);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as {
        kind?: unknown;
        payload?: {
          name?: unknown;
          ok?: unknown;
          result?: { source?: unknown };
        };
      };
      if (
        event.kind === "tool_result" &&
        event.payload?.name === "get_weather_with_knowhow" &&
        event.payload.ok === true
      ) {
        return weatherSourceFromValue(event.payload.result?.source);
      }
    } catch {
      continue;
    }
  }
  return null;
}

function sanitizeTranscriptSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}
