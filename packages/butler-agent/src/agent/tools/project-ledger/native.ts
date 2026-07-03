import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";
import {
  projectLedgerProjectPath,
  projectLedgerRenderedViewEvidence,
  runProjectLedgerTool,
} from "../../../integrations/project-ledger/client.ts";
import {
  applyProjectLedgerLifecycleCloseout,
  needsProjectLedgerLifecycleCloseout,
  runProjectLedgerLifecycleCloseout,
} from "./closeout.ts";
import { commandForProjectLedgerNativeTool } from "./command.ts";
import { runProjectLedgerPlannedLifecycleMutation } from "./lifecycle-planner.ts";
import { projectLedgerNativeNextHints } from "./recovery-hints.ts";

type ToolCall = { args: Record<string, unknown> };
type ProjectLedgerExecutorInput = {
  butlerHome: string;
  butlerData: string;
  sessionId?: string;
  projectId?: string;
};

type ToolSpec = {
  name: string;
  description: string;
  required?: string[];
  properties: Record<string, Record<string, unknown>>;
  mutates: boolean;
};

const recordFields = {
  project_path: { type: "string", description: "Project path." },
  kind: { type: "string", description: "Record kind." },
  id: { type: "string", description: "Record id." },
  title: { type: "string", description: "Record title." },
  status: { type: "string", description: "Lifecycle status." },
  body: { type: "string", description: "Markdown body." },
  validation: { type: "string", description: "Validation evidence." },
  review: { type: "string", description: "Review evidence." },
  report: { type: "string", description: "Report path or summary." },
  code_commits: { type: "string", description: "JSON array of code commit evidence." },
  code_commit: { type: "string", description: "Set to auto to collect the current git HEAD as code commit evidence." },
  ledger_commits: { type: "string", description: "JSON array of ledger commit evidence." },
  requires_commit_evidence: { type: "boolean", description: "Require code commit evidence before completing work." },
  spec: { type: "string", description: "Linked spec." },
  acceptance: { type: "string", description: "Acceptance evidence." },
  implementation: { type: "string", description: "Implementation evidence." },
  mitigation: { type: "string", description: "Mitigation evidence." },
  priority: { type: "number", description: "Priority." },
  work_id: { type: "string", description: "Parent work id." },
  task_id: { type: "string", description: "Parent task id." },
  include_body: { type: "boolean", description: "Include body." },
  limit: { type: "number", description: "Result limit." },
  query: { type: "string", description: "Text filter." },
} satisfies Record<string, Record<string, unknown>>;

const lifecycleUpdateFields = {
  project_path: recordFields.project_path,
  id: recordFields.id,
  status: recordFields.status,
  body: recordFields.body,
  spec: recordFields.spec,
};

const lifecycleCompleteFields = {
  project_path: recordFields.project_path,
  id: recordFields.id,
  validation: recordFields.validation,
  review: recordFields.review,
  report: recordFields.report,
  code_commits: recordFields.code_commits,
  code_commit: recordFields.code_commit,
};

const toolSpecs = [
  { name: "project_ledger_index", description: "Rebuild the Project Ledger compact index for the resolved project path.", properties: { project_path: recordFields.project_path }, mutates: true },
  { name: "project_ledger_status", description: "Return canonical Project Ledger project summary, stale state, and next actions.", properties: { project_path: recordFields.project_path }, mutates: false },
  { name: "project_ledger_list", description: "List bounded Project Ledger records by kind with optional status and text filtering.", required: ["kind"], properties: { project_path: recordFields.project_path, kind: recordFields.kind, status: recordFields.status, query: recordFields.query, limit: recordFields.limit }, mutates: false },
  { name: "project_ledger_show", description: "Show one Project Ledger record summary, optionally including its Markdown body.", required: ["id"], properties: { project_path: recordFields.project_path, kind: recordFields.kind, id: recordFields.id, include_body: recordFields.include_body }, mutates: false },
  { name: "project_ledger_create", description: "Create a modeled Project Ledger source record through CLI/core behavior.", required: ["kind", "id", "title"], properties: recordFields, mutates: true },
  { name: "project_ledger_update", description: "Update frontmatter and/or body for a modeled Project Ledger source record through CLI/core behavior.", required: ["id"], properties: recordFields, mutates: true },
  { name: "project_ledger_work_update", description: "Update or transition Project Ledger work.", required: ["id"], properties: lifecycleUpdateFields, mutates: true },
  { name: "project_ledger_work_complete", description: "Complete Project Ledger work.", required: ["id"], properties: lifecycleCompleteFields, mutates: true },
  { name: "project_ledger_task_update", description: "Update or transition a Project Ledger task.", required: ["id"], properties: lifecycleUpdateFields, mutates: true },
  { name: "project_ledger_task_complete", description: "Complete a Project Ledger task.", required: ["id"], properties: lifecycleCompleteFields, mutates: true },
  { name: "project_ledger_attempt_start", description: "Create a started Project Ledger attempt under a task.", required: ["task_id"], properties: recordFields, mutates: true },
  { name: "project_ledger_attempt_succeed", description: "Mark a Project Ledger attempt succeeded through CLI/core behavior.", required: ["id"], properties: recordFields, mutates: true },
  { name: "project_ledger_attempt_fail", description: "Mark a Project Ledger attempt failed through CLI/core behavior.", required: ["id"], properties: recordFields, mutates: true },
  { name: "project_ledger_render", description: "Render a Project Ledger generated view, writing only when write is true.", required: ["view"], properties: { project_path: recordFields.project_path, view: { type: "string", description: "Generated view name: dashboard, handoff, or roadmap." }, write: { type: "boolean", description: "Persist the generated view." } }, mutates: true },
  { name: "project_ledger_check", description: "Run strict Project Ledger validation and return safe issue details.", properties: { project_path: recordFields.project_path, verbose: { type: "boolean", description: "Request verbose check behavior from the CLI where supported." } }, mutates: false },
] satisfies ToolSpec[];

export const projectLedgerNativeToolDefinitions = toolSpecs.map((spec) => ({
  type: "function",
  name: spec.name,
  description: spec.description,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: spec.properties,
    required: spec.required ?? [],
  },
  concurrencySafe: !spec.mutates,
  interruptBehavior: "continue",
  transcriptVisibility: "visible",
})) satisfies ButlerToolDefinition[];

const projectLedgerTags = [
  "project-ledger",
  "ledger",
  "spec",
  "plan",
  "work",
  "task",
  "attempt",
  "state transition",
  "closeout",
  "complete",
  "index",
  "render",
  "check",
  "native",
];

export const projectLedgerNativeToolMetadata = Object.fromEntries(
  projectLedgerNativeToolDefinitions.map((tool) => [
    tool.name,
    {
      category: "project",
      tags: projectLedgerTags,
      safetyNotes: ["Delegates to Project Ledger CLI/core behavior and preserves recoverable error details."],
    } satisfies ToolCapabilityMetadata,
  ]),
) as Record<string, ToolCapabilityMetadata>;

export function createProjectLedgerNativeToolHandlers(input: ProjectLedgerExecutorInput) {
  return Object.fromEntries(projectLedgerNativeToolDefinitions.map((tool) => [
    tool.name,
    (call: ToolCall) => runProjectLedgerNativeTool(input, tool.name, call.args),
  ]));
}

export function projectLedgerNativeToolDefinition(name: string): ButlerToolDefinition {
  const tool = projectLedgerNativeToolDefinitions.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Unknown Project Ledger native tool definition: ${name}`);
  return tool;
}

export function projectLedgerNativeMetadataForTool(name: string): ToolCapabilityMetadata {
  const metadata = projectLedgerNativeToolMetadata[name];
  if (!metadata) throw new Error(`Unknown Project Ledger native tool metadata: ${name}`);
  return metadata;
}

export function createProjectLedgerNativeToolHandler(input: ProjectLedgerExecutorInput, name: string) {
  return createProjectLedgerNativeToolHandlers(input)[name];
}

function runProjectLedgerNativeTool(
  input: ProjectLedgerExecutorInput,
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const projectPath = projectLedgerProjectPath(input, args);
  const cliArgs = commandForProjectLedgerNativeTool(toolName, args, projectPath);
  const plannedResult = runProjectLedgerPlannedLifecycleMutation({
    executor: input,
    toolName,
    args,
    projectPath,
    finalCliArgs: cliArgs,
  });
  const result = plannedResult ?? withRecoverableProjectLedgerError(runProjectLedgerTool(input, cliArgs));
  if (needsProjectLedgerLifecycleCloseout(toolName, result)) {
    return applyProjectLedgerLifecycleCloseout(
      result,
      runProjectLedgerLifecycleCloseout({
        executor: input,
        projectPath,
      }),
    );
  }
  if (toolName === "project_ledger_render") {
    return {
      ...result,
      ...projectLedgerRenderedViewEvidence({
        projectPath,
        result,
        view: stringArg(args, "view"),
        write: args.write === true,
      }),
    };
  }
  if (toolName === "project_ledger_list") return applyListBounds(result, args);
  return result;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? args[key].trim() : "";
}

function applyListBounds(result: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  if (result.ok === false) return result;
  const data = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data as Record<string, unknown> : {};
  const results = Array.isArray(data.results) ? data.results : [];
  const status = stringArg(args, "status");
  const query = stringArg(args, "query").toLocaleLowerCase("en-US");
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 50;
  const bounded = results
    .filter((item) => !status || (item && typeof item === "object" && (item as Record<string, unknown>).status === status))
    .filter((item) => !query || JSON.stringify(item).toLocaleLowerCase("en-US").includes(query))
    .slice(0, limit);
  return { ...result, data: { ...data, results: bounded, limit, returned: bounded.length } };
}

function withRecoverableProjectLedgerError(result: Record<string, unknown>): Record<string, unknown> {
  if (result.ok !== false || !result.error || typeof result.error !== "object" || Array.isArray(result.error)) return result;
  const error = result.error as Record<string, unknown>;
  const nativeNext = projectLedgerNativeNextHints(error);
  if (nativeNext.length === 0) return result;
  return {
    ...result,
    recoverable: true,
    error: {
      ...error,
      native_next: nativeNext,
    },
  };
}
