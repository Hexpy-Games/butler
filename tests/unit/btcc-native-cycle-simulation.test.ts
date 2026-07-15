import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { ConversationAdmissionTurn } from "../../packages/butler-agent/src/agent/conversation/session-admission.ts";
import { BtccPhaseStore } from "../../packages/butler-agent/src/agent/turn/btcc/phase-store.ts";
import { createEvidenceCapabilityReceipt } from "../../packages/butler-agent/src/agent/output/evidence/parser.ts";
import type {
  InboundEnvelope,
  ModelProviderAdapter,
  StoredSessionBinding,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

let data = "";

beforeEach(() => {
  data = join(tmpdir(), `butler-btcc-cycle-${Date.now()}-${Math.random()}`);
  mkdirSync(data, { recursive: true });
});

afterEach(() => rmSync(data, { recursive: true, force: true }));

const provider: ModelProviderAdapter = {
  id: "btcc-cycle-provider",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: true,
    supportsStructuredOutputs: true,
    structuredDecisionTransport: "json_schema",
  },
  async invoke() {
    return { text: "unused" };
  },
};

test("one admitted message traverses all six BTCC phases before Reporting delivery", async () => {
  const conversations = new AgentConversationStore({ butlerData: data });
  const phases = new BtccPhaseStore({ butlerData: data });
  const envelope = inbound("turn-btcc-cycle", "이 문장을 영어로 번역해줘: 구조가 행동을 만든다.");
  const binding = storedBinding();
  const admission = ConversationAdmissionTurn.begin({
    writer: conversations,
    binding,
    envelope,
    turnId: "turn-btcc-cycle",
    timestamp: envelope.message.timestamp,
    butlerData: data,
    btccInterruptionStateWriter: phases,
  });
  admission.admitInbound();
  const provenance = admission.provenance();
  expect(provenance).not.toBeNull();

  const calls: Array<{ phase: string; prompt: string }> = [];
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => {
      const phase = input.usageAttribution?.phase ?? "unknown";
      calls.push({ phase, prompt: input.prompt });
      return successfulBtccResponse(phase, input.prompt, input.responseFormat);
    },
    runFunctionToolPromptText: async () => {
      throw new Error("direct_answer_must_not_enter_tool_execution");
    },
  });
  const handle = await runtime.createSession({
    sessionId: binding.sessionId,
    role: "butler",
    workspacePath: binding.workspacePath,
    systemPrompt: "Answer accurately and concisely.",
  });
  const result = await runtime.runTurn({
    handle,
    provider,
    model: "openai/gpt-5.5",
    input: envelope,
    metadata: {
      turnId: "turn-btcc-cycle",
      currentUserText: envelope.message.text,
      conversationProvenance: provenance,
      executionControls: envelope.executionControls,
      runtimePolicy: { completionReview: "disabled" },
    },
  });

  expect(result.text).toBe("Structure shapes behavior.");
  expect(calls.map((call) => call.phase)).toEqual([
    "typed_turn_decision",
    "btcc_planning_synthesis",
    "btcc_review",
    "btcc_consolidation",
    "btcc_reporting_reporter",
    "btcc_reporting_guard",
  ]);
  expect(calls[0]?.prompt).toContain("Current phase: conception");
  expect(calls[0]?.prompt).toContain("What the principal is requesting now");
  expect(calls[0]?.prompt).toContain("Which admitted memories or prior decisions are relevant");
  expect(calls[0]?.prompt).toContain("Which connected knowledge or current reality must be checked");
  expect(calls[0]?.prompt).toContain("Which accepted user preferences or problem-solving patterns apply here");
  expect(calls[0]?.prompt).toContain("Which expert perspectives are needed");
  expect(calls[0]?.prompt).toContain("What concrete result must be delivered");
  expect(calls[1]?.prompt).toContain("Current phase: planning");
  expect(calls[2]?.prompt).toContain("Current phase: review");
  expect(calls[3]?.prompt).toContain("Current phase: consolidation");
  expect(calls[4]?.prompt).toContain("Current phase: reporting");
  expect(calls[5]?.prompt).toContain("Current phase: reporting");

  const beforeDelivery = phases.readPhaseState("turn-btcc-cycle");
  expect(beforeDelivery).toMatchObject({
    currentPhase: "reporting",
    lifecycleStatus: "active",
  });
  expect(beforeDelivery?.acceptedReceiptRefs).toHaveLength(6);
  const plan = beforeDelivery?.planRevisionRef
    ? phases.readPhaseArtifact(beforeDelivery.planRevisionRef)
    : null;
  expect(plan).toMatchObject({
    phase: "planning",
    artifactKind: "task_graph",
    payload: {
      schemaVersion: "butler.btcc-task-graph.v1",
      tasks: [{
        reviewCriterionIds: expect.arrayContaining(["translation-complete"]),
      }],
    },
  });
  const receipts = beforeDelivery?.acceptedReceiptRefs
    .map((receiptRef) => phases.readPhaseReceipt(receiptRef)) ?? [];
  expect(receipts.map((receipt) => receipt?.phase)).toEqual([
    "conception",
    "planning",
    "execution",
    "review",
    "consolidation",
    "reporting",
  ]);
  expect(receipts.at(-1)?.payload).toMatchObject({
    learningProjectionMode: "async_from_terminal_receipt",
    learningSourceGuardReceiptRefs: [expect.stringContaining("artifact:report_guard_receipt:")],
  });
  admission.admitFinalAssistant(result.text, "outbound:turn-btcc-cycle");
  admission.finalize("complete", new Date().toISOString());
  expect(phases.readPhaseState("turn-btcc-cycle")).toMatchObject({
    currentPhase: "reporting",
    lifecycleStatus: "delivered",
  });

  phases.close();
  conversations.close();
});

test("Conception checkpoints a typed read-only observation before finalizing intent", async () => {
  const conversations = new AgentConversationStore({ butlerData: data });
  const phases = new BtccPhaseStore({ butlerData: data });
  const turnId = "turn-btcc-conception-observation";
  const envelope = inbound(turnId, "현재 저장소의 패키지 이름을 확인해서 알려줘.");
  const binding = storedBinding();
  const admission = ConversationAdmissionTurn.begin({
    writer: conversations,
    binding,
    envelope,
    turnId,
    timestamp: envelope.message.timestamp,
    butlerData: data,
    btccInterruptionStateWriter: phases,
  });
  admission.admitInbound();
  const provenance = admission.provenance();
  expect(provenance).not.toBeNull();

  let conceptionCalls = 0;
  let observationTools: string[] = [];
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => {
      const phase = input.usageAttribution?.phase ?? "unknown";
      if (phase === "typed_turn_decision") {
        conceptionCalls += 1;
        const decision = conceptionDecision(input.responseFormat);
        if (conceptionCalls === 1) {
          decision.action = "inspect";
          decision.answer_text = null;
          decision.inspection_scope = "workspace";
          decision.deliverables = ["status_report"];
          const candidate = decision.goal_contract_candidate as Record<string, unknown>;
          candidate.intent_grounding_observation = {
            evidence_need_id: "package-name",
            goal_field: "referent",
            question: "What package name is declared by the current workspace?",
            why_material: "The answer must refer to the actual workspace package.",
            source_scope_refs: ["workspace"],
            expected_resolution: "Observe the package manifest name field.",
          };
        }
        return JSON.stringify(decision);
      }
      return successfulBtccResponse(phase, input.prompt, input.responseFormat);
    },
    runFunctionToolPromptText: async (input) => {
      observationTools = input.tools.map((tool) => tool.name);
      expect(input.handoffAfterToolBatch).toBe(true);
      expect(observationTools).toContain("read_file");
      expect(observationTools).not.toContain("write_file");
      expect(observationTools).not.toContain("update_todo_list");
      const args = { path: "package.json" };
      await input.onAssistantTextBeforeTools?.({
        text: "패키지 선언을 확인하고 있습니다.",
        toolCalls: [{ name: "read_file", args }],
      });
      await input.executeTool({
        name: "read_file",
        args,
        rawArguments: JSON.stringify(args),
      });
      return "The workspace package name is butler.";
    },
    executeButlerTool: async () => ({
      ok: true,
      path: "package.json",
      content: "{\"name\":\"butler\"}",
      evidence_capability_receipts: [createEvidenceCapabilityReceipt({
        producer: { kind: "tool", name: "read_file" },
        capability: "source_verified",
        evidence_kind: "workspace_inspection",
        summary: "The package manifest was read.",
      })],
    }),
  });
  const handle = await runtime.createSession({
    sessionId: binding.sessionId,
    role: "butler",
    workspacePath: binding.workspacePath,
    systemPrompt: "Answer accurately and concisely.",
  });
  const result = await runtime.runTurn({
    handle,
    provider,
    model: "openai/gpt-5.5",
    input: envelope,
    metadata: {
      turnId,
      currentUserText: envelope.message.text,
      conversationProvenance: provenance,
      executionControls: envelope.executionControls,
      runtimePolicy: { completionReview: "disabled" },
    },
  });

  expect(result.text).toBe("Structure shapes behavior.");
  expect(conceptionCalls).toBe(2);
  expect(observationTools.length).toBeGreaterThan(0);
  const state = phases.readPhaseState(turnId);
  const goal = state?.goalContractRef ? phases.readGoalContract(state.goalContractRef) : null;
  expect(goal?.semanticAuthorityRefs).toEqual(
    expect.arrayContaining([expect.stringContaining("conception-observation:")]),
  );
  const finalCheckpoint = state?.activeConceptionCheckpointRef
    ? phases.readConceptionCheckpoint(state.activeConceptionCheckpointRef)
    : null;
  expect(finalCheckpoint).toMatchObject({
    status: "finalized",
    roundIndex: 2,
    observationRefs: expect.arrayContaining([expect.stringContaining("conception-observation:")]),
  });

  phases.close();
  conversations.close();
});

test("Review and Consolidation return typed defects to their exact owners without failure", async () => {
  const conversations = new AgentConversationStore({ butlerData: data });
  const phases = new BtccPhaseStore({ butlerData: data });
  const turnId = "turn-btcc-exact-return-owner";
  const envelope = inbound(turnId, "이 문장을 영어로 번역해줘: 구조가 행동을 만든다.");
  const binding = storedBinding();
  const admission = ConversationAdmissionTurn.begin({
    writer: conversations,
    binding,
    envelope,
    turnId,
    timestamp: envelope.message.timestamp,
    butlerData: data,
    btccInterruptionStateWriter: phases,
  });
  admission.admitInbound();
  const provenance = admission.provenance();
  let planningCalls = 0;
  let reviewCalls = 0;
  let consolidationCalls = 0;
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => {
      const phase = input.usageAttribution?.phase ?? "unknown";
      if (phase === "btcc_planning_synthesis") planningCalls += 1;
      if (phase === "btcc_review") {
        reviewCalls += 1;
        if (reviewCalls === 1) return reviewReturnTicket(input.prompt, "planning");
      }
      if (phase === "btcc_consolidation") {
        consolidationCalls += 1;
        if (consolidationCalls === 1) return consolidationReturnTicket(input.prompt);
      }
      if (phase === "btcc_execution_repair" ||
        phase === "btcc_execution_consolidation_repair") {
        return "Structure shapes behavior.";
      }
      return successfulBtccResponse(phase, input.prompt, input.responseFormat);
    },
    runFunctionToolPromptText: async () => {
      throw new Error("direct_answer_repair_must_not_use_tools");
    },
  });
  const handle = await runtime.createSession({
    sessionId: binding.sessionId,
    role: "butler",
    workspacePath: binding.workspacePath,
    systemPrompt: "Answer accurately and concisely.",
  });
  const result = await runtime.runTurn({
    handle,
    provider,
    model: "openai/gpt-5.5",
    input: envelope,
    metadata: {
      turnId,
      currentUserText: envelope.message.text,
      conversationProvenance: provenance,
      executionControls: envelope.executionControls,
      runtimePolicy: { completionReview: "disabled" },
    },
  });

  expect(result.text).toBe("Structure shapes behavior.");
  expect(planningCalls).toBe(2);
  expect(reviewCalls).toBe(3);
  expect(consolidationCalls).toBe(2);
  const state = phases.readPhaseState(turnId);
  expect(state).toMatchObject({ currentPhase: "reporting", lifecycleStatus: "active" });
  expect(state?.invalidatedReceiptRefs.length).toBeGreaterThan(0);
  expect(JSON.stringify(state)).not.toContain('"failed"');

  phases.close();
  conversations.close();
});

test("a restarted call resumes from the persisted BTCC owner without replaying Conception", async () => {
  const conversations = new AgentConversationStore({ butlerData: data });
  const phases = new BtccPhaseStore({ butlerData: data });
  const envelope = inbound("turn-btcc-resume", "이 문장을 영어로 번역해줘: 구조가 행동을 만든다.");
  const binding = storedBinding();
  const admission = ConversationAdmissionTurn.begin({
    writer: conversations,
    binding,
    envelope,
    turnId: "turn-btcc-resume",
    timestamp: envelope.message.timestamp,
    butlerData: data,
    btccInterruptionStateWriter: phases,
  });
  admission.admitInbound();
  const provenance = admission.provenance();
  expect(provenance).not.toBeNull();

  const calls: string[] = [];
  let interruptReview = true;
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => {
      const phase = input.usageAttribution?.phase ?? "unknown";
      calls.push(phase);
      if (phase === "btcc_review" && interruptReview) {
        interruptReview = false;
        throw new Error("simulated_runtime_restart");
      }
      return successfulBtccResponse(phase, input.prompt, input.responseFormat);
    },
    runFunctionToolPromptText: async () => {
      throw new Error("direct_answer_must_not_enter_tool_execution");
    },
  });
  const handle = await runtime.createSession({
    sessionId: binding.sessionId,
    role: "butler",
    workspacePath: binding.workspacePath,
    systemPrompt: "Answer accurately and concisely.",
  });
  const turnInput = {
    handle,
    provider,
    model: "openai/gpt-5.5",
    input: envelope,
    metadata: {
      turnId: "turn-btcc-resume",
      currentUserText: envelope.message.text,
      conversationProvenance: provenance,
      executionControls: envelope.executionControls,
      runtimePolicy: { completionReview: "disabled" },
    },
  } as const;
  await expect(runtime.runTurn(turnInput)).rejects.toThrow("simulated_runtime_restart");
  expect(phases.readPhaseState("turn-btcc-resume")).toMatchObject({
    currentPhase: "review",
    lifecycleStatus: "active",
  });
  expect(calls).toEqual(["typed_turn_decision", "btcc_planning_synthesis", "btcc_review"]);

  calls.splice(0, calls.length);
  const resumed = await runtime.runTurn(turnInput);
  expect(resumed.text).toBe("Structure shapes behavior.");
  expect(calls).toEqual([
    "btcc_review",
    "btcc_consolidation",
    "btcc_reporting_reporter",
    "btcc_reporting_guard",
  ]);
  expect(phases.readPhaseState("turn-btcc-resume")).toMatchObject({
    currentPhase: "reporting",
    lifecycleStatus: "active",
  });

  phases.close();
  conversations.close();
});

test("a restart at the final ReportGuard resumes Reporting without replaying upstream phases", async () => {
  const conversations = new AgentConversationStore({ butlerData: data });
  const phases = new BtccPhaseStore({ butlerData: data });
  const envelope = inbound("turn-btcc-report-resume", "이 문장을 영어로 번역해줘: 구조가 행동을 만든다.");
  const binding = storedBinding();
  const admission = ConversationAdmissionTurn.begin({
    writer: conversations,
    binding,
    envelope,
    turnId: "turn-btcc-report-resume",
    timestamp: envelope.message.timestamp,
    butlerData: data,
    btccInterruptionStateWriter: phases,
  });
  admission.admitInbound();
  const provenance = admission.provenance();
  expect(provenance).not.toBeNull();

  const calls: string[] = [];
  let interruptGuard = true;
  const runtime = new NativeToolLoopRuntime({
    butlerData: data,
    butlerHome: process.cwd(),
    disableAutomaticRecall: true,
    runPromptText: async (input) => {
      const phase = input.usageAttribution?.phase ?? "unknown";
      calls.push(phase);
      if (phase === "btcc_reporting_guard" && interruptGuard) {
        interruptGuard = false;
        throw new Error("simulated_report_guard_restart");
      }
      return successfulBtccResponse(phase, input.prompt, input.responseFormat);
    },
    runFunctionToolPromptText: async () => {
      throw new Error("direct_answer_must_not_enter_tool_execution");
    },
  });
  const handle = await runtime.createSession({
    sessionId: binding.sessionId,
    role: "butler",
    workspacePath: binding.workspacePath,
    systemPrompt: "Answer accurately and concisely.",
  });
  const turnInput = {
    handle,
    provider,
    model: "openai/gpt-5.5",
    input: envelope,
    metadata: {
      turnId: "turn-btcc-report-resume",
      currentUserText: envelope.message.text,
      conversationProvenance: provenance,
      executionControls: envelope.executionControls,
      runtimePolicy: { completionReview: "disabled" },
    },
  } as const;
  await expect(runtime.runTurn(turnInput)).rejects.toThrow("simulated_report_guard_restart");
  expect(phases.readPhaseState("turn-btcc-report-resume")).toMatchObject({
    currentPhase: "reporting",
    lifecycleStatus: "active",
  });

  calls.splice(0, calls.length);
  const resumed = await runtime.runTurn(turnInput);
  expect(resumed.text).toBe("Structure shapes behavior.");
  expect(calls).toEqual([
    "btcc_reporting_reporter",
    "btcc_reporting_guard",
  ]);
  const state = phases.readPhaseState("turn-btcc-report-resume");
  expect(state?.acceptedReceiptRefs).toHaveLength(6);
  expect(state?.acceptedReceiptRefs
    .map((ref) => phases.readPhaseReceipt(ref)?.phase)).toEqual([
      "conception",
      "planning",
      "execution",
      "review",
      "consolidation",
      "reporting",
    ]);

  phases.close();
  conversations.close();
});

function conceptionDecision(responseFormat: unknown): Record<string, unknown> {
  const decisionId = ((responseFormat as {
    schema?: { properties?: { decision_id?: { const?: string } } };
  })?.schema?.properties?.decision_id?.const) ?? "";
  return {
    schema_version: "butler.turn-contract-decision.v1",
    decision_id: decisionId,
    action: "answer",
    target_workstream_id: null,
    target_project_id: null,
    blocker_id: null,
    evidence_domain: null,
    inspection_scope: null,
    deliverables: [],
    continuity_updates: [],
    answer_text: "Structure shapes behavior.",
    public_title: "영문 번역",
    public_summary: "요청한 문장을 영어로 번역합니다.",
    public_rationale: "현재 메시지만으로 정확히 답할 수 있습니다.",
    immediate_next_step: null,
    goal_contract_candidate: {
      requested_outcome: "Translate the supplied Korean sentence into English.",
      problem_frame: "A turn-local direct answer requires no external state.",
      intent_understanding: {
        user_request: "Translate the supplied sentence into English.",
        related_context_refs: [],
        connected_knowledge_needs: [],
        user_preference_applications: [],
        expert_perspectives: ["professional Korean-English translation"],
        required_result: "One faithful English sentence.",
      },
      binding_constraints: ["Preserve the meaning and declarative tone."],
      non_goals: ["Do not add commentary."],
      acceptance_intents: [{
        key: "translation-complete",
        statement: "The English sentence preserves the Korean meaning.",
        evidence_class: "admitted_context",
      }],
      ambiguity_decisions: [],
      current_state_needs: [],
      evidence_needs: [],
      downstream_authority_needs: [],
      work_shape: {
        work_disposition: "direct_answer",
        custody: "same_turn",
        required_effects: [],
        deliverable_kinds: ["answer"],
        requires_current_state: false,
        requires_tools: false,
      },
      intent_grounding_observation: null,
    },
  };
}

function successfulBtccResponse(
  phase: string,
  prompt: string,
  responseFormat: unknown,
): string {
  if (phase === "typed_turn_decision") {
    return JSON.stringify(conceptionDecision(responseFormat));
  }
  if (phase === "btcc_planning_synthesis") {
    const capsule = capsuleObject(prompt, "## Planning Synthesis Capsule");
    const taskRefs = stringArrayValue(capsule.requiredTaskRefs);
    const criterionIds = stringArrayValue(capsule.expectedCriterionIds);
    const obligationRefs = stringArrayValue(capsule.expectedObligationRefs);
    const validationRefs = stringArrayValue(capsule.expectedValidationRefs);
    const goal = objectValue(capsule.goalContract);
    return JSON.stringify({
      tasks: taskRefs.map((task_ref, index) => ({
        task_ref,
        objective: "Deliver the requested translation.",
        status: "completed",
        phase: "execution",
        dependency_refs: index === 0 ? [] : [taskRefs[index - 1]],
        authority_refs: stringArrayValue(goal.semanticAuthorityRefs),
        required_effects: [],
        output_obligation_refs: index === taskRefs.length - 1 ? obligationRefs : [],
        validation_evidence_refs: index === taskRefs.length - 1 ? validationRefs : [],
        review_criterion_ids: criterionIds,
        repair_owner: "execution",
      })),
      coverage_matrix: criterionIds.map((criterion_id) => ({
        criterion_id,
        task_refs: taskRefs,
      })),
      integrated_validation: {
        required: validationRefs.length > 0,
        evidence_obligation_refs: validationRefs,
      },
    });
  }
  if (phase === "btcc_review") {
    const evidenceRef = capsuleRef(prompt, "executionCandidateRef");
    return JSON.stringify({
      outcome: "passed",
      summary: "The translation is complete and faithful.",
      criterion_verdicts: [{
        criterion_id: "translation-complete",
        status: "passed",
        evidence_refs: [evidenceRef],
      }],
      criterion_id: null,
      owner_phase: null,
      reason_code: null,
      required_change: null,
      evidence_refs: [evidenceRef],
    });
  }
  if (phase === "btcc_consolidation") {
    const evidenceRef = capsuleRef(prompt, "reviewCandidateRef");
    return JSON.stringify({
      schema_version: "butler.btcc-final-dossier.v1",
      outcome: "complete",
      summary: "The translation is supported by accepted review evidence.",
      owner_phase: null,
      reason_code: null,
      required_change: null,
      goal_coverage: [{
        criterion_id: "translation-complete",
        status: "passed",
        evidence_refs: [evidenceRef],
      }],
      delivered_items: ["English translation"],
      limitations: [],
      tracking_closeout: "Turn-local work is complete.",
      evidence_refs: [evidenceRef],
    });
  }
  if (phase === "btcc_reporting_reporter") {
    return JSON.stringify({
      report_text: "Structure shapes behavior.",
      reporting_item_refs: capsuleStringArray(prompt, "requiredReportingItemRefs"),
      evidence_refs: capsuleStringArray(prompt, "admittedEvidenceRefs"),
    });
  }
  if (phase === "btcc_reporting_guard") {
    return JSON.stringify({
      outcome: "passed",
      summary: "The report exactly delivers the requested translation.",
      reason_code: null,
      required_change: null,
      criterion_verdicts: [
        "factual_support",
        "requested_result_coverage",
        "safety",
        "clarity",
        "terminal_honesty",
        "tracking_closeout",
      ].map((criterion_id) => ({
        criterion_id,
        status: "passed",
        finding_code: null,
        required_change: null,
      })),
    });
  }
  throw new Error(`unexpected_btcc_phase:${phase}`);
}

function reviewReturnTicket(prompt: string, ownerPhase: "planning" | "execution"): string {
  const evidenceRef = capsuleRef(prompt, "executionCandidateRef");
  return JSON.stringify({
    outcome: "return_ticket",
    summary: "The accepted task graph does not bind the criterion precisely enough.",
    criterion_verdicts: [{
      criterion_id: "translation-complete",
      status: "failed",
      evidence_refs: [evidenceRef],
    }],
    criterion_id: "translation-complete",
    owner_phase: ownerPhase,
    reason_code: "task-criterion-binding-incomplete",
    required_change: "Bind the translation criterion explicitly to the execution task.",
    evidence_refs: [evidenceRef],
  });
}

function consolidationReturnTicket(prompt: string): string {
  const evidenceRef = capsuleRef(prompt, "reviewCandidateRef");
  return JSON.stringify({
    schema_version: "butler.btcc-final-dossier.v1",
    outcome: "return_ticket",
    summary: "The reviewed result still lacks execution evidence required for whole-goal closeout.",
    owner_phase: "execution",
    reason_code: "execution-evidence-incomplete",
    required_change: "Attach the missing execution evidence and resubmit the candidate.",
    goal_coverage: [{
      criterion_id: "translation-complete",
      status: "failed",
      evidence_refs: [evidenceRef],
    }],
    delivered_items: [],
    limitations: [],
    tracking_closeout: "Closeout is pending exact execution evidence.",
    evidence_refs: [evidenceRef],
  });
}

function capsuleRef(prompt: string, key: string): string {
  const marker = `"${key}":"`;
  const start = prompt.indexOf(marker);
  if (start < 0) throw new Error(`missing_capsule_ref:${key}`);
  const valueStart = start + marker.length;
  const end = prompt.indexOf('"', valueStart);
  if (end < 0) throw new Error(`invalid_capsule_ref:${key}`);
  return prompt.slice(valueStart, end);
}

function capsuleStringArray(prompt: string, key: string): string[] {
  const marker = `"${key}":`;
  const start = prompt.indexOf(marker);
  if (start < 0) throw new Error(`missing_capsule_array:${key}`);
  const arrayStart = prompt.indexOf("[", start + marker.length);
  const arrayEnd = prompt.indexOf("]", arrayStart);
  if (arrayStart < 0 || arrayEnd < 0) throw new Error(`invalid_capsule_array:${key}`);
  const value: unknown = JSON.parse(prompt.slice(arrayStart, arrayEnd + 1));
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`invalid_capsule_array:${key}`);
  }
  return value;
}

function capsuleObject(prompt: string, heading: string): Record<string, unknown> {
  const start = prompt.indexOf(heading);
  const jsonStart = prompt.indexOf("{", start + heading.length);
  const lineEnd = prompt.indexOf("\n", jsonStart);
  if (start < 0 || jsonStart < 0) throw new Error(`missing_capsule:${heading}`);
  return objectValue(JSON.parse(prompt.slice(jsonStart, lineEnd < 0 ? undefined : lineEnd)));
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_capsule_object");
  }
  return value as Record<string, unknown>;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("invalid_capsule_string_array");
  }
  return value as string[];
}

function storedBinding(): StoredSessionBinding {
  return {
    sessionId: "butler/btcc-cycle",
    role: "butler",
    workspacePath: data,
    runtimeAdapterId: "native-tool-loop",
    modelProviderId: provider.id,
    modelRef: "openai/gpt-5.5",
    runtimeSessionRef: undefined,
    providerThreadRef: undefined,
    transportBindings: [{
      transport: "app",
      accountId: "local",
      peerId: "butler/btcc-cycle",
    }],
    lifecycleState: "active",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function inbound(turnId: string, text: string): InboundEnvelope {
  return {
    transport: "app",
    accountId: "local",
    eventId: `event:${turnId}`,
    peer: { kind: "dm", id: "butler/btcc-cycle" },
    sender: { id: "principal" },
    message: {
      id: `message:${turnId}`,
      text,
      timestamp: new Date().toISOString(),
    },
    routingHints: {
      sessionId: "butler/btcc-cycle",
      turnId,
    },
  };
}
