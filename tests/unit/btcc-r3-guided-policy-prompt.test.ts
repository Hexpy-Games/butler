import { expect, test } from "bun:test";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type { SqliteGuidedToolJournal } from
  "../../packages/butler-agent/src/agent/adapters/index.ts";
import {
  authorizedToolDefinitions,
  guidedNativeToolDefinitions,
  guidedPolicy,
  visibleToolDefinitions,
} from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-policy.ts";
import {
  guidedInstructions,
  renderGuidedPrompt,
} from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-prompt.ts";
import { guidedStewardInstructions } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-steward-instructions.ts";
import { DURABLE_WORK_TOOL_DEFINITIONS } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/durable-work-tool-definitions.ts";
import { workScopeForTurn } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-work-runtime.ts";
import { appRuntimePolicy } from
  "../../packages/butler-agent/src/gateways/app/domain/runtime/app-runtime-policy.ts";
import { delegateToStewardToolDefinition } from
  "../../packages/butler-agent/src/agent/tools/subsession/definition.ts";
import { normalizeSubsessionMutationScope } from
  "../../packages/butler-agent/src/agent/btcc/subsessions/scope.ts";

test("R3 guided web_read keeps reader backend runtime-owned", () => {
  const webRead = guidedNativeToolDefinitions().find((tool) => tool.name === "web_read");

  expect(webRead?.parameters.properties).toHaveProperty("start_chunk");
  expect(webRead?.parameters.properties).not.toHaveProperty("backend");
  expect(webRead?.description).toContain("content_has_more");
  expect(webRead?.description).toContain("next_start_chunk");
});

test("R3 app policy enables session Work by default and preserves explicit opt-out", () => {
  expect(appRuntimePolicy({
    existing: {},
    accessMode: "read_only",
    sessionKind: "chat",
  })).toMatchObject({
    tracking_mode: "local",
    tracking_mode_source: "session_default",
    closeout_strategy: "local_workstream",
  });

  expect(appRuntimePolicy({
    existing: {
      tracking_mode: "none",
      tracking_mode_source: "explicit",
    },
    accessMode: "full_access",
    projectId: "butler",
    sessionKind: "project",
  })).toMatchObject({
    tracking_mode: "none",
    tracking_mode_source: "explicit",
    closeout_strategy: "noop",
  });

  expect(appRuntimePolicy({
    existing: {
      tracking_mode: "none",
      tracking_mode_source: "session_default",
    },
    accessMode: "full_access",
    sessionKind: "chat",
  })).toMatchObject({
    tracking_mode: "local",
    tracking_mode_source: "session_default",
    closeout_strategy: "local_workstream",
  });

  expect(appRuntimePolicy({
    existing: { trackingMode: "none" },
    accessMode: "read_only",
    sessionKind: "chat",
  })).toMatchObject({
    tracking_mode: "local",
    tracking_mode_source: "session_default",
  });

  expect(appRuntimePolicy({
    existing: {},
    accessMode: "full_access",
    projectId: "butler",
    sessionKind: "project",
  })).toMatchObject({
    tracking_mode: "ledger",
    tracking_mode_source: "app_project_default",
    closeout_strategy: "ledger",
  });
});

test("R3 guided fallback uses session or project Work without exposing tracking internals", () => {
  const chatTurn = turnRecord();
  const projectTurn = turnRecord({ projectRef: "butler" });

  expect(guidedPolicy(chatTurn).trackingMode).toBe("local");
  expect(guidedPolicy(projectTurn).trackingMode).toBe("ledger");

  const prompt = renderGuidedPrompt(chatTurn, {
    butlerData: "/tmp/butler-data",
    contextDocuments: { resolve: () => "" },
    toolJournal: emptyToolJournal(),
    workContext: [
      "Objective: Prepare a market brief",
      "Plan: collect sources; compare findings; write report",
      "Next: verify the report",
    ].join("\n"),
  });
  const instructions = guidedInstructions(guidedPolicy(chatTurn));

  expect(prompt).toContain("work storage: session");
  expect(prompt).toContain("## Current Work");
  expect(prompt).toContain("Objective: Prepare a market brief");
  expect(prompt).not.toContain("tracking:");
  expect(instructions).toContain("Use Work when the task needs continuation across turns");
  expect(instructions).toContain("Skip Work for simple conversation");
  expect(instructions).not.toContain("turn_time_remaining_seconds");
  expect(instructions).toContain("single-step read-only lookup");
  expect(instructions).toContain("state_effect validation");
  expect(instructions).toContain("state_effect mutation and remote_observation");
  expect(instructions).toContain("real HOME and network");
  expect(instructions).toContain("after the current concise Plan has an accepted Plan Review");
  expect(instructions).toContain("Multi-source or multi-step research");
  expect(instructions).toContain("explicitly call continue_work with the exact current Work id");
  expect(instructions).toContain("Ordinary tools never select Work");
  expect(instructions).toContain(
    "explicitly call continue_work with the exact current Work id",
  );
  expect(instructions).toContain(
    "Keep the Work objective as the overall user outcome across Turns",
  );
  expect(instructions).toContain(
    "action_key as a stable concise user-visible summary",
  );
  expect(instructions).toContain(
    "Use optional description only for fuller detail",
  );
  expect(instructions).toContain(
    "accepted Plan as a whole covers contained workspace writes",
  );
  expect(instructions).toContain("do not enumerate files");
  expect(instructions).toContain(
    "typed Project Ledger changes in the active project",
  );
  expect(instructions).toContain(
    "Checkpoints update only actions or progress",
  );
  expect(instructions).toContain(
    "Accept starts execution; revise or partial returns to planning",
  );
  expect(instructions).toContain(
    "On accept, mark the first action active in the same Review",
  );
  expect(instructions).toContain(
    "record_work_review for optional Plan Review, result Review, or completion Validation",
  );
  expect(instructions).toContain(
    "smallest evidence set that supports a useful and truthful result",
  );
  expect(instructions).toContain(
    "only when its result could materially change the conclusion",
  );
  expect(instructions).toContain(
    "request them in the same round so safe tools can run together",
  );
  expect(instructions).toContain(
    "use record_work_checkpoint only for meaningful action or concise outcome progress",
  );
  expect(instructions).toContain(
    "Only revised or partial result/completion needs correction_scope",
  );
  expect(instructions).not.toContain("next_stage");
  expect(instructions).not.toContain("allowed next stages");
  expect(instructions).toContain(
    "record_work_disposition using completed only when every current Plan action is done or skipped",
  );
  expect(instructions).toContain(
    "these records are optional quality evidence",
  );
  expect(instructions).toContain(
    "reporting never depends on a Review",
  );
  expect(instructions).toContain(
    "may describe the upcoming report",
  );
  expect(instructions).toContain(
    "not the report itself, a draft of the final answer, or copied final-answer wording",
  );
  expect(instructions).toContain(
    "active Plan action_key is the model-authored execution activity title",
  );
  expect(instructions).toContain(
    "Assistant text is the full activity summary, never the title source",
  );
  expect(instructions).not.toContain("all its tool calls in order");
  expect(instructions).not.toContain("put them in one response in an allowed order");
  expect(instructions).not.toContain("separate concurrent batch");
  expect(instructions).toContain(
    "finish any Project Ledger publication or closeout effect",
  );
  expect(instructions).toContain(
    "If useful, record a result Review or completion Validation",
  );
  expect(instructions).toContain(
    "make a path contain the complete desired file",
  );
  expect(instructions.indexOf("answer or create the result before optional investigation"))
    .toBeLessThan(instructions.indexOf("use record_work_checkpoint only for meaningful"));
  expect(instructions).toContain("not a demand for endless polish");
  expect(instructions).toContain(
    "report it with any material limitation instead of extending Work",
  );
  expect(instructions).not.toContain("inspect_workspace_page");
  expect(instructions.indexOf("If useful, record a result Review or completion Validation"))
    .toBeLessThan(instructions.indexOf("Settle the bound Work with record_work_disposition"));
  expect(instructions).toContain(
    "despite disclosed non-critical limits",
  );
  expect(instructions).toContain(
    "Use open or blocked with a truthful continuation condition",
  );
  expect(instructions).toContain(
    "do not keep Work open for optional improvements",
  );
  expect(instructions).toContain("If Work bookkeeping fails, continue");
  expect(instructions).not.toContain("tracking=");
  expect(instructions).not.toContain("BTCC states");

  const projectInstructions = guidedInstructions(guidedPolicy(projectTurn));
  expect(projectInstructions).toContain(
    "keep one concise Project Ledger Work record",
  );
  expect(projectInstructions).toContain(
    "Check for related Work first and reuse it when present",
  );
  expect(projectInstructions).toContain(
    "then complete it after validating the requested outcome",
  );
  expect(projectInstructions).toContain(
    "An uninitialized Project Ledger has no existing Work to reuse",
  );
  expect(projectInstructions).toContain(
    "Do not create Project Ledger task or attempt hierarchies unless",
  );
  expect(projectInstructions).toContain(
    "If Project Ledger bookkeeping fails, still deliver the truthful result",
  );
  expect(projectInstructions.indexOf("finish any Project Ledger publication or closeout effect"))
    .toBeLessThan(projectInstructions.indexOf("If useful, record a result Review or completion Validation"));
  expect(projectInstructions).not.toContain(
    "Do not attempt to mutate the Project Ledger",
  );
});

test("SS-03B guided instructions define semantic delegation selection", () => {
  const instructions = guidedInstructions(guidedPolicy(
    turnRecord({ accessMode: "full_access", projectRef: "butler" }),
  ));

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
});

test("SS-03B delegation tool contract exposes canonical execution surfaces", () => {
  const parameters = delegateToStewardToolDefinition.parameters as {
    oneOf?: Array<{ properties?: Record<string, any> }>;
  };
  const variants = parameters.oneOf ?? [];
  const readOnly = variants.find((variant) =>
    variant.properties?.execution_mode?.const === "read_only",
  );
  const mutation = variants.find((variant) =>
    variant.properties?.execution_mode?.const === "mutation",
  );
  const readOnlySurface = [
    "grep_files:workspace",
    "list_files:workspace",
    "read_file:workspace",
    "web_read:network",
    "web_search:network",
  ];

  expect(delegateToStewardToolDefinition.description).toContain(
    "For read_only, allowed_tools_and_effects is exactly the complete five-value array",
  );
  expect(delegateToStewardToolDefinition.description).toContain(
    "Every mutation Steward can list, grep, read, apply admitted edit/write effects, and run bounded workspace validation",
  );
  expect(readOnly).toBeDefined();
  expect(readOnly?.properties?.allowed_tools_and_effects).toMatchObject({
    minItems: 5,
    maxItems: 5,
    uniqueItems: true,
    items: { enum: readOnlySurface },
  });
  expect(readOnly?.properties?.mutation_scope).toMatchObject({ maxItems: 0 });
  expect(mutation).toBeDefined();
  expect(mutation?.properties?.allowed_tools_and_effects).toMatchObject({
    minItems: 1,
    items: { enum: ["edit_file:workspace", "run_command:workspace", "write_file:workspace"] },
  });
  expect(mutation?.properties?.mutation_scope).toMatchObject({ minItems: 1 });
  expect(mutation?.properties?.mutation_scope?.items?.description).toContain(
    "terminal dir/** shorthand",
  );
  expect(normalizeSubsessionMutationScope(["src/**", "package.json", "src/**"]))
    .toEqual(["package.json", "src/"]);
  for (const rejected of ["**", "src/*.ts", "src/?", "src/[ab]"]) {
    expect(() => normalizeSubsessionMutationScope([rejected])).toThrow(
      "subsession_mutation_scope_wildcard_not_allowed",
    );
  }
});

test("Steward instructions keep ordinary BTCC memory, authority, and closeout", () => {
  const commonCloseout =
    "Use record_work_disposition as the sole Work closeout authority, exactly as an ordinary Butler BTCC Turn does. Reviews and completion Validation are optional quality records, never Steward-only completion gates.";
  const readOnlyPlanContract =
    "For read_only, every Plan action must omit the effect field entirely; reads and synthesis are evidence actions, never effects.";
  const multiStepPlanContract =
    "Use at least two truthful top-level Plan actions for this substantial delegated Work; do not collapse materially separate discovery, mutation, verification, or synthesis stages into one umbrella action.";
  const common = {
    relationId: "relation",
    delegationId: "delegation",
    taskId: "task",
    mutationScope: [],
    allowedToolsAndEffects: [
      "grep_files:workspace",
      "list_files:workspace",
      "read_file:workspace",
      "web_read:network",
      "web_search:network",
    ],
  };

  const readOnlyInstructions = guidedStewardInstructions({
    subsession: { ...common, executionMode: "read_only" },
  });
  expect(readOnlyInstructions).toContain(commonCloseout);
  expect(readOnlyInstructions).not.toContain("only then settle the child Work as completed");
  expect(readOnlyInstructions).not.toContain("at least two material read operations");
  expect(readOnlyInstructions).toContain(readOnlyPlanContract);
  expect(readOnlyInstructions).toContain(multiStepPlanContract);
  const mutationInstructions = guidedStewardInstructions({
    subsession: {
      ...common,
      executionMode: "mutation",
      mutationScope: ["bounded-result.txt"],
      allowedToolsAndEffects: ["write_file:workspace"],
    },
  });
  expect(mutationInstructions).toContain(commonCloseout);
  expect(mutationInstructions).not.toContain("only then settle the child Work as completed");
  expect(mutationInstructions).toContain(multiStepPlanContract);
  expect(mutationInstructions).toContain(
    "project Hot Cache, Project Memory, durable feedback and corrections",
  );
  expect(mutationInstructions).toContain(
    "actively use recall_memory",
  );
  expect(mutationInstructions).toContain("same reviewed Plan and effect contract as Butler");
  expect(mutationInstructions).not.toMatch(
    /access conversation or memory tools|call MCP|mutate Project Ledger|omit effect from .*run_command/iu,
  );
});

test("R3 continuation guidance repairs legacy Work labels and refreshes downstream results", () => {
  const instructions = guidedInstructions(guidedPolicy(turnRecord()));

  expect(instructions).toContain("generic stage-token labels");
  expect(instructions).toContain(
    "revise the Plan once with concrete summaries before dependent work",
  );
  expect(instructions).toContain("reopening an earlier action after partial closeout");
  expect(instructions).toContain("when their results must now be refreshed");
  expect(instructions).toContain("dependent later actions and their statuses in the same update");
});

test("R3 Conception guidance actively selects associative recall and exposes cross-session tools", () => {
  const turn = turnRecord({
    projectRef: "butler",
    accessMode: "read_only",
    executionPolicy: executionPolicy("ledger"),
  });
  const instructions = guidedInstructions(guidedPolicy(turn));
  const definitions = authorizedToolDefinitions(turn, {});
  const authorized = definitions.map((tool) => tool.name);
  const visible = visibleToolDefinitions(definitions, guidedPolicy(turn))
    .map((tool) => tool.name);

  expect(instructions).toContain("Conception");
  expect(instructions).toContain("recall_memory");
  expect(instructions).toContain("durable user preferences");
  expect(instructions).toContain("Hot Cache");
  expect(instructions).toContain("materially improve personalization or goal fidelity");
  expect(instructions).toContain("list_conversation_sessions");
  expect(instructions).toContain("read_conversation_session");
  expect(instructions).toContain("current context is genuinely sufficient");
  expect(instructions).not.toContain("keyword classifier");
  expect(authorized).toContain("recall_memory");
  expect(authorized).toContain("list_conversation_sessions");
  expect(authorized).toContain("read_conversation_session");
  expect(visible).toContain("recall_memory");
  expect(visible).toContain("list_conversation_sessions");
  expect(visible).toContain("read_conversation_session");
});

test("guided read-only policy authorizes and visibly exposes list_files", () => {
  const turn = turnRecord({ accessMode: "read_only" });
  const policy = guidedPolicy(turn);
  const authorized = authorizedToolDefinitions(turn, {});
  const visible = visibleToolDefinitions(authorized, policy);

  expect(authorized.find((tool) => tool.name === "list_files")).toBeDefined();
  expect(visible.find((tool) => tool.name === "list_files")).toBeDefined();
  expect(visible.find((tool) => tool.name === "list_files")?.parameters.properties).toHaveProperty("include_globs");
});

test("session worktree binding is visible only on full-access project surfaces", () => {
  const projectFullAccess = turnRecord({
    projectRef: "butler",
    accessMode: "full_access",
    executionPolicy: {
      ...executionPolicy("ledger"),
      accessMode: "full_access",
    },
  });
  const projectAuthorized = authorizedToolDefinitions(projectFullAccess, {});
  expect(projectAuthorized.map((tool) => tool.name)).toContain("bind_session_git_worktree");
  expect(visibleToolDefinitions(projectAuthorized, guidedPolicy(projectFullAccess))
    .map((tool) => tool.name)).toContain("bind_session_git_worktree");

  const readOnlyProject = turnRecord({
    projectRef: "butler",
    accessMode: "read_only",
    executionPolicy: executionPolicy("ledger"),
  });
  expect(authorizedToolDefinitions(readOnlyProject, {}).map((tool) => tool.name))
    .not.toContain("bind_session_git_worktree");

  const generalFullAccess = turnRecord({
    accessMode: "full_access",
    executionPolicy: {
      ...executionPolicy("local"),
      accessMode: "full_access",
    },
  });
  expect(authorizedToolDefinitions(generalFullAccess, {}).map((tool) => tool.name))
    .not.toContain("bind_session_git_worktree");
});

test("guided workspace visibility owns the exact native workspace surface", () => {
  const projectFullAccess = turnRecord({
    projectRef: "butler",
    accessMode: "full_access",
    executionPolicy: {
      ...executionPolicy("ledger"),
      accessMode: "full_access",
    },
  });
  const fullNames = visibleToolDefinitions(
    guidedNativeToolDefinitions(),
    guidedPolicy(projectFullAccess),
  ).map((tool) => tool.name);
  for (const name of [
    "run_command",
    "write_file",
    "edit_file",
    "bind_session_git_worktree",
  ]) {
    expect(fullNames.filter((visibleName) => visibleName === name)).toHaveLength(1);
  }

  const readOnly = turnRecord({ accessMode: "read_only" });
  const readOnlyNames = visibleToolDefinitions(
    authorizedToolDefinitions(readOnly, {}),
    guidedPolicy(readOnly),
  ).map((tool) => tool.name);
  for (const name of ["list_files", "read_file", "grep_files"]) {
    expect(readOnlyNames.filter((visibleName) => visibleName === name)).toHaveLength(1);
  }
  for (const name of [
    "run_command",
    "write_file",
    "edit_file",
    "bind_session_git_worktree",
  ]) {
    expect(readOnlyNames).not.toContain(name);
  }
});

test("R3 guided prompt reports disabled Work without inventing a Work context", () => {
  const turn = turnRecord({
    executionPolicy: executionPolicy("none"),
  });
  const prompt = renderGuidedPrompt(turn, {
    butlerData: "/tmp/butler-data",
    contextDocuments: { resolve: () => "" },
    toolJournal: emptyToolJournal(),
  });

  expect(prompt).toContain("work storage: disabled");
  expect(prompt).not.toContain("## Current Work");
  expect(guidedInstructions(guidedPolicy(turn))).toContain("Work storage is disabled.");
});

test("R3 Plan tool describes workspace writes as accepted-Plan work", () => {
  const replacePlan = DURABLE_WORK_TOOL_DEFINITIONS.find(
    (definition) => definition.name === "replace_work_plan",
  );
  const schema = JSON.stringify(replacePlan);

  expect(schema).toContain(
    "contained workspace and active Project Ledger work",
  );
  expect(schema).toContain("do not enumerate files");
  expect(schema).not.toContain("workspace:<relative-path>");
  expect(schema).toContain("stable user-visible action summary");
  expect(schema).toContain("Optional fuller detail");
  const actionSchema = (replacePlan?.parameters as {
    properties: { actions: { items: { required?: string[] } } };
  } | undefined)?.properties.actions.items;
  expect(actionSchema?.required).toEqual(["action_key"]);
});

test("R3 Work scope follows explicit storage mode instead of project shell presence", () => {
  const projectTurn = turnRecord({
    projectRef: "butler",
    executionPolicy: executionPolicy("local"),
  });

  expect(workScopeForTurn(projectTurn, "local")).toEqual({
    turnId: projectTurn.turnId,
    sessionId: projectTurn.sessionId,
  });
  expect(workScopeForTurn(projectTurn, "ledger")).toEqual({
    turnId: projectTurn.turnId,
    sessionId: projectTurn.sessionId,
    projectRef: "butler",
  });
});

function turnRecord(options: {
  accessMode?: "read_only" | "ask_first" | "full_access";
  projectRef?: string;
  executionPolicy?: TurnRecord["context"]["executionPolicy"];
} = {}): TurnRecord {
  return {
    turnId: "turn-r3-policy",
    sessionId: "session-r3-policy",
    inboxId: "inbox-r3-policy",
    triggerKey: "trigger-r3-policy",
    originalMessageId: "message-r3-policy",
    originalMessage: "Please help",
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: options.accessMode ?? "read_only" },
      controlsHash: "controls",
    },
    context: {
      userRef: "local-user",
      ...(options.projectRef ? { projectRef: options.projectRef } : {}),
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: ["workspace:/tmp/workspace"],
      ...(options.executionPolicy
        ? { executionPolicy: options.executionPolicy }
        : {}),
    },
    semanticState: "admitted",
    checkpoint: {
      checkpointId: "checkpoint-r3-policy",
      checkpointRevision: 1,
      kind: "runtime",
      semanticState: "admitted",
    },
    revision: 0,
    executionFence: 0,
  };
}

function executionPolicy(
  trackingMode: "ledger" | "local" | "none",
): NonNullable<TurnRecord["context"]["executionPolicy"]> {
  return {
    role: "butler",
    accessMode: "read_only",
    trackingMode,
    requiredNativeToolProfiles: [],
    requiredNativeTools: [],
    workspacePath: "/tmp/workspace",
  };
}

function emptyToolJournal(): SqliteGuidedToolJournal {
  return { list: () => [] } as unknown as SqliteGuidedToolJournal;
}
