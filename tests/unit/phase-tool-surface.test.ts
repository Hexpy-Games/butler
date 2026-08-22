import { expect, test } from "bun:test";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import { selectGuidedTurnPhasePolicy } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-phase-policy.ts";
import { snapshotTurnContext } from
  "../../packages/butler-agent/src/agent/btcc/turn/prepare-turn.ts";
import { guidedInstructions, renderGuidedTurnRequestAttribution } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-prompt.ts";
import { phaseMinimalStableInstructions } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-phase-instructions.ts";
import { BUTLER_TOOLS } from
  "../../packages/butler-agent/src/agent/tools/registry.ts";
import { appRuntimePolicy } from
  "../../packages/butler-agent/src/gateways/app/domain/runtime/app-runtime-policy.ts";
import type { ContextAssembly } from
  "../../packages/butler-agent/src/agent/prompt/prompt-assembler.ts";
import type { StoredSessionBinding } from
  "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { modelFacingFunctionTools } from
  "../../packages/butler-agent/src/integrations/providers/shared/tools.ts";
import { guidedNativeToolDefinitions } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-policy.ts";
import { inheritedStewardRuntimePolicy } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/runtime-policy.ts";

const ENABLED = { BUTLER_PHASE_TOOL_SURFACE: "on" };

test("exact result tool is absent from every Guided selection while replay is off", () => {
  const turn = turnRecord({ accessMode: "full_access", trackingMode: "local" });
  const selected = selectGuidedTurnPhasePolicy(turn, ENABLED);
  expect(selected.authorizedTools.map((tool) => tool.name))
    .not.toContain("read_operation_results");
  expect(selected.providerTools.map((tool) => tool.name))
    .not.toContain("read_operation_results");
  expect(guidedNativeToolDefinitions().map((tool) => tool.name))
    .not.toContain("read_operation_results");
});

test("flag-off required exact result authority fails during phase selection", () => {
  const turn = turnRecord({ accessMode: "full_access", trackingMode: "local" });
  turn.context.executionPolicy!.requiredNativeTools = ["read_operation_results"];
  expect(() => selectGuidedTurnPhasePolicy(turn, ENABLED))
    .toThrow("required tool is unavailable while exact replay is disabled");
});

test("flag-on Guided selection uses the one canonical exact result registry identity", () => {
  const selected = selectGuidedTurnPhasePolicy(
    turnRecord({ accessMode: "full_access", trackingMode: "local" }),
    { ...ENABLED, BUTLER_OPERATION_RESULT_REPLAY: "on" },
  );
  const canonical = BUTLER_TOOLS.find((tool) => tool.name === "read_operation_results");
  expect(canonical).toBeDefined();
  expect(selected.authorizedTools.find((tool) => tool.name === canonical!.name))
    .toEqual(canonical);
  expect(guidedNativeToolDefinitions(true).filter((tool) =>
    tool.name === "read_operation_results",
  )).toHaveLength(1);
});

test("feature direct phase omits project, workspace, Work, and execution schemas", () => {
  const selection = selectGuidedTurnPhasePolicy(turnRecord({ trackingMode: "none" }), ENABLED);
  const names = selection.providerTools.map((tool) => tool.name);

  expect(selection.phase).toBe("direct");
  expect(selection.policyRevision).toBe("butler.btcc-tool-instruction-policy.v1");
  expect(names).toContain("web_search");
  expect(names).toContain("recall_memory");
  for (const name of [
    "run_command",
    "read_file",
    "write_file",
    "edit_file",
    "grep_files",
    "list_files",
    "project_ledger_status",
    "replace_work_plan",
    "record_work_checkpoint",
    "record_work_review",
  ]) expect(names).not.toContain(name);
});

test("ordinary chat keeps greetings direct but admits delegation for substantial revision work", () => {
  const greeting = turnRecord({
    accessMode: "full_access",
    trackingMode: "none",
    originalMessage: "안녕하세요!",
  });
  const revision = turnRecord({
    accessMode: "full_access",
    trackingMode: "none",
    originalMessage: "직전 답변의 요구사항을 모두 보존해서 문서 전체를 다시 수정해줘.",
  });

  const greetingSelection = selectGuidedTurnPhasePolicy(greeting, ENABLED);
  const revisionSelection = selectGuidedTurnPhasePolicy(revision, ENABLED);

  expect(greetingSelection.phase).toBe("direct");
  expect(greetingSelection.providerTools.map((tool) => tool.name))
    .not.toContain("delegate_to_steward");
  expect(revisionSelection.phase).toBe("execution");
  expect(revisionSelection.providerTools.map((tool) => tool.name))
    .toContain("delegate_to_steward");
  expect(revisionSelection.stableInstructionPrefix).toContain(
    "Substantial writing, revision, research, comparison, inspection, or execution belongs to Steward",
  );
});

test("feature read-only phase omits write and effect schemas", () => {
  const selection = selectGuidedTurnPhasePolicy(turnRecord({
    accessMode: "read_only",
    trackingMode: "ledger",
    projectRef: "butler",
  }), ENABLED);
  const names = selection.providerTools.map((tool) => tool.name);

  expect(selection.phase).toBe("read_only");
  for (const name of ["read_file", "grep_files", "list_files", "project_ledger_status"]) {
    expect(names).toContain(name);
  }
  for (const name of [
    "run_command",
    "write_file",
    "edit_file",
    "bind_session_git_worktree",
    "project_ledger_create",
    "project_ledger_work_complete",
    "replace_work_plan",
    "record_work_checkpoint",
    "record_work_review",
  ]) expect(names).not.toContain(name);
});

test("feature fails closed when phase projection cannot retain an admitted required tool", () => {
  const turn = turnRecord({ trackingMode: "none" });
  turn.context.executionPolicy!.requiredNativeTools = ["project_ledger_status"];

  expect(() => selectGuidedTurnPhasePolicy(turn, ENABLED))
    .toThrow("required tool is ineligible for direct phase: project_ledger_status");
});

test("feature execution keeps an admitted exact required tool in final provider schemas", () => {
  const turn = turnRecord({
    accessMode: "full_access",
    trackingMode: "ledger",
    projectRef: "butler",
  });
  turn.context.executionPolicy!.requiredNativeTools = ["transform_public_data_table"];

  const selection = selectGuidedTurnPhasePolicy(turn, ENABLED);
  expect(selection.providerTools.map((tool) => tool.name))
    .toContain("transform_public_data_table");
});

test("feature execution keeps admitted MCP profile reads in final provider schemas", () => {
  const turn = turnRecord({
    accessMode: "full_access",
    trackingMode: "ledger",
    projectRef: "butler",
  });
  turn.context.executionPolicy!.requiredNativeToolProfiles = ["mcp"];

  const selection = selectGuidedTurnPhasePolicy(turn, ENABLED);
  const names = selection.providerTools.map((tool) => tool.name);
  expect(names).toContain("list_mcp_capabilities");
  expect(names).toContain("read_mcp_resource");
  expect(names).toContain("call_mcp_tool");
});

test("feature execution keeps admitted memory-read profile tools in final provider schemas", () => {
  const turn = turnRecord({
    accessMode: "full_access",
    trackingMode: "ledger",
    projectRef: "butler",
  });
  turn.context.executionPolicy!.requiredNativeToolProfiles = ["memory-read"];

  const names = selectGuidedTurnPhasePolicy(turn, ENABLED)
    .providerTools.map((tool) => tool.name);
  expect(names).toContain("query_memory");
  expect(names).toContain("read_conversation_context");
});

test("feature fails closed for an unknown admitted required profile", () => {
  const turn = turnRecord({
    accessMode: "full_access",
    trackingMode: "ledger",
    projectRef: "butler",
  });
  turn.context.executionPolicy!.requiredNativeToolProfiles = ["not-a-real-profile"];

  expect(() => selectGuidedTurnPhasePolicy(turn, ENABLED))
    .toThrow("unknown required tool profile: not-a-real-profile");
});

test("feature direct rejects the MCP profile after it gains an effect capability", () => {
  const turn = turnRecord({ accessMode: "read_only", trackingMode: "none" });
  turn.context.executionPolicy!.requiredNativeToolProfiles = ["mcp"];

  expect(() => selectGuidedTurnPhasePolicy(turn, ENABLED))
    .toThrow("required tool profile is ineligible for direct phase: mcp");
});

test("feature direct admits only non-effect automation profile reads", () => {
  const turn = turnRecord({ trackingMode: "none" });
  turn.context.executionPolicy!.requiredNativeToolProfiles = ["automation"];

  const names = selectGuidedTurnPhasePolicy(turn, ENABLED)
    .providerTools.map((tool) => tool.name);
  expect(names).toContain("list_automations");
  expect(names).not.toContain("create_automation");
  expect(names).not.toContain("delete_automation");
  expect(names).not.toContain("run_due_automations");
});

test("feature direct rejects memory-write profile authority", () => {
  const turn = turnRecord({ trackingMode: "none" });
  turn.context.executionPolicy!.requiredNativeToolProfiles = ["memory-write"];

  expect(() => selectGuidedTurnPhasePolicy(turn, ENABLED))
    .toThrow("required tool profile is ineligible for direct phase: memory-write");
});

test("feature read-only rejects a mixed memory-write profile before projection", () => {
  const turn = turnRecord({
    accessMode: "read_only",
    trackingMode: "ledger",
    projectRef: "butler",
  });
  turn.context.executionPolicy!.requiredNativeToolProfiles = [
    "project",
    "memory-write",
  ];

  expect(() => selectGuidedTurnPhasePolicy(turn, ENABLED))
    .toThrow("required tool profile is ineligible for read_only phase: memory-write");
});

test("feature rejects a required profile when its phase projection would be partial", () => {
  const turn = turnRecord({
    accessMode: "read_only",
    trackingMode: "ledger",
    projectRef: "butler",
  });
  turn.context.executionPolicy!.requiredNativeToolProfiles = ["workspace"];

  expect(() => selectGuidedTurnPhasePolicy(turn, ENABLED))
    .toThrow("required tool profile is ineligible for read_only phase: workspace");
});

test("feature accepts the real writable App project profile set with a reduced schema", () => {
  const runtimePolicy = appRuntimePolicy({
    accessMode: "full_access",
    projectId: "butler",
    sessionKind: "project",
  });
  const context = snapshotTurnContext({
    binding: appProjectBinding(runtimePolicy),
    assembly: emptyAssembly(),
    documents: { persist: () => "unused-context-ref" },
    turnAccessMode: "full_access",
  });
  const turn = turnRecord({
    accessMode: "full_access",
    trackingMode: "ledger",
    projectRef: "butler",
  });
  turn.context = { ...turn.context, ...context };

  const legacy = selectGuidedTurnPhasePolicy(turn, {});
  const enabled = selectGuidedTurnPhasePolicy(turn, ENABLED);
  const names = enabled.providerTools.map((tool) => tool.name);
  expect(names).toContain("project_ledger_status");
  expect(names).not.toContain("project_ledger_work_complete");
  expect(names).not.toContain("project_ledger_attempt_start");
  expect(enabled.authorizedTools.map((tool) => tool.name))
    .toContain("project_ledger_work_complete");
  expect(names).toContain("tool_search");
  expect(names).toContain("tool_describe");
  expect(names).toContain("tool_call");
  expect(byteLength(JSON.stringify(modelFacingFunctionTools(enabled.providerTools))))
    .toBeLessThan(byteLength(JSON.stringify(modelFacingFunctionTools(legacy.providerTools))));
});

test("feature treats real full-access App chat workspace authority as execution", () => {
  const runtimePolicy = appRuntimePolicy({
    accessMode: "full_access",
    sessionKind: "chat",
  });
  const context = snapshotTurnContext({
    binding: appChatBinding(runtimePolicy),
    assembly: emptyAssembly(),
    documents: { persist: () => "unused-context-ref" },
    turnAccessMode: "full_access",
  });
  const turn = turnRecord({ accessMode: "full_access", trackingMode: "local" });
  turn.context = { ...turn.context, ...context };

  const legacy = selectGuidedTurnPhasePolicy(turn, {});
  const enabled = selectGuidedTurnPhasePolicy(turn, ENABLED);
  const names = enabled.providerTools.map((tool) => tool.name);
  expect(enabled.phase).toBe("execution");
  expect(names).toContain("read_file");
  expect(names).toContain("run_command");
  expect(names).not.toContain("project_ledger_status");
  expect(byteLength(enabled.stableInstructionPrefix) +
    byteLength(JSON.stringify(modelFacingFunctionTools(enabled.providerTools))))
    .toBeLessThan(byteLength(legacy.stableInstructionPrefix) +
      byteLength(JSON.stringify(modelFacingFunctionTools(legacy.providerTools))));
});

test("feature policy serializes byte-identical schemas and stable prefix for the same revision", () => {
  const turn = turnRecord({
    accessMode: "full_access",
    trackingMode: "ledger",
    projectRef: "butler",
  });
  const first = selectGuidedTurnPhasePolicy(turn, ENABLED);
  const second = selectGuidedTurnPhasePolicy({ ...turn, turnId: "another-turn" }, ENABLED);

  expect(first.phase).toBe("execution");
  expect(first.stableInstructionPrefix).toBe(second.stableInstructionPrefix);
  expect(JSON.stringify(modelFacingFunctionTools(first.providerTools)))
    .toBe(JSON.stringify(modelFacingFunctionTools(second.providerTools)));
});

test("feature selected stable prefix is the prefix of the real guided provider instructions", () => {
  const turn = turnRecord({
    accessMode: "read_only",
    trackingMode: "ledger",
    projectRef: "butler",
  });
  const selection = selectGuidedTurnPhasePolicy(turn, ENABLED);
  const request = renderGuidedTurnRequestAttribution(
    turn,
    selection.stableInstructionPrefix,
    "Korean",
    {
      butlerData: "/tmp/butler-data",
      contextDocuments: { resolve: () => "" },
      toolJournal: { list: () => [] } as never,
    },
  );

  expect(request.instructions.startsWith(selection.stableInstructionPrefix)).toBe(true);
  expect(request.instructions).toContain("Use Korean for every user-facing message");
  expect(request.requestSegmentSources.instructions[0]?.text)
    .toBe(selection.stableInstructionPrefix.split("\n", 1)[0] + "\n");
});

test("SS-03B phase instructions define semantic delegation selection", () => {
  const policy = {
    role: "butler" as const,
    trackingMode: "ledger" as const,
    subsession: undefined,
  };

  for (const phase of ["read_only", "execution"] as const) {
    const instructions = phaseMinimalStableInstructions(phase, policy);

    expect(instructions).toContain(
      "Select the path from the user's complete objective and constraints.",
    );
    expect(instructions).toContain(
      "Keep simple conversation, stable knowledge, and one quick lookup in Butler.",
    );
    expect(instructions).toContain(
      "Delegate bounded independent multi-step repository inspection, multi-source research or synthesis, persistent-artifact work, or execution-stage mutation with delegate_to_steward.",
    );
    expect(instructions).toContain(
      "Honor explicit user direction to delegate. Do not override the substantial-work boundary by keeping that work in Butler.",
    );
    expect(instructions).toContain(
      "After calling delegate_to_steward, release this Turn; do not inspect or mutate the same objective before the later synthesis Turn.",
    );
    expect(instructions).toContain(
      "Before starting, continuing, planning, or checkpointing Work, or using inspection or effect tools, choose the direct-versus-delegate path. When the semantic delegation boundary applies, make delegate_to_steward the first and only tool call in this Turn; this delegation rule takes precedence over Butler Work rules below, and Butler must not create, plan, or update Work for that delegated objective.",
    );
    expect(instructions).toContain(
      "When the user corrects, extends, or redirects work that still has an active Steward relation, call steer_steward as the first and only tool so the same Steward and Work continue at the next safe boundary; never create a replacement relation. When the user asks to stop active delegated work, call cancel_steward as the first and only tool. If several Steward relations are active, select the exact relation_id or safe_title and fail closed when the target is ambiguous. Only after the prior relation is terminal may a substantial retry create a fresh delegate_to_steward relation. Do not inspect, plan, resume Work, or execute that delegated objective in Butler.",
    );
  }
});

test("Steward keeps ordinary BTCC authority while read-only still omits effects", () => {
  const readOnlyTurn = stewardTurnRecord("read_only");
  for (const env of [{}, ENABLED]) {
    const selection = selectGuidedTurnPhasePolicy(readOnlyTurn, env);
    const actionSchema = planActionSchema(selection.providerTools);
    expect(planActionsSchema(selection.providerTools).minItems).toBe(2);
    expect(actionSchema.properties).not.toHaveProperty("effect");
    expect(actionSchema.required ?? []).not.toContain("effect");
  }

  const mutationActionSchema = planActionSchema(
    selectGuidedTurnPhasePolicy(stewardTurnRecord("mutation"), ENABLED).providerTools,
  );
  const butlerActionSchema = planActionSchema(
    selectGuidedTurnPhasePolicy(
      turnRecord({
        accessMode: "full_access",
        trackingMode: "ledger",
        projectRef: "butler",
      }),
      ENABLED,
    ).providerTools,
  );
  expect(planActionsSchema(
    selectGuidedTurnPhasePolicy(stewardTurnRecord("mutation"), ENABLED).providerTools,
  ).minItems).toBe(planActionsSchema(
    selectGuidedTurnPhasePolicy(
      turnRecord({
        accessMode: "full_access",
        trackingMode: "ledger",
        projectRef: "butler",
      }),
      ENABLED,
    ).providerTools,
  ).minItems);
  expect(mutationActionSchema.properties).toHaveProperty("effect");
  expect(mutationActionSchema.properties.effect).toEqual(
    butlerActionSchema.properties.effect,
  );

  expect(butlerActionSchema.properties).toHaveProperty("effect");
  expect(planActionsSchema(
    selectGuidedTurnPhasePolicy(
      turnRecord({
        accessMode: "full_access",
        trackingMode: "ledger",
        projectRef: "butler",
      }),
      ENABLED,
    ).providerTools,
  ).minItems).not.toBe(2);

  const mutationSelection = selectGuidedTurnPhasePolicy(
    stewardTurnRecord("mutation"),
    ENABLED,
  );
  const mutationNames = mutationSelection.providerTools.map((tool) => tool.name);
  for (const name of [
    "recall_memory",
    "query_memory",
    "list_conversation_sessions",
    "read_conversation_session",
    "list_mcp_capabilities",
    "read_mcp_resource",
    "call_mcp_tool",
    "project_ledger_status",
    "run_command",
    "replace_work_plan",
    "record_work_disposition",
  ]) expect(mutationNames).toContain(name);
});

test("read-only Steward inherits every safe parent capability instead of a role whitelist", () => {
  const parent = appProjectBinding({
    accessMode: "full_access",
    trackingMode: "ledger",
    requiredNativeToolProfiles: [
      "project",
      "memory-read",
      "mcp",
      "workspace",
      "automation",
    ],
    requiredNativeTools: ["read_tool_evidence_artifact", "write_file"],
  });
  const inherited = inheritedStewardRuntimePolicy(parent, "read_only");

  expect(inherited.requiredNativeToolProfiles).toEqual(["project", "memory-read"]);
  expect(inherited.requiredNativeTools).toEqual(expect.arrayContaining([
    "grep_files",
    "list_automations",
    "list_files",
    "list_mcp_capabilities",
    "read_file",
    "read_mcp_resource",
    "read_tool_evidence_artifact",
    "read_tool_output_artifact",
  ]));
  for (const effectful of [
    "call_mcp_tool",
    "create_automation",
    "run_command",
    "write_file",
  ]) expect(inherited.requiredNativeTools).not.toContain(effectful);
});

test("feature default-off path preserves legacy bytes and enabled policy reduces both stable and schema bytes", () => {
  const turn = turnRecord({
    accessMode: "full_access",
    trackingMode: "ledger",
    projectRef: "butler",
  });
  const legacy = selectGuidedTurnPhasePolicy(turn, {});
  const enabled = selectGuidedTurnPhasePolicy(turn, ENABLED);
  const legacySchemas = JSON.stringify(modelFacingFunctionTools(legacy.providerTools));
  const enabledSchemas = JSON.stringify(modelFacingFunctionTools(enabled.providerTools));

  expect(legacy.mode).toBe("legacy");
  expect(legacy.stableInstructionPrefix).toContain("Work stages guide process, never tool access");
  expect(enabled.mode).toBe("phase_minimal");
  expect(enabled.stableInstructionPrefix).toContain(
    "settle the bound Work atomically with record_work_disposition",
  );
  expect(enabled.stableInstructionPrefix).toContain(
    "Reviews and completion Validation are optional quality records",
  );
  expect(enabled.stableInstructionPrefix).not.toContain(
    "required accepted Plan Review",
  );
  expect(enabled.stableInstructionPrefix.length).toBeLessThan(legacy.stableInstructionPrefix.length);
  expect(enabledSchemas.length).toBeLessThan(legacySchemas.length);
});

test("feature flag-off request assembly is byte-identical to canonical legacy instructions", () => {
  const turn = turnRecord({ trackingMode: "none" });
  turn.context.profileRefs = ["profile:test"];
  const selection = selectGuidedTurnPhasePolicy(turn, {});
  const request = renderGuidedTurnRequestAttribution(
    turn,
    selection.stableInstructionPrefix,
    "Korean",
    {
      butlerData: "/tmp/butler-data",
      contextDocuments: { resolve: () => "Current persona" },
      toolJournal: { list: () => [] } as never,
    },
  );

  expect(request.instructions).toBe(guidedInstructions(
    selection.executionPolicy,
    "Current persona",
    "Korean",
  ));
});

test("feature serializer bytes decrease for direct, read-only, and execution phases", () => {
  const turns = [
    turnRecord({ trackingMode: "none" }),
    turnRecord({ accessMode: "read_only", trackingMode: "ledger", projectRef: "butler" }),
    turnRecord({ accessMode: "full_access", trackingMode: "ledger", projectRef: "butler" }),
  ];

  for (const turn of turns) {
    const before = selectGuidedTurnPhasePolicy(turn, {});
    const after = selectGuidedTurnPhasePolicy(turn, ENABLED);
    const beforeSchemaBytes = byteLength(JSON.stringify(modelFacingFunctionTools(before.providerTools)));
    const afterSchemaBytes = byteLength(JSON.stringify(modelFacingFunctionTools(after.providerTools)));
    const beforeStableBytes = byteLength(before.stableInstructionPrefix);
    const afterStableBytes = byteLength(after.stableInstructionPrefix);

    expect(afterSchemaBytes).toBeLessThan(beforeSchemaBytes);
    expect(afterStableBytes).toBeLessThan(beforeStableBytes);
    expect((beforeSchemaBytes + beforeStableBytes) -
      (afterSchemaBytes + afterStableBytes)).toBeGreaterThan(0);
  }
});

test("feature admitted tools retain the existing native registry authority", () => {
  const selection = selectGuidedTurnPhasePolicy(turnRecord({
    accessMode: "read_only",
    trackingMode: "ledger",
    projectRef: "butler",
  }), ENABLED);
  const selected = selection.authorizedTools.find((tool) => tool.name === "list_files");
  const registered = BUTLER_TOOLS.find((tool) => tool.name === "list_files");

  expect(selected).toBe(registered);
});

function turnRecord(options: {
  accessMode?: "read_only" | "ask_first" | "full_access";
  trackingMode?: "ledger" | "local" | "none";
  projectRef?: string;
  workspacePath?: string;
  originalMessage?: string;
} = {}): TurnRecord {
  const accessMode = options.accessMode ?? "read_only";
  const trackingMode = options.trackingMode ?? "local";
  const workspacePath = options.workspacePath ?? "/tmp/workspace";
  return {
    turnId: "turn-feature-tool-surface",
    sessionId: "session-feature-tool-surface",
    inboxId: "inbox-feature-tool-surface",
    triggerKey: "trigger-feature-tool-surface",
    originalMessageId: "message-feature-tool-surface",
    originalMessage: options.originalMessage ?? "Please help",
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      controls: { accessMode },
      controlsHash: "controls",
    },
    context: {
      userRef: "local-user",
      ...(options.projectRef ? { projectRef: options.projectRef } : {}),
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [`workspace:${workspacePath}`],
      executionPolicy: {
        role: "butler",
        accessMode,
        trackingMode,
        requiredNativeToolProfiles: [],
        requiredNativeTools: [],
        workspacePath,
        ...(options.projectRef ? { projectId: options.projectRef } : {}),
      },
    },
    semanticState: "admitted",
    revision: 0,
    executionFence: 0,
  };
}

function stewardTurnRecord(executionMode: "read_only" | "mutation"): TurnRecord {
  const turn = turnRecord({
    accessMode: executionMode === "read_only" ? "read_only" : "full_access",
    trackingMode: "ledger",
    projectRef: "butler",
  });
  turn.context.executionPolicy = {
    ...turn.context.executionPolicy!,
    role: "steward",
    requiredNativeToolProfiles: executionMode === "mutation"
      ? ["workspace", "project", "project-lifecycle", "mcp", "memory-read"]
      : ["project", "memory-read"],
    subsession: {
      relationId: "relation-phase-surface",
      delegationId: "delegation-phase-surface",
      taskId: "task-phase-surface",
      executionMode,
      mutationScope: executionMode === "mutation" ? ["bounded-result.txt"] : [],
      allowedToolsAndEffects: executionMode === "mutation"
        ? ["write_file:workspace"]
        : [
            "grep_files:workspace",
            "list_files:workspace",
            "read_file:workspace",
            "web_read:network",
            "web_search:network",
          ],
    },
  };
  return turn;
}

function planActionSchema(tools: readonly { name: string; parameters: Record<string, unknown> }[]) {
  const actions = planActionsSchema(tools);
  expect(actions.items).toBeDefined();
  return actions.items!;
}

function planActionsSchema(tools: readonly { name: string; parameters: Record<string, unknown> }[]) {
  const plan = tools.find((tool) => tool.name === "replace_work_plan");
  expect(plan).toBeDefined();
  const properties = plan!.parameters.properties as {
    actions?: { items?: Record<string, any>; minItems?: number };
  };
  expect(properties.actions).toBeDefined();
  return properties.actions!;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function appProjectBinding(runtimePolicy: Record<string, unknown>): StoredSessionBinding {
  const timestamp = new Date(0).toISOString();
  return {
    sessionId: "session-feature-tool-surface",
    role: "butler",
    projectId: "butler",
    workspacePath: "/tmp/workspace",
    runtimeAdapterId: "codex-api",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    transportBindings: [],
    metadata: { userRef: "user-1", runtimePolicy },
    lifecycleState: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function appChatBinding(runtimePolicy: Record<string, unknown>): StoredSessionBinding {
  return {
    ...appProjectBinding(runtimePolicy),
    projectId: undefined,
  };
}

function emptyAssembly(): ContextAssembly {
  return {
    staticContext: [],
    liveConfiguration: [],
    runtimeState: [],
    workingContext: [],
    retrievedContext: [],
    currentInput: [],
    references: [],
    liveConfigHash: "empty",
  };
}
