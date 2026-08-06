import { expect, test } from "bun:test";
import {
  createInitialToolSurfaceControllerState,
  isToolSurfaceTransitionAllowed,
  TOOL_SURFACE_CONTROLLER_STATES,
  ToolSurfaceControllerInputError,
  ToolSurfaceTransitionError,
  transitionToolSurfaceControllerState,
  type ToolSurfaceControllerInput,
  type ToolSurfaceControllerState,
} from "../../packages/butler-agent/src/agent/tools/tool-surface-controller.ts";
import { TOOL_CAPABILITY_METADATA } from "../../packages/butler-agent/src/agent/tools/registry.ts";
import { PROJECT_LEDGER_MUTATION_TOOL_NAMES } from "../../packages/butler-agent/src/agent/tools/project-ledger/mutation-tools.ts";
import { canBridgeNativeTool } from "../../packages/butler-agent/src/agent/tools/tool-bridge/scope.ts";
import { selectInitialToolsFromSurfaceController } from "../../packages/butler-agent/src/agent/tools/tool-surface-selection.ts";

function createStructuredInitialState(): ToolSurfaceControllerState {
  return createInitialToolSurfaceControllerState({
    role: "butler",
    sessionMode: "interactive",
    configuredCapabilities: {
      toolNames: ["read_file", "read_file"],
      allowFilesystem: true,
      allowPublicWeb: false,
    },
    userApprovals: [
      { target: { type: "tool", toolName: "read_file" }, approved: true, reason: "workspace file inspection allowed" },
    ],
    projectMetadata: { projectId: "butler", projectPath: "/workspace/butler" },
    sessionMetadata: { sessionId: "session-1", projectId: "butler" },
    turnMetadata: { runtimeContext: { policyId: "structured-policy" } },
    requiredNativeTools: ["read_file", "read_file", "grep_files"],
    providerCapabilities: { supportsToolCalls: true, supportsStreaming: true },
    discoveryActions: [
      { type: "require-tool", toolName: "read_file", source: "model" },
    ],
  });
}

const _typeRejectsNaturalLanguageTextInput = () => {
  // @ts-expect-error ToolSurfaceControllerInput intentionally has no natural-language text field.
  const rejectedInput: ToolSurfaceControllerInput = { role: "butler", text: "search the repo for this" };
  return rejectedInput;
};

test("tool surface controller declares every accepted state", () => {
  expect(TOOL_SURFACE_CONTROLLER_STATES).toEqual([
    "initial",
    "discovered",
    "described",
    "promoted",
    "invoked",
    "denied",
    "disabled",
  ]);
});

test("controller accepts only structured tool-surface inputs", () => {
  const state = createStructuredInitialState();

  expect(state.status).toBe("initial");
  expect(state.context.role).toBe("butler");
  expect(state.context.sessionMode).toBe("interactive");
  expect(state.context.configuredCapabilities).toEqual({
    toolNames: ["read_file"],
    allowFilesystem: true,
    allowPublicWeb: false,
  });
  expect(state.context.userApprovals).toEqual([
    { target: { type: "tool", toolName: "read_file" }, approved: true, reason: "workspace file inspection allowed" },
  ]);
  expect(state.context.projectMetadata).toEqual({ projectId: "butler", projectPath: "/workspace/butler" });
  expect(state.context.sessionMetadata).toEqual({ sessionId: "session-1", projectId: "butler" });
  expect(state.context.turnMetadata).toEqual({ runtimeContext: { policyId: "structured-policy" } });
  expect(state.context.requiredNativeTools).toEqual(["read_file", "grep_files"]);
  expect(state.context.providerCapabilities).toEqual({ supportsToolCalls: true, supportsStreaming: true });
  expect(state.context.discoveryActions).toEqual([
    { type: "require-tool", toolName: "read_file", source: "model" },
  ]);
  expect(Object.keys(state.context)).not.toContain("text");
  expect(Object.keys(state.context)).not.toContain("prompt");
  expect(Object.keys(state.context)).not.toContain("message");
});

test("initial surface selection uses structured controller state without prompt text", () => {
  const providerCapabilities = {
    supportsToolCalls: true,
    supportsStreaming: false,
    supportsPromptCaching: true,
  };
  const selection = selectInitialToolsFromSurfaceController({
    role: "butler",
    sessionMetadata: {
      projectId: "butler",
      promptContext: "please inspect the repository",
      currentUserText: "please inspect the repository",
      text: "please inspect the repository",
    },
    turnMetadata: {
      runtimePolicy: {
        requiredNativeToolProfiles: ["workspace"],
        promptText: "please inspect the repository",
      },
      message: "please inspect the repository",
    },
    providerCapabilities,
  });

  expect(selection.state.status).toBe("initial");
  expect(selection.state.context.role).toBe("butler");
  expect(selection.state.context.sessionMode).toBe("interactive");
  expect(selection.state.context.sessionMetadata).toEqual({ projectId: "butler" });
  expect(selection.state.context.turnMetadata).toEqual({
    runtimePolicy: { requiredNativeToolProfiles: ["workspace"] },
  });
  expect(selection.state.context.providerCapabilities).toEqual({
    supportsToolCalls: true,
    supportsStreaming: false,
  });
  expect(Object.keys(selection.state.context)).not.toContain("text");
  expect(Object.keys(selection.state.context)).not.toContain("prompt");
  expect(selection.toolNames).toEqual([
    "run_command",
    "read_file",
    "write_file",
    "edit_file",
    "grep_files",
    "project_ledger_status",
    "project_ledger_list",
    "project_ledger_show",
    "project_ledger_check",
    "inspect_project_status",
    "query_project_work",
    "get_context_monitor",
    "read_tool_evidence_artifact",
    "read_tool_output_artifact",
    "list_tool_capabilities",
    "tool_search",
    "tool_describe",
    "tool_call",
    "update_todo_list",
    "list_todo_list",
    "recall_memory",
    "read_conversation_context",
    "list_conversation_sessions",
    "read_conversation_session",
  ]);
});

test("initial surface selection does not infer Project Ledger tools from message text", () => {
  const selection = selectInitialToolsFromSurfaceController({
    role: "butler",
    message: "Project Ledger 상태를 확인하고 dashboard를 렌더해줘.",
    sessionMetadata: {},
    turnMetadata: {},
    providerCapabilities: { supportsToolCalls: true },
  });

  expect(selection.state.context.sessionMetadata).toBeUndefined();
  expect(selection.state.context.turnMetadata).toBeUndefined();
  expect(Object.keys(selection.state.context)).not.toContain("message");
  expect(selection.toolNames).not.toContain("project_ledger_status");
  expect(selection.toolNames).not.toContain("inspect_project_status");
  expect(selection.toolNames).not.toContain("query_project_work");
  expect(selection.toolNames).not.toContain("render_project_dashboard");
});

test("initial surface selection preserves tracking closeout metadata for lifecycle tools", () => {
  const selection = selectInitialToolsFromSurfaceController({
    role: "butler",
    message: "Project Ledger task T-1 complete 처리해줘.",
    sessionMetadata: { projectId: "butler" },
    turnMetadata: {
      runtimePolicy: {
        requiredNativeToolProfiles: ["project-lifecycle"],
        tracking_mode: "ledger",
        runtime_phase: "closeout_planned",
        validation_state: "validation_passed",
      },
    },
    providerCapabilities: { supportsToolCalls: true },
  });

  expect(selection.state.context.turnMetadata).toEqual({
    runtimePolicy: {
      requiredNativeToolProfiles: ["project-lifecycle"],
      tracking_mode: "ledger",
      runtime_phase: "closeout_planned",
      validation_state: "validation_passed",
    },
  });
  expect(selection.toolNames).toContain("project_ledger_task_complete");
  expect(selection.toolNames).toContain("project_ledger_attempt_succeed");
});

test("initial surface selection keeps Ledger mutation tools visible for Ledger mode", () => {
  const selection = selectInitialToolsFromSurfaceController({
    role: "butler",
    message: "이어서 계속 진행해줘.",
    sessionMetadata: { projectId: "butler" },
    turnMetadata: {
      runtimePolicy: {
        requiredNativeToolProfiles: ["project-lifecycle"],
        requiredNativeTools: [...PROJECT_LEDGER_MUTATION_TOOL_NAMES],
        tracking_mode: "ledger",
      },
    },
    providerCapabilities: { supportsToolCalls: true },
  });

  expect(selection.toolNames).toContain("project_ledger_status");
  expect(selection.toolNames).toContain("query_project_work");
  expect(selection.toolNames).toContain("tool_describe");
  expect(selection.toolNames).toContain("tool_call");
  for (const toolName of PROJECT_LEDGER_MUTATION_TOOL_NAMES) {
    expect(selection.toolNames).toContain(toolName);
    expect(canBridgeNativeTool({
      toolName,
      metadata: TOOL_CAPABILITY_METADATA[toolName],
      currentToolNames: selection.toolNames,
    })).toBe(true);
  }
});

test("controller advances through discovered, described, promoted, and invoked states", () => {
  let state = createStructuredInitialState();

  state = transitionToolSurfaceControllerState(state, {
    type: "discover",
    requiredNativeTools: ["query_memory"],
    discoveryActions: [{ type: "require-tool", toolName: "read_conversation_context", source: "model" }],
  });
  expect(state.status).toBe("discovered");
  if (state.status !== "discovered") throw new Error("expected discovered state");
  expect(state.discovery.discoveredToolNames).toEqual(["query_memory", "read_file", "read_conversation_context"]);
  expect(state.discovery.actions).toEqual([
    { type: "require-tool", toolName: "read_file", source: "model" },
    { type: "require-tool", toolName: "read_conversation_context", source: "model" },
  ]);

  state = transitionToolSurfaceControllerState(state, {
    type: "describe",
    requiredNativeTools: ["read_file", "query_memory", "read_conversation_context"],
  });
  expect(state.status).toBe("described");
  if (state.status !== "described") throw new Error("expected described state");
  expect(state.description.describedToolNames).toEqual([
    "read_file",
    "query_memory",
    "read_conversation_context",
  ]);

  state = transitionToolSurfaceControllerState(state, {
    type: "promote",
    providerCapabilities: { supportsToolCalls: true, supportsStreaming: false },
  });
  expect(state.status).toBe("promoted");
  if (state.status !== "promoted") throw new Error("expected promoted state");
  expect(state.promotion.providerCapabilities).toEqual({ supportsToolCalls: true, supportsStreaming: false });
  expect(state.promotion.enabledToolNames).toEqual([
    "read_file",
    "query_memory",
    "read_conversation_context",
  ]);

  state = transitionToolSurfaceControllerState(state, { type: "invoke", toolName: "read_file" });
  expect(state.status).toBe("invoked");
  if (state.status !== "invoked") throw new Error("expected invoked state");
  expect(state.invocation.toolName).toBe("read_file");
});

test("controller records denied and disabled terminal states", () => {
  const discovered = transitionToolSurfaceControllerState(createStructuredInitialState(), { type: "discover" });
  const denied = transitionToolSurfaceControllerState(discovered, { type: "deny", reason: "user policy denied native tools" });
  expect(denied.status).toBe("denied");
  if (denied.status !== "denied") throw new Error("expected denied state");
  expect(denied.deniedReason).toBe("user policy denied native tools");

  const described = transitionToolSurfaceControllerState(
    transitionToolSurfaceControllerState(createStructuredInitialState(), { type: "discover" }),
    { type: "describe" },
  );
  const disabled = transitionToolSurfaceControllerState(described, {
    type: "promote",
    providerCapabilities: { supportsToolCalls: false },
    disabledReason: "provider does not expose tool calls",
  });
  expect(disabled.status).toBe("disabled");
  if (disabled.status !== "disabled") throw new Error("expected disabled state");
  expect(disabled.disabledReasons).toEqual([
    "provider does not expose tool calls",
    "provider_tool_calls_disabled",
  ]);
});

test("controller rejects invalid transitions", () => {
  const initial = createStructuredInitialState();
  expect(isToolSurfaceTransitionAllowed(initial, "promote")).toBe(false);
  expect(() => transitionToolSurfaceControllerState(initial, {
    type: "promote",
    providerCapabilities: { supportsToolCalls: true },
  })).toThrow(ToolSurfaceTransitionError);

  const discovered = transitionToolSurfaceControllerState(initial, { type: "discover" });
  expect(() => transitionToolSurfaceControllerState(discovered, { type: "invoke", toolName: "read_file" }))
    .toThrow(ToolSurfaceTransitionError);

  const denied = transitionToolSurfaceControllerState(discovered, { type: "deny", reason: "not allowed" });
  expect(() => transitionToolSurfaceControllerState(denied, { type: "describe" }))
    .toThrow(ToolSurfaceTransitionError);

  const disabled = transitionToolSurfaceControllerState(createStructuredInitialState(), {
    type: "disable",
    reason: "surface disabled by policy",
  });
  expect(() => transitionToolSurfaceControllerState(disabled, { type: "discover" }))
    .toThrow(ToolSurfaceTransitionError);
});

test("controller rejects invoked tools that were not described and promoted", () => {
  const described = transitionToolSurfaceControllerState(
    transitionToolSurfaceControllerState(createStructuredInitialState(), { type: "discover" }),
    { type: "describe", requiredNativeTools: ["read_conversation_context"] },
  );
  const promoted = transitionToolSurfaceControllerState(described, {
    type: "promote",
    providerCapabilities: { supportsToolCalls: true },
  });

  expect(() => transitionToolSurfaceControllerState(promoted, { type: "invoke", toolName: "web_search" }))
    .toThrow(ToolSurfaceTransitionError);
  expect(() => transitionToolSurfaceControllerState(promoted, { type: "invoke", toolName: "read_file" }))
    .toThrow(ToolSurfaceTransitionError);
});

test("controller rejects natural-language prompt text at runtime", () => {
  expect(() => createInitialToolSurfaceControllerState({
    role: "butler",
    sessionMode: "interactive",
    text: "please inspect the repository",
  } as unknown as ToolSurfaceControllerInput)).toThrow(ToolSurfaceControllerInputError);

  expect(() => createInitialToolSurfaceControllerState({
    role: "butler",
    sessionMode: "interactive",
    projectMetadata: {
      promptText: "please inspect the repository",
    },
  })).toThrow(ToolSurfaceControllerInputError);

  expect(() => createInitialToolSurfaceControllerState({
    role: "butler",
    sessionMode: "interactive",
    turnMetadata: {
      runtimePolicy: {
        promptText: "please inspect the repository",
      },
    },
  })).toThrow(ToolSurfaceControllerInputError);

  expect(() => createInitialToolSurfaceControllerState({
    role: "butler",
    sessionMode: "interactive",
    providerCapabilities: {
      supportsToolCalls: true,
      promptText: "please inspect the repository",
    },
  })).toThrow(ToolSurfaceControllerInputError);

  expect(() => createInitialToolSurfaceControllerState({
    role: "butler",
    sessionMode: "interactive",
    configuredCapabilities: {
      toolNames: ["read_file"],
      promptText: "please inspect the repository",
    },
  } as unknown as ToolSurfaceControllerInput)).toThrow(ToolSurfaceControllerInputError);

  const initial = createStructuredInitialState();
  expect(() => transitionToolSurfaceControllerState(initial, {
    type: "discover",
    prompt: "please inspect the repository",
  } as unknown as Parameters<typeof transitionToolSurfaceControllerState>[1])).toThrow(ToolSurfaceControllerInputError);
});
