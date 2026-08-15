import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../types.ts";
import {
  ProjectLedgerProjectScopeError,
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
import { createEvidenceCapabilityReceipt } from "../../output/evidence/ledger.ts";
import type { EvidenceCapabilityReceipt } from "../../output/evidence/types.ts";
import type { WorkspaceReference } from "../../session-workspaces/index.ts";
import { normalizeProjectLedgerAcceptanceInput } from "./acceptance-input.ts";
import {
  GIT_INSTALL_URL,
  GitEvidenceCollectionError,
  normalizeProjectLedgerCommitEvidenceInput,
} from "./git-commit-evidence.ts";
import type { RuntimeMemoryAttributionPort } from
  "../../../operations/diagnostics/runtime-memory-attribution/index.ts";
import { runRuntimeMemoryAttributionPhase } from
  "../../../operations/diagnostics/runtime-memory-attribution/index.ts";

type ToolCall = { args: Record<string, unknown> };
type ProjectLedgerExecutorInput = {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath?: string;
  workspacePath?: string;
  sessionId?: string;
  projectId?: string;
  workspaceReference?: WorkspaceReference;
  memoryAttribution?: RuntimeMemoryAttributionPort;
};

type ToolSpec = {
  name: string;
  description: string;
  required?: string[];
  properties: Record<string, Record<string, unknown>>;
  mutates: boolean;
};

const TOP_LEVEL_LEDGER_RECORD_KINDS = [
  "initiative",
  "decision",
  "risk",
  "spec",
  "report",
  "plan",
  "handoff",
  "reference",
  "roadmap",
] as const;

const LEDGER_WORK_STATES = [
  "proposed", "scoped", "specified", "in_progress", "review", "done", "blocked", "cancelled",
] as const;
const LEDGER_TASK_STATES = [
  "todo", "in_progress", "done", "blocked", "failed", "cancelled",
] as const;
const LEDGER_ATTEMPT_STATES = ["started", "succeeded", "failed", "interrupted"] as const;

const acceptanceInputField = {
  type: ["string", "array"],
  minItems: 1,
  items: { type: "string" },
} as const;

const recordFields = {
  project_ref: {
    type: "string",
    description: "Omit for active project.",
  },
  kind: { type: "string", description: "Canonical Ledger record kind." },
  id: { type: "string" },
  title: { type: "string" },
  status: { type: "string" },
  body: { type: "string" },
  validation: { type: "string" },
  review: { type: "string" },
  report: { type: "string" },
  code_commits: { type: "string" },
  code_commit: {
    type: "string",
    enum: ["auto"],
  },
  ledger_commits: { type: "string" },
  requires_commit_evidence: { type: "boolean" },
  spec: { type: "string" },
  acceptance: acceptanceInputField,
  implementation: { type: "string" },
  mitigation: { type: "string" },
  priority: { type: "number" },
  work_id: { type: "string" },
  task_id: { type: "string" },
  include_body: { type: "boolean" },
  limit: { type: "number" },
  query: { type: "string" },
} satisfies Record<string, Record<string, unknown>>;

const lifecycleUpdateFields = {
  project_ref: recordFields.project_ref,
  id: recordFields.id,
  status: recordFields.status,
  body: recordFields.body,
  spec: recordFields.spec,
};

const lifecycleCompleteFields = {
  project_ref: recordFields.project_ref,
  id: recordFields.id,
  spec: recordFields.spec,
  validation: recordFields.validation,
  review: recordFields.review,
  report: recordFields.report,
  code_commits: {
    ...recordFields.code_commits,
    description: 'JSON array requiring string "repo", "hash", and "message".',
  },
  code_commit: {
    ...recordFields.code_commit,
    description: 'Use "auto" for active workspace HEAD; never pass a SHA.',
  },
};

const workLifecycleCompleteFields = {
  ...lifecycleCompleteFields,
  acceptance: recordFields.acceptance,
};

const toolSpecs = [
  { name: "project_ledger_index", description: "Rebuild the compact Ledger index.", properties: { project_ref: recordFields.project_ref }, mutates: true },
  { name: "project_ledger_status", description: "Read Ledger summary, staleness, and next actions.", properties: { project_ref: recordFields.project_ref }, mutates: false },
  { name: "project_ledger_list", description: "List bounded Ledger records by kind, status, or query.", required: ["kind"], properties: { project_ref: recordFields.project_ref, kind: recordFields.kind, status: recordFields.status, query: recordFields.query, limit: recordFields.limit }, mutates: false },
  { name: "project_ledger_show", description: "Read one Ledger record, optionally with its body.", required: ["id"], properties: { project_ref: recordFields.project_ref, kind: recordFields.kind, id: recordFields.id, include_body: recordFields.include_body }, mutates: false },
  { name: "project_ledger_create", description: "Create one Ledger record. Search with project_ledger_list first. task needs work_id; attempt needs task_id; work/task needs acceptance.", required: ["kind", "id", "title"], properties: recordFields, mutates: true },
  { name: "project_ledger_update", description: "Update one exact Ledger record by kind and id.", required: ["kind", "id"], properties: recordFields, mutates: true },
  { name: "project_ledger_work_update", description: "Update or transition one Work.", required: ["id"], properties: lifecycleUpdateFields, mutates: true },
  { name: "project_ledger_work_complete", description: "Complete Work with validation, review, and report. For required Git evidence, use code_commit:\"auto\"; code_commits accepts canonical JSON. Missing Git is recoverable and does not block Butler.", required: ["id", "validation", "review", "report"], properties: workLifecycleCompleteFields, mutates: true },
  { name: "project_ledger_task_update", description: "Update or transition one Task.", required: ["id"], properties: lifecycleUpdateFields, mutates: true },
  { name: "project_ledger_task_complete", description: "Complete a Task with validation, review, and report evidence.", required: ["id", "validation", "review", "report"], properties: lifecycleCompleteFields, mutates: true },
  { name: "project_ledger_attempt_start", description: "Start an Attempt under a Task.", required: ["task_id"], properties: recordFields, mutates: true },
  { name: "project_ledger_attempt_succeed", description: "Mark an Attempt succeeded.", required: ["id"], properties: recordFields, mutates: true },
  { name: "project_ledger_attempt_fail", description: "Mark an Attempt failed.", required: ["id"], properties: recordFields, mutates: true },
  { name: "project_ledger_render", description: "Render a Ledger view; persist only when write is true.", required: ["view"], properties: { project_ref: recordFields.project_ref, view: { type: "string", description: "dashboard, handoff, or roadmap" }, write: { type: "boolean", description: "Persist the view." } }, mutates: true },
  { name: "project_ledger_check", description: "Validate Ledger records and return safe issues.", properties: { project_ref: recordFields.project_ref, verbose: { type: "boolean", description: "Include verbose checks." } }, mutates: false },
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
    ...(spec.name === "project_ledger_create" ? {
      oneOf: [
        {
          title: "Top-level record",
          properties: {
            kind: { type: "string", enum: TOP_LEVEL_LEDGER_RECORD_KINDS },
          },
        },
        {
          title: "Work",
          properties: {
            kind: { type: "string", const: "work" },
            status: { type: "string", enum: LEDGER_WORK_STATES },
          },
          required: ["acceptance"],
        },
        {
          title: "Task",
          properties: {
            kind: { type: "string", const: "task" },
            status: { type: "string", enum: LEDGER_TASK_STATES },
          },
          required: ["work_id", "acceptance"],
        },
        {
          title: "Attempt",
          properties: {
            kind: { type: "string", const: "attempt" },
            status: { type: "string", enum: LEDGER_ATTEMPT_STATES },
          },
          required: ["task_id"],
        },
      ],
    } : {}),
  },
  effectBoundary: spec.mutates ? "reviewed_persistent" : "none",
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
  const phase = toolName === "project_ledger_work_update" ? "work_update" : null;
  if (phase) {
    return runRuntimeMemoryAttributionPhase({
      attribution: input.memoryAttribution,
      phase,
      run: () => runProjectLedgerNativeToolInternal(input, toolName, args),
      failed: (result) => result.ok !== true,
    });
  }
  return runProjectLedgerNativeToolInternal(input, toolName, args);
}

function runProjectLedgerNativeToolInternal(
  input: ProjectLedgerExecutorInput,
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  let normalizedArgs: Record<string, unknown>;
  try {
    normalizedArgs = normalizeProjectLedgerCommitEvidence(
      input,
      toolName,
      normalizeProjectLedgerAcceptanceInput(args),
    );
  } catch (error) {
    return gitEvidenceFailureResult(error, stringArg(args, "id"));
  }
  let projectPath: string;
  try {
    projectPath = projectLedgerProjectPath({
      ...input,
      workspacePath: input.workspaceReference?.get() || input.workspacePath,
    }, normalizedArgs);
  } catch (error) {
    if (error instanceof ProjectLedgerProjectScopeError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
        },
      };
    }
    throw error;
  }
  const cliArgs = commandForProjectLedgerNativeTool(
    toolName,
    normalizedArgs,
    projectPath,
  );
  const plannedResult = runProjectLedgerPlannedLifecycleMutation({
    executor: input,
    toolName,
    args: normalizedArgs,
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
        refreshedIndex: refreshedProjectLedgerIndexResult(result),
      }),
    );
  }
  if (toolName === "project_ledger_render") {
    return {
      ...result,
      ...projectLedgerRenderedViewEvidence({
        projectPath,
        result,
        view: stringArg(normalizedArgs, "view"),
        write: normalizedArgs.write === true,
      }),
    };
  }
  if (toolName === "project_ledger_list") {
    return applyListBounds(result, normalizedArgs);
  }
  if (toolName === "project_ledger_show") return withCanonicalRecordEvidence(result);
  return result;
}

function gitEvidenceFailureResult(
  error: unknown,
  workId: string,
): Record<string, unknown> {
  const gitError = error instanceof GitEvidenceCollectionError ? error : null;
  const gitMissing = gitError?.code === "git_not_installed";
  return {
    ok: false,
    recoverable: true,
    butler_operational: true,
    git_features_available: false,
    error: {
      code: gitError?.code ?? "git_evidence_failed",
      message: gitMissing
        ? "Git is not installed. Butler can continue, but Git commit evidence is unavailable."
        : error instanceof Error
        ? error.message
        : "Unable to collect Git commit evidence from the active workspace.",
      ...(gitMissing
        ? { install_url: GIT_INSTALL_URL }
        : {
            native_next: [{
              tool: "project_ledger_work_complete",
              args: { id: workId, code_commit: "auto" },
              reason:
                "Restore a valid Git workspace and retry automatic commit evidence collection.",
            }],
          }),
    },
  };
}

function normalizeProjectLedgerCommitEvidence(
  input: ProjectLedgerExecutorInput,
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return normalizeProjectLedgerCommitEvidenceInput({
    toolName,
    args,
    workspacePath: input.workspaceReference?.get() || input.workspacePath || stringArg(args, "project_path") ||
      input.butlerHome,
  });
}

function withCanonicalRecordEvidence(result: Record<string, unknown>): Record<string, unknown> {
  if (result.ok !== true) return result;
  const record = recordValue(result.data);
  const id = safeRecordIdentity(record.id);
  const kind = safeRecordIdentity(record.kind);
  if (!id || !kind) return result;
  const status = safeRecordIdentity(record.status);
  const scope = {
    record_id: id,
    record_kind: kind,
    ...(status ? { status } : {}),
  };
  const references = [{ label: `${kind}:${id}` }];
  const receipts: EvidenceCapabilityReceipt[] = [createEvidenceCapabilityReceipt({
    producer: { kind: "project_ledger", name: "project_ledger_show" },
    capability: "source_verified",
    evidence_kind: "project_state",
    verified: true,
    confidence: 0.95,
    summary: "A canonical Project Ledger record was inspected.",
    scope,
    references,
    satisfies: ["source_verified"],
    limitations: [],
  })];
  const completedWork = kind === "work" && status === "done";
  if (completedWork && hasRecordText(record.implementation) && hasCanonicalCommitEvidence(record.codeCommits)) {
    receipts.push(createEvidenceCapabilityReceipt({
      producer: { kind: "project_ledger", name: "project_ledger_show" },
      capability: "workspace_mutated",
      evidence_kind: "mutation_result",
      verified: true,
      confidence: 0.9,
      summary: "The canonical work record contains implementation and commit evidence.",
      scope: { ...scope, evidence_field: "implementation_and_code_commits" },
      references,
      limitations: [],
    }));
  }
  if (completedWork && hasRecordText(record.validation)) {
    receipts.push(createEvidenceCapabilityReceipt({
      producer: { kind: "project_ledger", name: "project_ledger_show" },
      capability: "validation_passed",
      evidence_kind: "execution_result",
      verified: true,
      confidence: 0.9,
      summary: "The canonical work record contains validation evidence.",
      scope: { ...scope, evidence_field: "validation" },
      references,
      limitations: [],
    }));
  }
  if (completedWork && hasRecordText(record.review)) {
    receipts.push(createEvidenceCapabilityReceipt({
      producer: { kind: "project_ledger", name: "project_ledger_show" },
      capability: "review_completed",
      evidence_kind: "review_result",
      verified: true,
      confidence: 0.9,
      summary: "The canonical work record contains review evidence.",
      scope: { ...scope, evidence_field: "review" },
      references,
      limitations: [],
    }));
  }
  return { ...result, evidence_capability_receipts: receipts };
}

function safeRecordIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9._:-]{1,160}$/u.test(trimmed) ? trimmed : null;
}

function hasRecordText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasCanonicalCommitEvidence(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(canonicalCommitRecord);
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.some(canonicalCommitRecord);
    return false;
  } catch {
    // Older canonical records may store one commit hash directly.
  }
  return /^[0-9a-f]{7,64}$/iu.test(value.trim());
}

function canonicalCommitRecord(value: unknown): boolean {
  const record = recordValue(value);
  return typeof record.hash === "string" && /^[0-9a-f]{7,64}$/iu.test(record.hash.trim());
}

function refreshedProjectLedgerIndexResult(
  mutationResult: Record<string, unknown>,
): Record<string, unknown> | null {
  const data = recordValue(mutationResult.data);
  const derived = recordValue(data.derived);
  const refresh = recordValue(derived.index_refresh);
  if (refresh.ok !== true) return null;
  return {
    ok: true,
    data: {
      index: {
        path: typeof refresh.path === "string" ? refresh.path : null,
      },
    },
  };
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

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
