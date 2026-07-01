import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";
import {
  projectLedgerProjectPath,
  projectLedgerRenderedViewEvidence,
  runProjectLedgerTool,
} from "../../../integrations/project-ledger/client.ts";
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
  project_path: { type: "string", description: "Workspace/project path used to resolve the canonical Project Ledger project." },
  kind: { type: "string", description: "Project Ledger source record kind." },
  id: { type: "string", description: "Project Ledger record id." },
  title: { type: "string", description: "Record title." },
  status: { type: "string", description: "Lifecycle/status value accepted by Project Ledger for this record kind." },
  body: { type: "string", description: "Markdown body to write through Project Ledger CLI/core behavior." },
  validation: { type: "string", description: "Validation evidence summary or path." },
  review: { type: "string", description: "Review evidence summary or path." },
  report: { type: "string", description: "Report or handoff path." },
  spec: { type: "string", description: "Linked spec id or path." },
  acceptance: { type: "string", description: "Acceptance evidence summary or path." },
  implementation: { type: "string", description: "Implementation evidence summary or path." },
  mitigation: { type: "string", description: "Mitigation evidence summary or path." },
  priority: { type: "number", description: "Project Ledger priority value." },
  work_id: { type: "string", description: "Parent work id for task creation." },
  task_id: { type: "string", description: "Parent task id for attempt creation." },
  include_body: { type: "boolean", description: "Include the Markdown body in the result." },
  limit: { type: "number", description: "Maximum number of list results to return after CLI/core query." },
  query: { type: "string", description: "Case-insensitive text filter applied to CLI/core query results." },
} satisfies Record<string, Record<string, unknown>>;

const toolSpecs = [
  { name: "project_ledger_index", description: "Rebuild the Project Ledger compact index for the resolved project path.", properties: { project_path: recordFields.project_path }, mutates: true },
  { name: "project_ledger_status", description: "Return canonical Project Ledger project summary, stale state, and next actions.", properties: { project_path: recordFields.project_path }, mutates: false },
  { name: "project_ledger_list", description: "List bounded Project Ledger records by kind with optional status and text filtering.", required: ["kind"], properties: { project_path: recordFields.project_path, kind: recordFields.kind, status: recordFields.status, query: recordFields.query, limit: recordFields.limit }, mutates: false },
  { name: "project_ledger_show", description: "Show one Project Ledger record summary, optionally including its Markdown body.", required: ["id"], properties: { project_path: recordFields.project_path, kind: recordFields.kind, id: recordFields.id, include_body: recordFields.include_body }, mutates: false },
  { name: "project_ledger_create", description: "Create a modeled Project Ledger source record through CLI/core behavior.", required: ["kind", "id", "title"], properties: recordFields, mutates: true },
  { name: "project_ledger_update", description: "Update frontmatter and/or body for a modeled Project Ledger source record through CLI/core behavior.", required: ["id"], properties: recordFields, mutates: true },
  { name: "project_ledger_work_update", description: "Update or transition a Project Ledger work record through CLI/core behavior.", required: ["id"], properties: recordFields, mutates: true },
  { name: "project_ledger_work_complete", description: "Complete Project Ledger work with CLI/core completion gates and actionable failure details.", required: ["id"], properties: recordFields, mutates: true },
  { name: "project_ledger_task_update", description: "Update or transition a Project Ledger task record through task-specific CLI/core behavior.", required: ["id"], properties: recordFields, mutates: true },
  { name: "project_ledger_task_complete", description: "Complete a Project Ledger task through task-specific CLI/core behavior.", required: ["id"], properties: recordFields, mutates: true },
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
  const cliArgs = commandForTool(toolName, args, projectPath);
  const result = withRecoverableProjectLedgerError(runProjectLedgerTool(input, cliArgs));
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

function commandForTool(toolName: string, args: Record<string, unknown>, projectPath: string): string[] {
  const project = ["--project", projectPath];
  if (toolName === "project_ledger_index") return ["index", ...project];
  if (toolName === "project_ledger_status") return ["status", ...project];
  if (toolName === "project_ledger_list") return ["query", ...project, "--kind", requireString(args, "kind")];
  if (toolName === "project_ledger_show") return ["record", "show", ...project, ...recordIdentityArgs(args), ...booleanFlag(args, "include_body", "body")];
  if (toolName === "project_ledger_create") return createArgs(args, project);
  if (toolName === "project_ledger_update") return withBodyFile(args, ["record", "update", ...project, ...recordIdentityArgs(args), ...metadataArgs(args)]);
  if (toolName === "project_ledger_work_update") return withBodyFile(args, ["work", "update", ...project, "--id", requireString(args, "id"), ...metadataArgs(args)]);
  if (toolName === "project_ledger_work_complete") return withBodyFile(args, ["work", "complete", ...project, "--id", requireString(args, "id"), ...metadataArgs(args)]);
  if (toolName === "project_ledger_task_update") return withBodyFile(args, ["task", "update", ...project, "--id", requireString(args, "id"), ...metadataArgs(args)]);
  if (toolName === "project_ledger_task_complete") return withBodyFile(args, ["task", "complete", ...project, "--id", requireString(args, "id"), ...metadataArgs(args)]);
  if (toolName === "project_ledger_attempt_start") return withBodyFile(args, ["attempt", "start", ...project, "--task", requireString(args, "task_id"), ...optionalIdArgs(args), ...metadataArgs(args)]);
  if (toolName === "project_ledger_attempt_succeed") return withBodyFile(args, ["attempt", "succeed", ...project, "--id", requireString(args, "id"), ...metadataArgs(args)]);
  if (toolName === "project_ledger_attempt_fail") return withBodyFile(args, ["attempt", "fail", ...project, "--id", requireString(args, "id"), ...metadataArgs(args)]);
  if (toolName === "project_ledger_render") return ["render", ...project, requireString(args, "view"), ...booleanFlag(args, "write", "write")];
  if (toolName === "project_ledger_check") return ["check", ...project, ...booleanFlag(args, "verbose", "verbose")];
  throw new Error(`Unknown Project Ledger tool: ${toolName}`);
}

function createArgs(args: Record<string, unknown>, project: string[]): string[] {
  const kind = requireString(args, "kind");
  if (kind === "work") return withBodyFile(args, ["work", "create", ...project, "--id", requireString(args, "id"), "--title", requireString(args, "title"), ...metadataArgs(args)]);
  if (kind === "task") return withBodyFile(args, ["task", "create", ...project, "--work", requireString(args, "work_id"), "--id", requireString(args, "id"), "--title", requireString(args, "title"), ...metadataArgs(args)]);
  if (kind === "attempt") return withBodyFile(args, ["attempt", "start", ...project, "--task", requireString(args, "task_id"), "--id", requireString(args, "id"), "--title", requireString(args, "title"), ...metadataArgs(args)]);
  return withBodyFile(args, ["record", "create", ...project, "--kind", kind, "--id", requireString(args, "id"), "--title", requireString(args, "title"), ...metadataArgs(args)]);
}

function withBodyFile(args: Record<string, unknown>, cliArgs: string[]): string[] {
  const body = stringArg(args, "body");
  if (!body) return cliArgs;
  const dir = mkdtempSync(join(tmpdir(), "butler-project-ledger-tool-"));
  const path = join(dir, "body.md");
  writeFileSync(path, body, "utf8");
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return [...cliArgs, "--from", path];
}

function recordIdentityArgs(args: Record<string, unknown>): string[] {
  return ["--id", requireString(args, "id"), ...stringFlag(args, "kind", "kind")];
}

function optionalIdArgs(args: Record<string, unknown>): string[] {
  return stringFlag(args, "id", "id");
}

function metadataArgs(args: Record<string, unknown>): string[] {
  return [
    ...stringFlag(args, "title", "title"),
    ...stringFlag(args, "status", "status"),
    ...stringFlag(args, "spec", "spec"),
    ...stringFlag(args, "validation", "validation"),
    ...stringFlag(args, "review", "review"),
    ...stringFlag(args, "report", "report"),
    ...stringFlag(args, "acceptance", "acceptance"),
    ...stringFlag(args, "implementation", "implementation"),
    ...stringFlag(args, "mitigation", "mitigation"),
    ...numberFlag(args, "priority", "priority"),
  ];
}

function stringFlag(args: Record<string, unknown>, key: string, flag: string): string[] {
  const value = stringArg(args, key);
  return value ? [`--${flag}`, value] : [];
}

function numberFlag(args: Record<string, unknown>, key: string, flag: string): string[] {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? [`--${flag}`, String(value)] : [];
}

function booleanFlag(args: Record<string, unknown>, key: string, flag: string): string[] {
  return args[key] === true ? [`--${flag}`] : [];
}

function requireString(args: Record<string, unknown>, key: string): string {
  return stringArg(args, key);
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
