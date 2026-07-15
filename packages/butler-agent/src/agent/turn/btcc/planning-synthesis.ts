import type { PromptUsageSectionAttribution } from "../../../integrations/providers/provider.ts";
import { TodoListStore, type TodoItem } from "../../work/todo-list.ts";
import { WorkStreamStore } from "../../work/work-stream.ts";
import type { ToolAuditEntry } from "../native/output/tool-types.ts";
import type { ActiveTurnContract } from "../native/turn-runner/turn-contract-runtime.ts";
import type { ObligationToolSurfaceState } from "../native/turn-runner/obligation-tool-surface.ts";
import {
  assertTaskGraph,
  type BtccNativePhaseCoordinator,
  type BtccTaskGraphPayload,
} from "./native-phase-coordinator.ts";

type PrivateTextPrompt = (
  prompt: string,
  phase: string,
  sections: PromptUsageSectionAttribution[],
  responseFormat: {
    type: "json_schema";
    name: string;
    strict: true;
    schema: Record<string, unknown>;
  },
) => Promise<string>;

export async function runBtccPlanningSynthesis(input: {
  butlerData: string;
  coordinator: BtccNativePhaseCoordinator;
  active: ActiveTurnContract;
  frontier: ObligationToolSurfaceState;
  audit: ToolAuditEntry[];
  runPrivateTextPrompt: PrivateTextPrompt;
}): Promise<{ taskGraph: BtccTaskGraphPayload; modelCallRef: string }> {
  const state = input.coordinator.state();
  if (state.currentPhase !== "planning") throw new Error("btcc_planning_phase_not_active");
  if (input.frontier.stage === "work_planning" || input.frontier.stage === "ledger") {
    throw new Error("btcc_planning_frontier_incomplete");
  }
  const goal = input.coordinator.goalContract();
  const source = planningSource(input.butlerData, input.active, goal.workShape.workDisposition);
  const expectedCriterionIds = goal.acceptanceIntents.map((criterion) => criterion.key);
  const expectedObligationRefs = input.active.contract.required_evidence
    .map((obligation) => obligation.obligation_id);
  const expectedValidationRefs = input.active.contract.required_evidence
    .filter((obligation) => obligation.evidence_class === "passing_validation")
    .map((obligation) => obligation.obligation_id);
  const modelCallRef = `model-call:planning-synthesis:${state.turnId}:${state.phaseGeneration}`;
  const prompt = [
    input.coordinator.prompt("task").text,
    "## Planning Synthesis Capsule",
    JSON.stringify({
      goalContractRef: state.goalContractRef,
      goalContract: goal,
      turnContract: input.active.contract,
      trackingPolicyCandidate: state.trackingPolicyCandidate ?? null,
      planningFrontier: input.frontier,
      sourcePlanningItems: source.items,
      requiredTaskRefs: source.taskRefs,
      expectedCriterionIds,
      expectedObligationRefs,
      expectedValidationRefs,
      planningEvidenceRefs: auditEvidenceRefs(input.audit),
      acceptedReturnTicket: state.activeReturnTicketRef
        ? input.coordinator.readArtifact(state.activeReturnTicketRef)?.payload ?? null
        : null,
    }),
    "Return the smallest complete executable task graph. Bind every required task ref exactly once, order dependencies from accepted predecessors, assign every output obligation exactly once, and map every acceptance criterion to the tasks that produce its proof. Planning may not execute the tasks or invent evidence.",
  ].join("\n\n");
  const raw = await input.runPrivateTextPrompt(
    prompt,
    "btcc_planning_synthesis",
    [{
      id: "btcc_planning_synthesis",
      chars: prompt.length,
      estimatedTokens: Math.ceil(prompt.length / 4),
    }],
    planningResponseFormat(
      source.taskRefs,
      expectedCriterionIds,
      expectedObligationRefs,
      expectedValidationRefs,
    ),
  );
  const taskGraph = parsePlanningTaskGraph({
    raw,
    workstreamRef: source.workstreamRef,
    todoListRef: source.todoListRef,
    sourcePlanningItemRefs: source.sourcePlanningItemRefs,
    expectedTaskRefs: source.taskRefs,
    expectedCriterionIds,
    expectedObligationRefs,
    expectedValidationRefs,
    allowedAuthorityRefs: goal.semanticAuthorityRefs,
    allowedEffects: [...goal.workShape.requiredEffects, "observe", "validation"],
  });
  assertTaskGraph(taskGraph);
  return { taskGraph, modelCallRef };
}

function planningSource(
  butlerData: string,
  active: ActiveTurnContract,
  disposition: "direct_answer" | "managed_work",
): {
  workstreamRef: string | null;
  todoListRef: string | null;
  sourcePlanningItemRefs: string[];
  items: TodoItem[];
  taskRefs: string[];
} {
  const workstreamRef = active.contract.target_workstream_id ?? null;
  const stream = workstreamRef
    ? new WorkStreamStore(butlerData, { autoRecover: false }).read(workstreamRef)
    : null;
  const todo = stream?.todo_list_id
    ? new TodoListStore(butlerData, { autoRecover: false }).read(stream.todo_list_id)
    : null;
  const taskItems = (todo?.items ?? []).filter((item) =>
    item.phase === null || item.phase === "execution" || item.phase === "review",
  );
  const taskRefs = taskItems.length > 0
    ? taskItems.map((item) => `task:${active.contract.contract_id}:${item.id}`)
    : [`task:${active.contract.contract_id}:integrated-result`];
  return {
    workstreamRef,
    todoListRef: stream?.todo_list_id ?? null,
    sourcePlanningItemRefs: todo?.items.map((item) => item.id) ?? [],
    items: taskItems.length > 0 ? taskItems : [fallbackTodo(active, disposition)],
    taskRefs,
  };
}

function fallbackTodo(
  active: ActiveTurnContract,
  disposition: "direct_answer" | "managed_work",
): TodoItem {
  const now = new Date(0).toISOString();
  return {
    id: "integrated-result",
    ordinal: 1,
    content: active.decision.public_summary,
    active_form: active.decision.immediate_next_step ?? active.decision.public_summary,
    status: disposition === "direct_answer" ? "completed" : "pending",
    phase: "execution",
    priority: "normal",
    blocked_by: [],
    note: null,
    created_at: now,
    updated_at: now,
    completed_at: disposition === "direct_answer" ? now : null,
  };
}

function planningResponseFormat(
  taskRefs: string[],
  criterionIds: string[],
  obligationRefs: string[],
  validationRefs: string[],
) {
  return {
    type: "json_schema" as const,
    name: "butler_btcc_task_graph",
    strict: true as const,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["tasks", "coverage_matrix", "integrated_validation"],
      properties: {
        tasks: {
          type: "array",
          minItems: taskRefs.length,
          maxItems: taskRefs.length,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "task_ref", "objective", "status", "phase", "dependency_refs",
              "authority_refs", "required_effects", "output_obligation_refs",
              "validation_evidence_refs", "review_criterion_ids", "repair_owner",
            ],
            properties: {
              task_ref: { type: "string", enum: taskRefs },
              objective: { type: "string", minLength: 1, maxLength: 1200 },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              phase: { type: "string", enum: ["execution", "review"] },
              dependency_refs: { type: "array", uniqueItems: true, items: { type: "string", enum: taskRefs } },
              authority_refs: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
              required_effects: stringArraySchema(),
              output_obligation_refs: { type: "array", uniqueItems: true, items: refSchema(obligationRefs) },
              validation_evidence_refs: { type: "array", uniqueItems: true, items: refSchema(obligationRefs) },
              review_criterion_ids: { type: "array", minItems: 1, uniqueItems: true, items: refSchema(criterionIds) },
              repair_owner: { type: "string", enum: ["planning", "execution"] },
            },
          },
        },
        coverage_matrix: {
          type: "array",
          minItems: criterionIds.length,
          maxItems: criterionIds.length,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["criterion_id", "task_refs"],
            properties: {
              criterion_id: { type: "string", enum: criterionIds },
              task_refs: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: taskRefs } },
            },
          },
        },
        integrated_validation: {
          type: "object",
          additionalProperties: false,
          required: ["required", "evidence_obligation_refs"],
          properties: {
            required: { type: "boolean" },
            evidence_obligation_refs: {
              type: "array",
              minItems: validationRefs.length,
              maxItems: validationRefs.length,
              uniqueItems: true,
              items: refSchema(validationRefs),
            },
          },
        },
      },
    },
  };
}

function parsePlanningTaskGraph(input: {
  raw: string;
  workstreamRef: string | null;
  todoListRef: string | null;
  sourcePlanningItemRefs: string[];
  expectedTaskRefs: string[];
  expectedCriterionIds: string[];
  expectedObligationRefs: string[];
  expectedValidationRefs: string[];
  allowedAuthorityRefs: string[];
  allowedEffects: string[];
}): BtccTaskGraphPayload {
  let value: unknown;
  try {
    value = JSON.parse(input.raw);
  } catch {
    throw new Error("btcc_planning_task_graph_invalid_json");
  }
  const record = requiredRecord(value, "btcc_planning_task_graph_invalid");
  const tasks = recordArray(record.tasks).map((task) => ({
    taskRef: requiredString(task.task_ref),
    objective: requiredString(task.objective),
    status: requiredString(task.status),
    phase: requiredString(task.phase),
    dependencyRefs: stringArray(task.dependency_refs),
    authorityRefs: stringArray(task.authority_refs),
    requiredEffects: stringArray(task.required_effects),
    outputObligationRefs: stringArray(task.output_obligation_refs),
    validationEvidenceRefs: stringArray(task.validation_evidence_refs),
    reviewCriterionIds: stringArray(task.review_criterion_ids),
    repairOwner: requiredString(task.repair_owner) as "planning" | "execution",
  }));
  const coverageMatrix = recordArray(record.coverage_matrix).map((entry) => ({
    criterionId: requiredString(entry.criterion_id),
    taskRefs: stringArray(entry.task_refs),
  }));
  const validation = requiredRecord(
    record.integrated_validation,
    "btcc_planning_integrated_validation_invalid",
  );
  assertExactSet(tasks.map((task) => task.taskRef), input.expectedTaskRefs, "btcc_planning_task_binding_invalid");
  assertExactSet(
    coverageMatrix.map((entry) => entry.criterionId),
    input.expectedCriterionIds,
    "btcc_planning_criterion_coverage_invalid",
  );
  const authority = new Set(input.allowedAuthorityRefs);
  const effects = new Set(input.allowedEffects);
  const criteria = new Set(input.expectedCriterionIds);
  const obligations = new Set(input.expectedObligationRefs);
  for (const task of tasks) {
    if (task.authorityRefs.some((ref) => !authority.has(ref))) {
      throw new Error("btcc_planning_task_authority_invalid");
    }
    if (task.requiredEffects.some((effect) => !effects.has(effect))) {
      throw new Error("btcc_planning_task_effect_invalid");
    }
    if (task.reviewCriterionIds.some((id) => !criteria.has(id))) {
      throw new Error("btcc_planning_task_criterion_invalid");
    }
    if ([...task.outputObligationRefs, ...task.validationEvidenceRefs]
      .some((ref) => !obligations.has(ref))) {
      throw new Error("btcc_planning_task_obligation_invalid");
    }
  }
  const validationRefs = stringArray(validation.evidence_obligation_refs);
  assertExactSet(
    validationRefs,
    input.expectedValidationRefs,
    "btcc_planning_validation_obligation_invalid",
  );
  if (validation.required !== (input.expectedValidationRefs.length > 0)) {
    throw new Error("btcc_planning_validation_requirement_invalid");
  }
  const assignedValidationRefs = tasks.flatMap((task) => task.validationEvidenceRefs);
  if (assignedValidationRefs.length !== input.expectedValidationRefs.length ||
    new Set(assignedValidationRefs).size !== assignedValidationRefs.length ||
    input.expectedValidationRefs.some((ref) => !assignedValidationRefs.includes(ref))) {
    throw new Error("btcc_planning_validation_obligation_invalid");
  }
  return {
    schemaVersion: "butler.btcc-task-graph.v1",
    workstreamRef: input.workstreamRef,
    todoListRef: input.todoListRef,
    sourcePlanningItemRefs: input.sourcePlanningItemRefs,
    tasks,
    acceptanceObligationRefs: input.expectedObligationRefs,
    coverageMatrix,
    integratedValidation: {
      required: validation.required === true,
      evidenceObligationRefs: validationRefs,
    },
  };
}

function assertExactSet(actual: string[], expected: string[], code: string): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (actual.length !== expected.length || actualSet.size !== expectedSet.size ||
    [...expectedSet].some((item) => !actualSet.has(item))) {
    throw new Error(code);
  }
}

function auditEvidenceRefs(audit: ToolAuditEntry[]): string[] {
  return [...new Set(audit.flatMap((entry) => [
    ...(entry.evidenceReceipts?.map((receipt) => receipt.id) ?? []),
    ...(entry.evidenceCapabilityReceipts?.map((receipt) => receipt.receipt_id) ?? []),
  ]))];
}

function refSchema(refs: string[]): Record<string, unknown> {
  return refs.length > 0 ? { type: "string", enum: refs } : { type: "string" };
}

function stringArraySchema(): Record<string, unknown> {
  return { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } };
}

function requiredRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("btcc_planning_task_graph_array_invalid");
  return value.map((item) => requiredRecord(item, "btcc_planning_task_graph_item_invalid"));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("btcc_planning_task_graph_string_array_invalid");
  }
  return value.map((item) => String(item).trim());
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("btcc_planning_task_graph_string_invalid");
  }
  return value.trim();
}
