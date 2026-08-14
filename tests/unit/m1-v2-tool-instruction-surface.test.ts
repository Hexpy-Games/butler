import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import { selectGuidedTurnPhasePolicy } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-phase-policy.ts";
import { snapshotTurnContext } from
  "../../packages/butler-agent/src/agent/btcc/turn/prepare-turn.ts";
import { guidedInstructions, renderGuidedTurnRequestAttribution } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-prompt.ts";
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
import { codexRequestBody } from
  "../../packages/butler-agent/src/integrations/providers/openai/responses-client.ts";
import { guidedNativeToolDefinitions } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-policy.ts";
import { buildBoundedTurnContext } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/bounded-turn-context.ts";
import type { ModelRoundMessage } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";

const ENABLED = { BUTLER_M1_V2_TOOL_INSTRUCTION_SURFACE: "on" };

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
    { ...ENABLED, BUTLER_M1_V2_EXACT_ONCE_REPLAY: "on" },
  );
  const canonical = BUTLER_TOOLS.find((tool) => tool.name === "read_operation_results");
  expect(canonical).toBeDefined();
  expect(selected.authorizedTools.find((tool) => tool.name === canonical!.name))
    .toEqual(canonical);
  expect(guidedNativeToolDefinitions(true).filter((tool) =>
    tool.name === "read_operation_results",
  )).toHaveLength(1);
});

test("M1 v2 direct phase omits project, workspace, Work, and execution schemas", () => {
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

test("M1 v2 read-only phase omits write and effect schemas", () => {
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

test("M1 v2 fails closed when phase projection cannot retain an admitted required tool", () => {
  const turn = turnRecord({ trackingMode: "none" });
  turn.context.executionPolicy!.requiredNativeTools = ["project_ledger_status"];

  expect(() => selectGuidedTurnPhasePolicy(turn, ENABLED))
    .toThrow("required tool is ineligible for direct phase: project_ledger_status");
});

test("M1 v2 execution keeps an admitted exact required tool in final provider schemas", () => {
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

test("M1 v2 exposes available authorized page preview only during execution", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-m1-preview-policy-"));
  const authFile = join(root, "local-agent-auth.json");
  writeFileSync(authFile, JSON.stringify({ token: "p".repeat(43) }));
  const available = {
    ...ENABLED,
    BUTLER_APP_LOCAL_PAGE_PREVIEW_URL: "http://127.0.0.1:29991/v1/preview",
    BUTLER_APP_LOCAL_AUTH_FILE: authFile,
  };
  try {
    const executionTurn = turnRecord({
      accessMode: "full_access",
      trackingMode: "local",
      workspacePath: "/tmp/workspace",
      originalMessage: "Build and inspect the responsive landing page preview",
    });
    executionTurn.context.executionPolicy!.requiredNativeToolProfiles = [
      "workspace",
    ];
    const execution = selectGuidedTurnPhasePolicy(executionTurn, available);
    const canonical = BUTLER_TOOLS.find((tool) =>
      tool.name === "inspect_workspace_page",
    );
    expect(execution.phase).toBe("execution");
    expect(execution.authorizedTools.find((tool) => tool.name === canonical?.name))
      .toBe(canonical);
    expect(execution.providerTools.map((tool) => tool.name))
      .toContain("inspect_workspace_page");

    const direct = selectGuidedTurnPhasePolicy(turnRecord({
      accessMode: "full_access",
      trackingMode: "none",
      workspacePath: "",
    }), available);
    expect(direct.phase).toBe("direct");
    expect(direct.authorizedTools.map((tool) => tool.name))
      .not.toContain("inspect_workspace_page");
    expect(direct.providerTools.map((tool) => tool.name))
      .not.toContain("inspect_workspace_page");

    const readOnly = selectGuidedTurnPhasePolicy(turnRecord({
      accessMode: "read_only",
      trackingMode: "ledger",
      projectRef: "butler",
    }), available);
    expect(readOnly.phase).toBe("read_only");
    expect(readOnly.authorizedTools.map((tool) => tool.name))
      .not.toContain("inspect_workspace_page");
    expect(readOnly.providerTools.map((tool) => tool.name))
      .not.toContain("inspect_workspace_page");

    const unavailableTurn = turnRecord({
      accessMode: "full_access",
      trackingMode: "local",
      workspacePath: "/tmp/workspace",
      originalMessage: "Build and inspect the responsive landing page preview",
    });
    unavailableTurn.context.executionPolicy!.requiredNativeToolProfiles = [
      "workspace",
    ];
    const unavailable = selectGuidedTurnPhasePolicy(unavailableTurn, ENABLED);
    expect(unavailable.phase).toBe("execution");
    expect(unavailable.authorizedTools.map((tool) => tool.name))
      .not.toContain("inspect_workspace_page");
    expect(unavailable.providerTools.map((tool) => tool.name))
      .not.toContain("inspect_workspace_page");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("M1 v2 execution keeps admitted MCP profile reads in final provider schemas", () => {
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
  expect(names).not.toContain("call_mcp_tool");
});

test("M1 v2 execution keeps admitted memory-read profile tools in final provider schemas", () => {
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

test("M1 v2 fails closed for an unknown admitted required profile", () => {
  const turn = turnRecord({
    accessMode: "full_access",
    trackingMode: "ledger",
    projectRef: "butler",
  });
  turn.context.executionPolicy!.requiredNativeToolProfiles = ["not-a-real-profile"];

  expect(() => selectGuidedTurnPhasePolicy(turn, ENABLED))
    .toThrow("unknown required tool profile: not-a-real-profile");
});

test("M1 v2 direct admits only non-effect MCP profile reads", () => {
  const turn = turnRecord({ trackingMode: "none" });
  turn.context.executionPolicy!.requiredNativeToolProfiles = ["mcp"];

  const names = selectGuidedTurnPhasePolicy(turn, ENABLED)
    .providerTools.map((tool) => tool.name);
  expect(names).toContain("list_mcp_capabilities");
  expect(names).toContain("read_mcp_resource");
  expect(names).not.toContain("call_mcp_tool");
});

test("M1 v2 direct admits only non-effect automation profile reads", () => {
  const turn = turnRecord({ trackingMode: "none" });
  turn.context.executionPolicy!.requiredNativeToolProfiles = ["automation"];

  const names = selectGuidedTurnPhasePolicy(turn, ENABLED)
    .providerTools.map((tool) => tool.name);
  expect(names).toContain("list_automations");
  expect(names).not.toContain("create_automation");
  expect(names).not.toContain("delete_automation");
  expect(names).not.toContain("run_due_automations");
});

test("M1 v2 direct rejects memory-write profile authority", () => {
  const turn = turnRecord({ trackingMode: "none" });
  turn.context.executionPolicy!.requiredNativeToolProfiles = ["memory-write"];

  expect(() => selectGuidedTurnPhasePolicy(turn, ENABLED))
    .toThrow("required tool profile is ineligible for direct phase: memory-write");
});

test("M1 v2 read-only rejects a mixed memory-write profile before projection", () => {
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

test("M1 v2 rejects a required profile when its phase projection would be partial", () => {
  const turn = turnRecord({
    accessMode: "read_only",
    trackingMode: "ledger",
    projectRef: "butler",
  });
  turn.context.executionPolicy!.requiredNativeToolProfiles = ["workspace"];

  expect(() => selectGuidedTurnPhasePolicy(turn, ENABLED))
    .toThrow("required tool profile is ineligible for read_only phase: workspace");
});

test("M1 v2 accepts the real writable App project profile set with a reduced schema", () => {
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

test("M1 v2 treats real full-access App chat workspace authority as execution", () => {
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

test("M1 v2 policy serializes byte-identical schemas and stable prefix for the same revision", () => {
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

test("M1 v2 selected stable prefix is the prefix of the real guided provider instructions", () => {
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

test("M1 v2 default-off path preserves legacy bytes and enabled policy reduces both stable and schema bytes", () => {
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
  expect(legacy.stableInstructionPrefix).toContain("The Work stage is process guidance");
  expect(enabled.mode).toBe("phase_minimal");
  expect(enabled.stableInstructionPrefix.length).toBeLessThan(legacy.stableInstructionPrefix.length);
  expect(enabledSchemas.length).toBeLessThan(legacySchemas.length);
});

test("M1 v2 flag-off request assembly is byte-identical to canonical legacy instructions", () => {
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

test("M1 v2 serializer bytes decrease for direct, read-only, and execution phases", () => {
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

test("exact replay reduces actual Codex serializer bytes in every typed phase", () => {
  const turns = [
    turnRecord({ trackingMode: "none" }),
    turnRecord({ accessMode: "read_only", trackingMode: "ledger", projectRef: "butler" }),
    turnRecord({ accessMode: "full_access", trackingMode: "ledger", projectRef: "butler" }),
  ];
  const raw = JSON.stringify({ ok: true, output: { content: "R".repeat(9_000) } });
  const reference = JSON.stringify({
    version: "butler.operation-result-reference.v1", kind: "operation_result",
    identity: { kind: "direct", result_ref: "result", tool_name: "read_file" },
    integrity: { sha256: "a".repeat(64), revision: null },
    outcome: { status: "completed", success: true, verification: "stored_exact_available" },
    availability: { status: "exact_read_available", capability: "read_operation_results", scope: "same_turn" },
  });
  const expectedBytes = [[33_656, 17_237], [36_789, 20_370], [44_932, 28_513]];
  for (const [index, turn] of turns.entries()) {
    const before = selectGuidedTurnPhasePolicy(turn, ENABLED);
    const after = selectGuidedTurnPhasePolicy(turn, {
      ...ENABLED, BUTLER_M1_V2_EXACT_ONCE_REPLAY: "on",
    });
    const body = (selection: typeof before, output: string) => codexRequestBody({
      model: "gpt-5.6-sol",
      instructions: selection.stableInstructionPrefix,
      tools: modelFacingFunctionTools(selection.providerTools),
      input: [
        { type: "function_call_output", call_id: "call-1", output },
        { type: "function_call_output", call_id: "call-2", output },
        { type: "function_call_output", call_id: "call-3", output },
      ],
    });
    const beforeBytes = byteLength(JSON.stringify(body(before, raw)));
    const afterBody = body(after, reference);
    (afterBody.input as Array<{ output: string }>)[0]!.output = raw;
    const afterBytes = byteLength(JSON.stringify(afterBody));
    expect(afterBytes).toBeLessThan(beforeBytes);
    expect([beforeBytes, afterBytes]).toEqual(expectedBytes[index]);
  }
});

test("bounded continuation reduces actual Codex serializer bytes in every typed phase", () => {
  const turns = [
    turnRecord({ trackingMode: "none" }),
    turnRecord({ accessMode: "read_only", trackingMode: "ledger", projectRef: "butler" }),
    turnRecord({ accessMode: "full_access", trackingMode: "ledger", projectRef: "butler" }),
  ];
  const history = continuationHistory(100);
  const bounded = buildBoundedTurnContext(history, 4_000);
  const actual: Array<[number, number]> = [];
  for (const turn of turns) {
    const selection = selectGuidedTurnPhasePolicy(turn, {
      ...ENABLED, BUTLER_M1_V2_EXACT_ONCE_REPLAY: "on",
    });
    const body = (messages: readonly ModelRoundMessage[]) => codexRequestBody({
      model: "gpt-5.6-sol",
      instructions: selection.stableInstructionPrefix,
      tools: modelFacingFunctionTools(selection.providerTools),
      input: continuationItems(messages),
    });
    const beforeBytes = byteLength(JSON.stringify(body(history)));
    const afterBytes = byteLength(JSON.stringify(body(bounded.messages)));
    expect(afterBytes).toBeLessThan(beforeBytes);
    actual.push([beforeBytes, afterBytes]);
  }
  expect(actual).toEqual([
    [61_030, 11_629],
    [64_163, 14_762],
    [72_306, 22_905],
  ]);
});

test("M1 v2 admitted tools retain the existing native registry authority", () => {
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
    turnId: "turn-m1-tool-surface",
    sessionId: "session-m1-tool-surface",
    inboxId: "inbox-m1-tool-surface",
    triggerKey: "trigger-m1-tool-surface",
    originalMessageId: "message-m1-tool-surface",
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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function continuationHistory(rounds: number): ModelRoundMessage[] {
  const messages: ModelRoundMessage[] = [{ role: "user", content: "current request active Work required refs" }];
  for (let index = 0; index < rounds; index += 1) {
    messages.push({
      role: "assistant", content: `assistant-${index}-${"A".repeat(80)}`,
      toolCalls: [{ id: `call-${index}`, name: "read_file", arguments: { index }, rawArguments: JSON.stringify({ index }) }],
    });
    messages.push({
      role: "tool", toolCallId: `call-${index}`, name: "read_file",
      content: JSON.stringify({ validation: index, result: "R".repeat(120) }),
    });
    messages.push({ role: "user", content: `review-${index}` });
  }
  return messages;
}

function continuationItems(messages: readonly ModelRoundMessage[]): Array<Record<string, unknown>> {
  return messages.flatMap((message): Array<Record<string, unknown>> => {
    if (message.role === "user") return [{ role: "user", content: [{ type: "input_text", text: message.content }] }];
    if (message.role === "tool") return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
    if (message.role !== "assistant") return [];
    return [
      ...(message.content ? [{ role: "assistant", content: [{ type: "output_text", text: message.content }] }] : []),
      ...(message.toolCalls ?? []).map((call) => ({
        type: "function_call", call_id: call.id, name: call.name,
        arguments: call.rawArguments ?? JSON.stringify(call.arguments),
      })),
    ];
  });
}

function appProjectBinding(runtimePolicy: Record<string, unknown>): StoredSessionBinding {
  const timestamp = new Date(0).toISOString();
  return {
    sessionId: "session-m1-tool-surface",
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
