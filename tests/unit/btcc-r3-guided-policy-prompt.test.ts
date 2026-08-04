import { expect, test } from "bun:test";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type { SqliteGuidedToolJournal } from
  "../../packages/butler-agent/src/agent/adapters/index.ts";
import {
  authorizedToolDefinitions,
  guidedNativeToolDefinitions,
  guidedPolicy,
} from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-policy.ts";
import {
  guidedInstructions,
  renderGuidedPrompt,
} from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-prompt.ts";
import { DURABLE_WORK_TOOL_DEFINITIONS } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/durable-work-tool-definitions.ts";
import { workScopeForTurn } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-work-runtime.ts";
import { appRuntimePolicy } from
  "../../packages/butler-agent/src/gateways/app/domain/runtime/app-runtime-policy.ts";

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
  expect(instructions).toContain(
    "A state_effect mutation command runs only inside the admitted workspace",
  );
  expect(instructions).toContain("after the current concise Plan has an accepted Plan Review");
  expect(instructions).toContain("Multi-source or multi-step research");
  expect(instructions).toContain("call replace_work_plan before the dependent work");
  expect(instructions).toContain(
    "decide whether the current open Work continues or is superseded",
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
    "Use record_work_checkpoint to enter an allowed next stage",
  );
  expect(instructions).toContain(
    "Plan review judges the Plan itself",
  );
  expect(instructions).toContain(
    "mark the first action you will execute active in that same call's action_updates",
  );
  expect(instructions).toContain(
    "same record_work_review tool for Plan Review, result Review, and separate completion Validation",
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
    "use record_work_checkpoint only for meaningful stage or action progress",
  );
  expect(instructions).toContain(
    "include any known action_updates and the legal stage to enter after the Review as next_stage",
  );
  expect(instructions).toContain(
    "every current Plan action explicitly done, skipped, or blocked",
  );
  expect(instructions).toContain(
    "separately validate the whole Work against the original request",
  );
  expect(instructions).toContain(
    "Use next_stage reporting only when completion Validation accepts",
  );
  expect(instructions).toContain(
    "describes the focus or structure of the upcoming report",
  );
  expect(instructions).toContain(
    "not the report itself, a draft of the final answer, or copied final-answer wording",
  );
  expect(instructions).toContain(
    "encompass the whole current Plan action or execution outcome",
  );
  expect(instructions).toContain(
    "do not replace the activity with narrower labels",
  );
  expect(instructions).not.toContain("all its tool calls in order");
  expect(instructions).not.toContain("put them in one response in an allowed order");
  expect(instructions).not.toContain("separate concurrent batch");
  expect(instructions).toContain(
    "finish any Project Ledger publication or closeout effect",
  );
  expect(instructions).toContain(
    "record a result Review of the actual result with every current Plan action",
  );
  expect(instructions).toContain(
    "make a path contain the complete desired file",
  );
  expect(instructions.indexOf("answer or create the result before optional investigation"))
    .toBeLessThan(instructions.indexOf("use record_work_checkpoint only for meaningful"));
  expect(instructions).toContain("not a demand for endless polish");
  expect(instructions).toContain(
    "correct and re-inspect only when a visible defect materially harms",
  );
  expect(instructions.indexOf("record a result Review of the actual result with every"))
    .toBeLessThan(instructions.indexOf("separately validate the whole Work"));
  expect(instructions).toContain(
    "despite disclosed non-critical limits",
  );
  expect(instructions).toContain(
    "otherwise use partial or revise and return to the needed stage",
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
    .toBeLessThan(projectInstructions.indexOf("record a result Review of the actual result with every"));
  expect(projectInstructions).not.toContain(
    "Do not attempt to mutate the Project Ledger",
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

test("R3 hides page preview when the foreground App host is unavailable", () => {
  const turn = turnRecord({
    accessMode: "full_access",
    executionPolicy: {
      ...executionPolicy("local"),
      accessMode: "full_access",
    },
  });

  expect(
    authorizedToolDefinitions(turn, {}).some(
      (definition) => definition.name === "inspect_workspace_page",
    ),
  ).toBe(false);
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
