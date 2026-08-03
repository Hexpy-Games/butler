import { expect, test } from "bun:test";
import { digest, stableJson } from
  "../../packages/butler-agent/src/agent/btcc/identity/index.ts";
import { createGuidedEffectIdentity } from
  "../../packages/butler-agent/src/agent/btcc/effects/index.ts";
import { guidedToolOccurrence } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-occurrence.ts";
import { createGuidedToolResumePool } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-resume-pool.ts";
import { prepareGuidedCommandEffect } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-command-effect.ts";
import { effectiveToolNameForCall } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-policy.ts";
import { normalizeGuidedToolCall } from
  "../../packages/butler-agent/src/agent/tools/tool-support.ts";

test("run_command presentation summary does not change occurrence identity", () => {
  const first = guidedToolOccurrence({
    turnId: "turn-command-identity",
    callIndex: 3,
    providerCallId: "provider-command-1",
    name: "run_command",
    args: {
      command: "git status --short",
      cwd: "/workspace",
      summary: "변경 상태를 확인합니다.",
    },
  });
  const relabeled = guidedToolOccurrence({
    turnId: "turn-command-identity",
    callIndex: 3,
    providerCallId: "provider-command-1",
    name: "run_command",
    args: {
      command: "git status --short",
      cwd: "/workspace",
      summary: "작업공간 변경을 검증합니다.",
    },
  });
  const differentCommand = guidedToolOccurrence({
    turnId: "turn-command-identity",
    callIndex: 3,
    providerCallId: "provider-command-1",
    name: "run_command",
    args: {
      command: "git diff --check",
      cwd: "/workspace",
      summary: "작업공간 변경을 검증합니다.",
    },
  });

  expect(relabeled.callId).toBe(first.callId);
  expect(differentCommand.callId).not.toBe(first.callId);
});

test("provider v1 aliases preserve raw and summaryless run_command identities", () => {
  const directArgs = {
    command: "pwd",
    summary: "작업공간 위치를 확인합니다.",
  };
  const direct = guidedToolOccurrence({
    turnId: "turn-provider-v1-aliases",
    callIndex: 0,
    providerCallId: "provider-direct",
    name: "run_command",
    args: directArgs,
  });
  const directRawId = digest([
    "btcc-guided-provider-tool-call.v1",
    "turn-provider-v1-aliases",
    "provider-direct",
    "run_command",
    stableJson(directArgs),
  ].join("\0"));
  const directSummarylessId = digest([
    "btcc-guided-provider-tool-call.v1",
    "turn-provider-v1-aliases",
    "provider-direct",
    "run_command",
    stableJson({ command: "pwd" }),
  ].join("\0"));
  expect(direct.legacyProviderCallIds).toEqual([
    directRawId,
    directSummarylessId,
  ]);

  const progressive = guidedToolOccurrence({
    turnId: "turn-provider-v1-aliases",
    callIndex: 1,
    providerCallId: "provider-progressive",
    name: "tool_call",
    args: {
      id: "native:run_command",
      arguments: directArgs,
    },
  });
  const progressiveRawId = digest([
    "btcc-guided-provider-tool-call.v1",
    "turn-provider-v1-aliases",
    "provider-progressive",
    "tool_call",
    stableJson({ id: "native:run_command", arguments: directArgs }),
  ].join("\0"));
  const progressiveSummarylessId = digest([
    "btcc-guided-provider-tool-call.v1",
    "turn-provider-v1-aliases",
    "provider-progressive",
    "tool_call",
    stableJson({ id: "native:run_command", arguments: { command: "pwd" } }),
  ].join("\0"));
  expect(progressive.legacyProviderCallIds).toEqual([
    progressiveRawId,
    progressiveSummarylessId,
  ]);

  const alreadySummaryless = guidedToolOccurrence({
    turnId: "turn-provider-v1-aliases",
    callIndex: 2,
    providerCallId: "provider-progressive",
    name: "tool_call",
    args: {
      id: "native:run_command",
      arguments: { command: "pwd" },
    },
  });
  expect(alreadySummaryless.legacyProviderCallIds).toEqual([
    progressiveSummarylessId,
  ]);
});

test("progressive run_command unwraps nested summary for identity and resume", () => {
  const progressive = guidedToolOccurrence({
    turnId: "turn-progressive-command",
    callIndex: 1,
    providerCallId: "provider-progressive-command",
    name: "tool_call",
    args: {
      id: "native:run_command",
      arguments: { command: "git status", summary: "변경을 검증합니다." },
    },
  });
  const relabeledProgressive = guidedToolOccurrence({
    turnId: "turn-progressive-command",
    callIndex: 1,
    providerCallId: "provider-progressive-command",
    name: "tool_call",
    args: {
      id: "native:run_command",
      arguments: { command: "git status", summary: "다시 확인합니다." },
    },
  });
  expect(relabeledProgressive.callId).toBe(progressive.callId);

  const pool = createGuidedToolResumePool([{
    callId: "progressive-replay",
    toolName: "run_command",
    rawArguments: JSON.stringify(progressive),
    arguments: {
      id: "native:run_command",
      arguments: { command: "git status", summary: "이전 표시 문구" },
    },
    status: "started",
  }]);
  expect(pool.claim("run_command", {
    id: "native:run_command",
    arguments: { command: "git status", summary: "새 표시 문구" },
  })).toBe("progressive-replay");
});

test("progressive catalog provider and namespace remain in occurrence and resume identity", () => {
  const first = guidedToolOccurrence({
    turnId: "turn-progressive-catalog-identity",
    callIndex: 1,
    name: "tool_call",
    args: {
      id: "mcp:a:search",
      arguments: { query: "same" },
    },
  });
  const second = guidedToolOccurrence({
    turnId: "turn-progressive-catalog-identity",
    callIndex: 1,
    name: "tool_call",
    args: {
      id: "mcp:b:search",
      arguments: { query: "same" },
    },
  });
  expect(second.callId).not.toBe(first.callId);

  const pool = createGuidedToolResumePool([
    {
      callId: "search-a",
      toolName: "search",
      rawArguments: JSON.stringify({
        id: "mcp:a:search",
        arguments: { query: "same" },
      }),
      arguments: { query: "same" },
      status: "started",
    },
    {
      callId: "search-b",
      toolName: "search",
      rawArguments: JSON.stringify({
        id: "mcp:b:search",
        arguments: { query: "same" },
      }),
      arguments: { query: "same" },
      status: "started",
    },
  ]);

  expect(pool.claim("search", { query: "same" }, "mcp:b:search"))
    .toBe("search-b");
  expect(pool.claim("search", { query: "same" }, "mcp:a:search"))
    .toBe("search-a");
});

test("progressive catalog IDs use one fail-closed parser for effective names", () => {
  for (const id of [
    "native:run_command",
    "mcp:workspace:run_command",
    "plugin:workspace:run_command",
  ]) {
    const args = {
      id,
      arguments: { command: "pwd", summary: "중첩 명령 요약" },
    };
    expect(effectiveToolNameForCall("tool_call", { id })).toBe("run_command");
    expect(normalizeGuidedToolCall({ toolName: "tool_call", args })).toEqual({
      name: "run_command",
      args: args.arguments,
    });
  }

  const invalidArgs = {
    id: "native:run_command:extra",
    arguments: { command: "pwd" },
  };
  expect(effectiveToolNameForCall("tool_call", invalidArgs)).toBe("tool_call");
  expect(normalizeGuidedToolCall({
    toolName: "tool_call",
    args: invalidArgs,
  })).toEqual({ name: "tool_call", args: invalidArgs });
});

test("run_command summary does not change effect or replay identity", async () => {
  const prepare = (summary: string) => prepareGuidedCommandEffect({
    args: {
      command: "git status --short",
      cwd: ".",
      state_effect: "mutation",
      summary,
    },
    butlerData: "/tmp/butler-data",
    workspacePath: process.cwd(),
    originalRequest: "Inspect the workspace.",
  });
  const firstPrepared = await prepare("변경 상태를 확인합니다.");
  const relabeledPrepared = await prepare("작업공간 변경을 검증합니다.");
  const normalizedInput = firstPrepared.input;
  const identity = (normalizedInput: typeof firstPrepared.input) => createGuidedEffectIdentity({
    workId: "work-command-identity",
    planRevisionId: "plan-command-identity",
    actionKey: "accepted-plan",
    reviewedPlanBinding: "accepted_plan",
    occurrenceId: "occurrence-command-identity",
    capability: "run_command",
    normalizedTarget: "workspace-command:.",
    sanitizedTarget: "workspace-command:.",
    normalizedInput,
  });
  const first = identity(firstPrepared.input);
  const relabeled = identity(relabeledPrepared.input);

  expect(relabeled.effectId).toBe(first.effectId);
  expect(relabeled.inputSha256).toBe(first.inputSha256);
  expect(relabeled.identitySha256).toBe(first.identitySha256);

  const pool = createGuidedToolResumePool([{
    callId: "run-command-replay",
    toolName: "run_command",
    rawArguments: JSON.stringify({
      command: normalizedInput.command,
      summary: "변경 상태를 확인합니다.",
    }),
    arguments: {
      command: normalizedInput.command,
      summary: "변경 상태를 확인합니다.",
    },
    status: "started",
  }]);
  expect(pool.claim("run_command", {
    command: normalizedInput.command,
    summary: "작업공간 변경을 검증합니다.",
  })).toBe("run-command-replay");
});
