import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { createProductionGuidedTurnAgent } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import {
  authorizedToolDefinitions,
  guidedPolicy,
  visibleToolDefinitions,
} from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-policy.ts";
import type { TurnRecord } from
  "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import {
  createTurnRuntime,
  type BtccRunCommand,
} from "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import type {
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
} from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import {
  BUTLER_TOOLS,
} from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { TOOL_CAPABILITY_METADATA } from
  "../../packages/butler-agent/src/agent/tools/registry.ts";
import { selectButlerToolsForTurn } from
  "../../packages/butler-agent/src/agent/tools/profiles.ts";

const FILE_TOOL_NAMES = [
  "list_files",
  "read_file",
  "grep_files",
  "write_file",
  "edit_file",
] as const;

type ToolCall = NonNullable<ModelRoundResult["toolCalls"]>[number];

function toolCall(
  id: string,
  name: string,
  arguments_: Record<string, unknown>,
): ToolCall {
  return {
    id,
    name,
    arguments: arguments_,
    rawArguments: JSON.stringify(arguments_),
  };
}

function toolResponse(call: ToolCall): ModelRoundResult {
  return { toolCalls: [call] };
}

function toolOutput(request: ModelRoundRequest, callId: string): Record<string, unknown> {
  const message = [...request.messages]
    .reverse()
    .find((candidate) => candidate.role === "tool" && candidate.toolCallId === callId);
  if (!message) throw new Error(`Missing tool result for ${callId}`);
  const payload = JSON.parse(message.content) as { output?: unknown };
  if (!payload.output || typeof payload.output !== "object" || Array.isArray(payload.output)) {
    throw new Error(`Tool result for ${callId} was not an object`);
  }
  return payload.output as Record<string, unknown>;
}

function expectNoWorkspaceRoot(output: Record<string, unknown>, workspace: string): void {
  expect(JSON.stringify(output)).not.toContain(workspace);
}

function expectRedactedCapabilityReceipts(
  output: Record<string, unknown>,
  workspace: string,
  forbiddenContent: readonly string[],
  required = true,
): void {
  const receipts = output.evidence_capability_receipts;
  if (!Array.isArray(receipts)) {
    expect(required).toBe(false);
    return;
  }
  const serialized = JSON.stringify(receipts);
  expect(serialized).not.toContain(workspace);
  for (const content of forbiddenContent) {
    expect(serialized).not.toContain(content);
  }
}

function successfulReadFiles(output: Record<string, unknown>): Array<Record<string, unknown>> {
  const files = Array.isArray(output.files) ? output.files : [];
  return files.filter((file): file is Record<string, unknown> =>
    Boolean(file) && typeof file === "object" && !Array.isArray(file) &&
    (file as Record<string, unknown>).ok === true &&
    (file as Record<string, unknown>).skipped !== true,
  );
}

function guidedTurn(
  workspacePath: string,
  accessMode: "full_access" | "read_only",
): TurnRecord {
  const turnId = `native-file-capability-${accessMode}`;
  return {
    turnId,
    sessionId: "native-file-capability-session",
    inboxId: `inbox:${turnId}`,
    triggerKey: `trigger:${turnId}`,
    originalMessageId: `message:${turnId}`,
    originalMessage: "Inspect and safely update the admitted workspace.",
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode },
      controlsHash: "native-file-capability-controls",
    },
    context: {
      userRef: "native-file-capability-user",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [`workspace:${workspacePath}`],
      executionPolicy: {
        role: "butler",
        accessMode,
        trackingMode: "local",
        requiredNativeToolProfiles: ["workspace"],
        requiredNativeTools: [],
        workspacePath,
      },
    },
    semanticState: "admitted",
    checkpoint: {
      checkpointId: `checkpoint:${turnId}`,
      checkpointRevision: 1,
      kind: "runtime",
      semanticState: "admitted",
    },
    revision: 0,
    executionFence: 0,
  };
}

function projectRunCommand(
  workspacePath: string,
  turnId: string,
): Extract<BtccRunCommand, { kind: "run" }> {
  return {
    kind: "run",
    turnId,
    sessionId: "native-file-agent-session",
    triggerKey: `message:${turnId}`,
    message: {
      messageId: `message:${turnId}`,
      content: "Inspect the workspace, review the plan, and apply the requested file changes.",
    },
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { accessMode: "full_access" },
      controlsHash: "native-file-agent-controls",
    },
    context: {
      userRef: "native-file-agent-user",
      projectRef: "native-file-agent-project",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [`workspace:${workspacePath}`],
      executionPolicy: {
        role: "butler",
        accessMode: "full_access",
        trackingMode: "ledger",
        requiredNativeToolProfiles: ["workspace", "project"],
        requiredNativeTools: [],
        workspacePath,
        projectId: "native-file-agent-project",
      },
    },
  };
}

test("native file capability registry and guided surfaces keep the five-tool contract", () => {
  const registryFileTools = BUTLER_TOOLS
    .filter((tool) => FILE_TOOL_NAMES.includes(tool.name as typeof FILE_TOOL_NAMES[number]))
    .map((tool) => tool.name);
  expect(registryFileTools.sort()).toEqual([...FILE_TOOL_NAMES].sort());
  expect(FILE_TOOL_NAMES.every((name) => TOOL_CAPABILITY_METADATA[name]?.category === "file"))
    .toBe(true);

  const workerFileTools = selectButlerToolsForTurn({
    role: "worker",
    text: "Inspect the admitted workspace.",
  })
    .filter((tool) => FILE_TOOL_NAMES.includes(tool.name as typeof FILE_TOOL_NAMES[number]))
    .map((tool) => tool.name);
  expect(workerFileTools.sort()).toEqual([...FILE_TOOL_NAMES].sort());

  const workspace = join(tmpdir(), "native-file-capability-surface");
  const readOnlyTurn = guidedTurn(workspace, "read_only");
  const readOnlyVisible = visibleToolDefinitions(
    authorizedToolDefinitions(readOnlyTurn),
    guidedPolicy(readOnlyTurn),
  )
    .filter((tool) => FILE_TOOL_NAMES.includes(tool.name as typeof FILE_TOOL_NAMES[number]))
    .map((tool) => tool.name);
  expect(readOnlyVisible.sort()).toEqual(["read_file", "grep_files", "list_files"].sort());

  const fullTurn = guidedTurn(workspace, "full_access");
  const fullVisible = visibleToolDefinitions(
    authorizedToolDefinitions(fullTurn),
    guidedPolicy(fullTurn),
  )
    .filter((tool) => FILE_TOOL_NAMES.includes(tool.name as typeof FILE_TOOL_NAMES[number]))
    .map((tool) => tool.name);
  expect(fullVisible.sort()).toEqual(["read_file", "grep_files", "list_files", "write_file", "edit_file"].sort());
});

test("production Agent tool loop discovers, continues, reviews, edits, rereads, and delivers native workspace files", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-file-agent-loop-"));
  const workspace = join(root, "workspace");
  const data = join(root, "data");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(workspace, "src", "one.txt"), "needle one\n", "utf8");
  writeFileSync(join(workspace, "src", "two.txt"), "needle two\n", "utf8");
  writeFileSync(join(workspace, "notes.txt"), "unrelated\n", "utf8");
  const dbPath = join(data, "btcc.sqlite");
  const stores = openBtccSqliteStores({
    dbPath,
    ownerId: "native-file-agent-loop",
    storageProfile: "ephemeral",
  });
  const providerCalls: string[] = [];
  const readBatchArgs = {
    requests: [{ path: "src/one.txt" }, { path: "src/two.txt" }],
    max_total_bytes: 12,
  };
  const grepArgs = {
    pattern: "needle",
    root: "src",
    max_matches: 1,
  };
  let planReviewed = false;
  let resultReviewed = false;
  let rereadRequested = false;
  let listPageCount = 0;
  let listContinuationCount = 0;
  let listTerminalPageCount = 0;
  const listedPaths: string[] = [];
  let readBatchPageCount = 0;
  let readBatchContinuationCount = 0;
  const readBatchPaths: string[] = [];
  const readBatchChunks: Array<{ path: string; content: string }> = [];
  let rereadPageCount = 0;
  let grepPageCount = 0;
  let grepContinuationCount = 0;
  const grepMatchKeys: string[] = [];

  const modelRound: ModelRoundPort = {
    async runRound(request) {
      const toolMessages = request.messages.filter((message) => message.role === "tool");
      if (toolMessages.length === 0) {
        const requestToolNames = new Set(request.tools.map((tool) => tool.name));
        expect(FILE_TOOL_NAMES.every((name) => requestToolNames.has(name))).toBe(true);
        return toolResponse(toolCall("discover-files", "tool_search", {
          provider: "native",
          category: "file",
          include_disabled: false,
          limit: 10,
        }));
      }

      const lastTool = toolMessages.at(-1)!;
      const lastOutput = toolOutput(request, lastTool.toolCallId!);
      providerCalls.push(lastTool.name!);
      switch (lastTool.name) {
        case "tool_search": {
          const results = Array.isArray(lastOutput.results) ? lastOutput.results : [];
          expect(results.map((result) => (result as { name?: string }).name).sort())
            .toEqual([...FILE_TOOL_NAMES].sort());
          expect(JSON.stringify(lastOutput)).not.toContain(workspace);
          return toolResponse(toolCall("describe-files", "tool_describe", {
            ids: FILE_TOOL_NAMES.map((name) => `native:${name}`),
          }));
        }
        case "tool_describe": {
          const descriptions = Array.isArray(lastOutput.descriptions) ? lastOutput.descriptions : [];
          expect(descriptions.map((description) => (description as { name?: string }).name).sort())
            .toEqual([...FILE_TOOL_NAMES].sort());
          expect(JSON.stringify(lastOutput)).not.toContain(workspace);
          return toolResponse(toolCall("list-via-bridge", "tool_call", {
            id: "native:list_files",
            arguments: { root: "src", max_results: 1 },
          }));
        }
        case "tool_call": {
          listPageCount += 1;
          expectNoWorkspaceRoot(lastOutput, workspace);
          expectRedactedCapabilityReceipts(lastOutput, workspace, ["needle", "edited"]);
          expect(lastOutput.bridge_invocation).toEqual({
            id: "native:list_files",
            provider: "native",
            affordance: "native_tool",
          });
          expect(lastOutput.files).toEqual([{ path: "src/one.txt", bytes: 11 }]);
          expect(lastOutput.truncated).toBe(true);
          expect(typeof lastOutput.next_cursor).toBe("string");
          const listedFiles = Array.isArray(lastOutput.files) ? lastOutput.files : [];
          listedPaths.push(...listedFiles.flatMap((file) => {
            const path = (file as Record<string, unknown>).path;
            return typeof path === "string" ? [path] : [];
          }));
          const listEvidence = (lastOutput.evidence_capability_receipts as Array<Record<string, unknown>>)[0];
          expect(listEvidence).toMatchObject({
            capability: "workspace_file_list",
            evidence_kind: "workspace_inspection",
            maturity: "candidate",
            verified: false,
          });
          expect(JSON.stringify(listEvidence)).not.toContain("needle");
          expect(JSON.stringify(listEvidence)).not.toContain("edited");
          return toolResponse(toolCall("list-continue", "list_files", {
            root: "src",
            max_results: 1,
            cursor: lastOutput.next_cursor,
          }));
        }
        case "list_files": {
          listPageCount += 1;
          expectNoWorkspaceRoot(lastOutput, workspace);
          expectRedactedCapabilityReceipts(lastOutput, workspace, ["needle", "edited"]);
          const listedFiles = Array.isArray(lastOutput.files) ? lastOutput.files : [];
          listedPaths.push(...listedFiles.flatMap((file) => {
            const path = (file as Record<string, unknown>).path;
            return typeof path === "string" ? [path] : [];
          }));
          if (lastOutput.next_cursor) {
            listContinuationCount += 1;
            expect(lastOutput.files).toEqual([{ path: "src/two.txt", bytes: 11 }]);
            return toolResponse(toolCall("list-final", "list_files", {
              root: "src",
              max_results: 1,
              cursor: lastOutput.next_cursor,
            }));
          }
          listTerminalPageCount += 1;
          expect(lastOutput.files).toEqual([]);
          return toolResponse(toolCall("read-batch", "read_file", readBatchArgs));
        }
        case "read_file": {
          expectNoWorkspaceRoot(lastOutput, workspace);
          expectRedactedCapabilityReceipts(lastOutput, workspace, ["needle", "edited"]);
          expect(lastOutput.ok).toBe(true);
          expect(lastOutput.files).toBeDefined();
          const readFiles = successfulReadFiles(lastOutput);
          if (rereadRequested) {
            rereadPageCount += 1;
            expect(lastOutput.next_cursor).toBeUndefined();
            expect(readFiles.map((file) => ({
              path: file.path,
              content: file.content,
            })).sort((left, right) => String(left.path).localeCompare(String(right.path))))
              .toEqual([
                { path: "src/one.txt", content: "edited one\n" },
                { path: "src/two.txt", content: "edited two\n" },
              ]);
          } else {
            readBatchPageCount += 1;
            readBatchPaths.push(...readFiles.flatMap((file) => {
              const path = file.path;
              return typeof path === "string" ? [path] : [];
            }));
            readBatchChunks.push(...readFiles.flatMap((file) => {
              return typeof file.path === "string" && typeof file.content === "string"
                ? [{ path: file.path, content: file.content }]
                : [];
            }));
          }
          if (lastOutput.next_cursor) {
            readBatchContinuationCount += 1;
            return toolResponse(toolCall("read-continue", "read_file", {
              ...readBatchArgs,
              cursor: lastOutput.next_cursor,
            }));
          }
          if (rereadRequested) {
            return toolResponse(toolCall("checkpoint", "record_work_checkpoint", {
              action_updates: [{ action_key: "edit-native-files", status: "done" }],
              next_stage: "review",
              public_summary: "Both edited files were reread through native tools.",
              next_step: "Deliver the completed reviewed Work.",
            }));
          }
          return toolResponse(toolCall("grep-batch", "grep_files", grepArgs));
        }
        case "grep_files": {
          grepPageCount += 1;
          expectNoWorkspaceRoot(lastOutput, workspace);
          expectRedactedCapabilityReceipts(lastOutput, workspace, ["needle", "edited"]);
          expect(lastOutput.ok).toBe(true);
          const matches = Array.isArray(lastOutput.matches) ? lastOutput.matches : [];
          expect(Array.isArray(lastOutput.matches)).toBe(true);
          grepMatchKeys.push(...matches.flatMap((match) => {
            const record = match as Record<string, unknown>;
            return typeof record.path === "string" && typeof record.line === "number"
              ? [`${record.path}:${record.line}`]
              : [];
          }));
          if (lastOutput.next_cursor) {
            grepContinuationCount += 1;
            return toolResponse(toolCall("grep-continue", "grep_files", {
              ...grepArgs,
              cursor: lastOutput.next_cursor,
            }));
          }
          return toolResponse(toolCall("plan", "replace_work_plan", {
            objective: "Review and apply the requested two-file workspace edit.",
            actions: [{
              action_key: "edit-native-files",
              description: "Apply the reviewed exact edit to both discovered files.",
              effect: {
                capability: "edit_file",
                target: "workspace:reviewed-file-batch",
              },
            }],
            checks: ["Both files contain the requested edited marker."],
          }));
        }
        case "replace_work_plan":
          return toolResponse(toolCall("plan-review", "record_work_review", {
            subject: "plan",
            verdict: "accept",
            summary: "The bounded discovery and two-file edit plan matches the request.",
          }));
        case "record_work_review": {
          if (!planReviewed) {
            planReviewed = true;
            const editBatch = {
              edits: [
                { path: "src/one.txt", old_text: "needle", new_text: "edited" },
                { path: "src/two.txt", old_text: "needle", new_text: "edited" },
              ],
            };
            expect(JSON.stringify(editBatch)).not.toMatch(/sha/u);
            return toolResponse(toolCall("edit-batch", "edit_file", editBatch));
          }
          if (!resultReviewed) {
            resultReviewed = true;
            return toolResponse(toolCall("completion-review", "record_work_review", {
              subject: "completion",
              verdict: "accept",
              next_stage: "reporting",
              summary: "The reviewed edit and reread satisfy the whole Work.",
            }));
          }
          return {
            text: "Native workspace files were reviewed, edited, reread, and delivered.",
            toolCalls: [],
          };
        }
        case "edit_file": {
          expectNoWorkspaceRoot(lastOutput, workspace);
          expectRedactedCapabilityReceipts(lastOutput, workspace, ["needle", "edited"], false);
          expect(JSON.stringify(lastOutput)).not.toContain("needle");
          expect(JSON.stringify(lastOutput)).not.toContain("edited");
          expect(lastOutput.ok).toBe(true);
          expect(lastOutput.effect).toBe("workspace_file_edit_batch");
          expect(lastOutput.effect_receipt).toMatchObject({ capability: "edit_file" });
          expect((lastOutput.effect_receipt as { target?: unknown }).target)
            .toMatch(/^workspace:batch:[a-f0-9]{64}$/u);
          rereadRequested = true;
          return toolResponse(toolCall("reread", "read_file", {
            requests: [{ path: "src/one.txt" }, { path: "src/two.txt" }],
            max_total_bytes: 1_024,
          }));
        }
        case "record_work_checkpoint":
          return toolResponse(toolCall("result-review", "record_work_review", {
            subject: "result",
            verdict: "accept",
            summary: "The two files were edited and reread through native tools.",
          }));
        default:
          throw new Error(`Unexpected tool in scripted provider: ${lastTool.name}`);
      }
    },
  };

  try {
    const agent = createProductionGuidedTurnAgent({
      butlerHome: process.cwd(),
      butlerData: data,
      appMessageDbPath: dbPath,
      contextDocuments: stores.contextDocuments,
      toolJournal: stores.guidedToolJournal,
      effectJournal: stores.guidedEffectJournal,
      durableWork: stores.durableWork,
      modelRound,
    });
    const runtime = createTurnRuntime({
      admission: stores.admission,
      turns: stores.turns,
      messages: stores.messages,
      committedSuccessorReadiness: stores.committedSuccessorReadiness,
      agent,
    });
    const turnId = "native-file-agent-loop-turn";
    const outcome = await runtime.runTurn(projectRunCommand(workspace, turnId));

    expect(outcome).toMatchObject({
      kind: "delivered",
      content: "Native workspace files were reviewed, edited, reread, and delivered.",
    });
    expect(readFileSync(join(workspace, "src", "one.txt"), "utf8"))
      .toBe("edited one\n");
    expect(readFileSync(join(workspace, "src", "two.txt"), "utf8"))
      .toBe("edited two\n");
    expect(listPageCount).toBeGreaterThanOrEqual(3);
    expect(listContinuationCount).toBeGreaterThanOrEqual(1);
    expect(listTerminalPageCount).toBe(1);
    expect(new Set(listedPaths).size).toBe(listedPaths.length);
    expect([...new Set(listedPaths)].sort()).toEqual(["src/one.txt", "src/two.txt"]);
    expect(readBatchPageCount).toBeGreaterThanOrEqual(2);
    expect(readBatchContinuationCount).toBeGreaterThanOrEqual(1);
    expect([...new Set(readBatchPaths)].sort()).toEqual(["src/one.txt", "src/two.txt"]);
    expect(readBatchChunks.length).toBeGreaterThanOrEqual(3);
    expect(new Set(readBatchChunks.map((chunk) => `${chunk.path}:${chunk.content}`)).size)
      .toBe(readBatchChunks.length);
    const readBatchContent = new Map<string, string>();
    for (const chunk of readBatchChunks) {
      readBatchContent.set(chunk.path, `${readBatchContent.get(chunk.path) ?? ""}${chunk.content}`);
    }
    expect(readBatchContent.get("src/one.txt")).toBe("needle one\n");
    expect(readBatchContent.get("src/two.txt")).toBe("needle two\n");
    expect(rereadPageCount).toBe(1);
    expect(grepPageCount).toBeGreaterThanOrEqual(2);
    expect(grepContinuationCount).toBeGreaterThanOrEqual(1);
    expect(new Set(grepMatchKeys).size).toBe(grepMatchKeys.length);
    expect([...new Set(grepMatchKeys)].sort()).toEqual(["src/one.txt:1", "src/two.txt:1"]);
    expect(providerCalls).not.toContain("run_command");
    expect(JSON.stringify(providerCalls)).not.toMatch(/python/iu);

    const work = await stores.durableWork.boundWorkForTurn(turnId);
    expect(work).toMatchObject({
      status: "completed",
      latestPlanReview: { verdict: "accept" },
      latestResultReview: { verdict: "accept" },
      latestCompletionValidation: { verdict: "accept" },
    });
    const effects = stores.guidedEffectJournal.listForWork(work!.workId);
    expect(effects).toHaveLength(1);
    const effect = effects[0]!;
    expect(effect.status).toBe("applied");
    expect(effect.sanitizedTarget).toMatch(/^workspace:batch:[a-f0-9]{64}$/u);
    expect(JSON.stringify(effect)).not.toContain(workspace);
    expect(JSON.stringify(effect)).not.toContain("needle");
    expect(JSON.stringify(effect)).not.toContain("edited");
  } finally {
    stores.close();
    rmSync(root, { recursive: true, force: true });
  }
});
