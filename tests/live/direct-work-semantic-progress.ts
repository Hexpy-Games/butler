import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FunctionToolPromptOptions } from "../../packages/butler-agent/src/integrations/providers/provider.ts";
import { runFunctionToolPromptText } from "../../packages/butler-agent/src/integrations/providers/provider.ts";
import { loadPrivateEnvIntoProcess } from "../../packages/butler-agent/src/interfaces/cli/private-env.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import { TodoListStore } from "../../packages/butler-agent/src/agent/work/todo-list.ts";
import {
  readLocalModelConfigs,
  upsertLocalModelConfig,
} from "../../packages/butler-agent/src/integrations/providers/local-models.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

const sourceButlerData = process.env.BUTLER_LIVE_SOURCE_BUTLER_DATA ||
  process.env.BUTLER_DATA ||
  join(process.env.HOME ?? "", ".butler");
const previousButlerData = process.env.BUTLER_DATA;
const previousButlerRuntime = process.env.BUTLER_RUNTIME;
const previousContinuationAttempts = process.env.BUTLER_DIRECT_WORK_CONTINUATION_ATTEMPTS;
const butlerHome = process.env.BUTLER_HOME || process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), "butler-live-direct-work-semantic-"));
const workspaceDir = join(tempDir, "workspace");
const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const model = (process.env.BUTLER_LIVE_DIRECT_WORK_MODEL || "openai/gpt-5.5") as `${string}/${string}`;
const positiveToken = `LIVE_DIRECT_WORK_SEMANTIC_OK_${runId}`;

const provider: ModelProviderAdapter = {
  id: "live-direct-work-semantic-progress",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: true,
  },
  async invoke() {
    return { text: "unused" };
  },
};

interface ObservedToolCall {
  phase: string;
  name: string;
}

interface ScenarioObservation {
  liveModelCalls: number;
  prompts: string[];
  phases: string[];
  toolCalls: ObservedToolCall[];
}

try {
  loadPrivateEnvIntoProcess(sourceButlerData);
  process.env.BUTLER_HOME = butlerHome;
  process.env.BUTLER_DATA = tempDir;
  process.env.BUTLER_RUNTIME ||= "codex-api";
  process.env.BUTLER_DIRECT_WORK_CONTINUATION_ATTEMPTS = "3";
  if (model.startsWith("local/")) copyLocalModelConfig(model, sourceButlerData, tempDir);
  initWorkspace(workspaceDir);

  const negative = await runNoSemanticProgressScenario();
  const positive = await runSemanticProgressScenario();

  console.log(JSON.stringify({
    ok: true,
    service: "live-direct-work-semantic-progress",
    model,
    checks: [
      "real-model-called",
      "real-runtime-session-created",
      "no-semantic-progress-delivered-recoverable",
      "semantic-progress-continuation-allowed",
      "durable-workstream-state-verified",
    ],
    negative,
    positive,
  }, null, 2));
} finally {
  if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = previousButlerData;
  if (previousButlerRuntime === undefined) delete process.env.BUTLER_RUNTIME;
  else process.env.BUTLER_RUNTIME = previousButlerRuntime;
  if (previousContinuationAttempts === undefined) delete process.env.BUTLER_DIRECT_WORK_CONTINUATION_ATTEMPTS;
  else process.env.BUTLER_DIRECT_WORK_CONTINUATION_ATTEMPTS = previousContinuationAttempts;
  if (process.env.BUTLER_LIVE_DIRECT_WORK_KEEP_DATA !== "1") {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runNoSemanticProgressScenario(): Promise<Record<string, unknown>> {
  const sessionId = `butler/live-direct-work-no-semantic-${runId}`;
  const observation: ScenarioObservation = { liveModelCalls: 0, prompts: [], phases: [], toolCalls: [] };
  const runtime = createRuntime(observation);
  const handle = await runtime.createSession({
    sessionId,
    role: "butler",
    workspacePath: workspaceDir,
    systemPrompt: [
      "You are Butler in a live E2E validation.",
      "Follow the user's explicit tool-use instructions exactly.",
      "When a prompt asks for Direct Work Continuation or Goal Completion Continuation, do not update the todo list or work stream.",
      "In those continuation/review prompts, you must call exactly one tool before answering: run_command with command `git status --short`.",
      "After that one run_command call, say the original todo remains unfinished.",
    ].join("\n"),
  });

  const result = await runtime.runTurn({
    handle,
    provider,
    model,
    input: {
      text: [
        "Live E2E negative case.",
        "Create a direct WorkStream by calling update_todo_list with exactly one in_progress execution todo.",
        "The todo content should be: verify status-only continuation rejection.",
        "Do not complete the todo and do not call run_command in the initial tool loop.",
        "If the runtime asks you to continue or review completion, call run_command with `git status --short` exactly once, then leave the todo unfinished.",
        "Then answer briefly that the todo remains unfinished.",
      ].join("\n"),
    },
    metadata: {
      runtimePolicy: { completionReview: "enabled" },
      requiredNativeTools: ["update_todo_list", "run_command"],
    },
  });

  assert(observation.liveModelCalls >= 2, `negative scenario did not call the real model enough times: ${observation.liveModelCalls}`);
  assert(
    observation.toolCalls.some((call) => call.name === "update_todo_list"),
    "negative scenario did not create a direct WorkStream",
  );
  assert(
    /not complete|완료라고 보고할 수|unfinished|todo remains unfinished/i.test(result.text),
    `negative scenario produced an unexpected limited delivery: ${result.text}`,
  );
  const continuationPromptObserved = observation.phases.some((phase) =>
    phase === "direct_work_continuation" ||
    phase === "goal_completion_review" ||
    phase === "goal_completion_continuation",
  ) || observation.prompts.some((prompt) =>
    prompt.includes("Direct Work Continuation") || prompt.includes("Goal Completion Continuation"),
  );
  assert(continuationPromptObserved, "negative scenario did not reach a real continuation/review prompt");
  const statusOnlyContinuationToolCallObserved = observation.toolCalls.some((call) =>
    call.phase === "direct_work_continuation" && call.name === "run_command",
  );
  assert(
    statusOnlyContinuationToolCallObserved,
    "negative scenario did not execute the status-only tool call inside direct_work_continuation",
  );
  const stream = activeOrLatestStream(sessionId);
  assert(stream?.state === "recoverable", `status-only scenario did not leave WorkStream recoverable: ${JSON.stringify(stream)}`);
  const todos = stream?.todo_list_id ? todoItems(stream.todo_list_id) : [];
  assert(todos.some((item) => item.status === "in_progress" || item.status === "pending"), "negative scenario has no unfinished todo evidence");

  return {
    deliveredWithRecoverableWork: true,
    textPreview: result.text.slice(0, 240),
    liveModelCalls: observation.liveModelCalls,
    phases: observation.phases,
    toolCalls: observation.toolCalls,
    continuationPromptObserved,
    statusOnlyContinuationToolCallObserved,
    workStream: publicStream(stream),
    todos: publicTodos(todos),
  };
}

async function runSemanticProgressScenario(): Promise<Record<string, unknown>> {
  const sessionId = `butler/live-direct-work-semantic-${runId}`;
  const observation: ScenarioObservation = { liveModelCalls: 0, prompts: [], phases: [], toolCalls: [] };
  const runtime = createRuntime(observation);
  const handle = await runtime.createSession({
    sessionId,
    role: "butler",
    workspacePath: workspaceDir,
    systemPrompt: [
      "You are Butler in a live E2E validation.",
      "Follow the user's explicit tool-use instructions exactly.",
      "Keep the answer concise and include the validation token when the requested command succeeds.",
    ].join("\n"),
  });

  const result = await runtime.runTurn({
    handle,
    provider,
    model,
    input: {
      text: [
        "Live E2E positive case.",
        "Complete this directly in one turn.",
        "First call update_todo_list with phase-tagged steps for planning, execution, review, and reporting.",
        `Then call run_command with command: printf '${positiveToken}\\n'`,
        "After the command succeeds, call update_todo_list again with every todo completed.",
        `Final answer must include this validation token: ${positiveToken}`,
      ].join("\n"),
    },
    metadata: {
      runtimePolicy: { completionReview: "enabled" },
      requiredNativeTools: ["update_todo_list", "run_command"],
    },
  });

  assert(observation.liveModelCalls >= 1, "positive scenario did not call the real model");
  assert(
    observation.toolCalls.some((call) => call.name === "update_todo_list"),
    "positive scenario did not update todo list",
  );
  assert(
    observation.toolCalls.some((call) => call.name === "run_command"),
    "positive scenario did not execute the validation command",
  );
  assert(result.text.includes(positiveToken), "positive scenario final answer did not include the validation token");
  const stream = activeOrLatestStream(sessionId, true);
  assert(stream?.state === "complete", `positive scenario did not complete WorkStream: ${JSON.stringify(stream)}`);
  const todos = stream.todo_list_id ? todoItems(stream.todo_list_id) : [];
  assert(todos.length > 0 && todos.every((item) => item.status === "completed"), "positive scenario todos were not all completed");

  return {
    completed: true,
    validationTokenIncluded: result.text.includes(positiveToken),
    liveModelCalls: observation.liveModelCalls,
    phases: observation.phases,
    toolCalls: observation.toolCalls,
    workStream: publicStream(stream),
    todos: publicTodos(todos),
    finalPreview: result.text.slice(0, 240),
  };
}

function createRuntime(observation: ScenarioObservation): NativeToolLoopRuntime {
  return new NativeToolLoopRuntime({
    butlerHome,
    butlerData: tempDir,
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    runFunctionToolPromptText: async (input: FunctionToolPromptOptions) => {
      observation.liveModelCalls += 1;
      observation.prompts.push(input.prompt);
      const phase = input.usageAttribution?.phase ?? "unknown";
      observation.phases.push(phase);
      return await runFunctionToolPromptText({
        ...input,
        executeTool: async (call) => {
          observation.toolCalls.push({ phase, name: call.name });
          return await input.executeTool(call);
        },
      });
    },
  });
}

function initWorkspace(dir: string): void {
  const mkdir = spawnSync("mkdir", ["-p", dir], { encoding: "utf8" });
  assert(mkdir.status === 0, `failed to create workspace: ${mkdir.stderr}`);
  writeFileSync(join(dir, "README.md"), `# live direct work semantic progress ${runId}\n`, "utf8");
  const gitInit = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  assert(gitInit.status === 0, `git init failed: ${gitInit.stderr}`);
}

function activeOrLatestStream(sessionId: string, includeTerminal = false): any {
  const store = new WorkStreamStore(tempDir);
  return store.activeForSession(sessionId) ??
    store.list({ sessionId, includeTerminal }).at(0) ??
    null;
}

function todoItems(listId: string): Array<{ id: string; content: string; status: string; phase?: string }> {
  return new TodoListStore(tempDir).view(listId, { includeCompleted: true }).list.items.map((item) => ({
    id: item.id,
    content: item.content,
    status: item.status,
    phase: item.phase ?? undefined,
  }));
}

function publicStream(stream: any): Record<string, unknown> | null {
  if (!stream) return null;
  return {
    id: stream.id,
    title: stream.title,
    state: stream.state,
    current_phase: stream.current_phase,
    active_step_id: stream.active_step_id,
    todo_list_id: stream.todo_list_id,
  };
}

function publicTodos(todos: Array<{ id: string; content: string; status: string; phase?: string }>): Array<Record<string, unknown>> {
  return todos.map((item) => ({
    id: item.id,
    content: item.content,
    status: item.status,
    phase: item.phase ?? null,
  }));
}

function copyLocalModelConfig(modelRef: string, source: string, target: string): void {
  const modelConfig = readLocalModelConfigs(source)
    .find((candidate) => candidate.model_ref === modelRef || candidate.model_id === modelRef.replace(/^local\//u, ""));
  if (!modelConfig) throw new Error(`local model ${modelRef} is not registered in source Butler data`);
  upsertLocalModelConfig({
    serverUrl: modelConfig.server_url,
    apiType: modelConfig.api_type,
    platform: modelConfig.platform,
    modelId: modelConfig.model_id,
    displayName: modelConfig.display_name,
    contextWindowTokens: modelConfig.context_window_tokens,
    maxOutputTokens: modelConfig.max_output_tokens,
    reasoningBudgetRatio: modelConfig.reasoning_budget_ratio,
    source: modelConfig.source,
  }, target);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    if (process.env.BUTLER_LIVE_DIRECT_WORK_KEEP_DATA === "1") {
      const transcripts = existsSync(join(tempDir, "transcripts"))
        ? readdirSync(join(tempDir, "transcripts")).map((file) => readFileSync(join(tempDir, "transcripts", file), "utf8").slice(0, 400))
        : [];
      throw new Error(`${message}\nBUTLER_DATA=${tempDir}\ntranscriptPreviews=${JSON.stringify(transcripts)}`);
    }
    throw new Error(message);
  }
}
