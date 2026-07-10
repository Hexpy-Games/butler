import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { loadPrivateEnvIntoProcess } from "../../packages/butler-agent/src/interfaces/cli/private-env.ts";
import { NativeToolLoopRuntime } from "../../packages/butler-agent/src/agent/turn/native-tool-loop.ts";
import {
  readLocalModelConfigs,
  upsertLocalModelConfig,
} from "../../packages/butler-agent/src/integrations/providers/local/models.ts";

const butlerHome = process.env.BUTLER_HOME || process.cwd();
const sourceButlerData = process.env.BUTLER_LIVE_SOURCE_BUTLER_DATA ||
  process.env.BUTLER_DATA ||
  join(process.env.HOME ?? "", ".butler");
const previousButlerData = process.env.BUTLER_DATA;
const tempDir = mkdtempSync(join(tmpdir(), "butler-live-decision-context-"));
const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const validationToken = `LIVE_DECISION_CONTEXT_OK_${runId}`;

const provider: ModelProviderAdapter = {
  id: "live-decision-context",
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

try {
  loadPrivateEnvIntoProcess(sourceButlerData);
  process.env.BUTLER_HOME = butlerHome;
  process.env.BUTLER_DATA = tempDir;
  process.env.BUTLER_RUNTIME ||= "codex-api";

  const model = (process.env.BUTLER_LIVE_DECISION_MODEL || "openai/gpt-5.5") as `${string}/${string}`;
  if (model.startsWith("local/")) copyLocalModelConfig(model, sourceButlerData, tempDir);

  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const runtime = new NativeToolLoopRuntime({
    butlerHome,
    butlerData: tempDir,
    disableAutomaticRecall: true,
    messageLanguage: "ko",
  });
  const handle = await runtime.createSession({
    sessionId: `butler/live-decision-context-${runId}`,
    role: "butler",
    workspacePath: butlerHome,
    systemPrompt: "You are Butler. Be concise, autonomous, and evidence-grounded.",
  });

  const userPrompt = [
    "실제 중형 작업 검증입니다.",
    "대한민국 주요 도시 3곳의 인구 예시를 수집해 작은 보고서를 작성해 주세요.",
    "공개 웹에서 Worldometer의 South Korea cities by population 페이지 후보를 먼저 찾아보고, 해당 공개 출처 페이지를 직접 열어 Seoul/Busan/Daegu 3행 이상의 도시-인구 값을 확인해 주세요.",
    "세 도시 값이 확인되면 추가 검색을 멈추고 실제 작은 CSV 파일 산출물을 생성한 뒤 결과를 요약해 주세요. 화면에 CSV 텍스트만 쓰는 것은 파일 산출물로 보지 않습니다.",
    `성공하면 최종 답변 어딘가에 이 검증 토큰을 포함하세요: ${validationToken}`,
  ].join("\n");
  assertNaturalUserPrompt(userPrompt);

  const result = await runtime.runTurn({
    handle,
    provider,
    model,
    input: {
      text: userPrompt,
    },
    metadata: {
      runtimePolicy: {
        completionReview: "enabled",
      },
    },
    emitTurnEvent: (event) => {
      events.push({ kind: event.kind, payload: event.payload });
    },
  });

  const completedTools = events
    .filter((event) => event.kind === "tool.completed")
    .map((event) => String(event.payload?.toolName ?? event.payload?.safeLabel ?? ""));
  const toolCallNames = events
    .filter((event) => event.kind === "tool.completed")
    .map((event) => String(event.payload?.decisionSummary ?? ""));
  const decisionSummaries = toolCallNames.filter(Boolean);
  assertSafePublicDecisionSummaries(decisionSummaries);
  const durableTools = durableToolCalls(tempDir);
  const requiredTools = ["web_search", "web_read", "transform_public_data_table"];
  assertRequiredToolOrder(durableTools, requiredTools, "durable transcript");
  assertRequiredToolOrder(publicToolNamesFromEvents(events), requiredTools, "turn events");
  if (!result.text.trim()) {
    throw new Error("final answer was empty");
  }
  if (/이전 어느 내용을|대화 맥락|which earlier|cannot verify which earlier/iu.test(result.text)) {
    throw new Error("final answer fell back to a local-reference clarification instead of reporting the task outcome");
  }
  for (const forbidden of requiredTools) {
    if (result.text.includes(forbidden)) {
      throw new Error(`final answer exposed raw tool name: ${forbidden}`);
    }
  }
  const publicDecisionEvents = events.filter((event) =>
    event.kind === "work.block.started" &&
    typeof event.payload?.decisionSummary === "string" &&
    typeof event.payload.decisionRationale === "string",
  );
  const assistantAuthoredDecisionEvents = publicDecisionEvents.filter((event) =>
    event.kind === "work.block.started" &&
    (event.payload?.decisionSource === "assistant-authored" || event.payload?.decisionSource === "review-repaired") &&
    typeof event.payload.decisionSummary === "string" &&
    typeof event.payload.decisionRationale === "string",
  );
  if (publicDecisionEvents.length < 3) {
    throw new Error(`expected at least 3 public decisions, observed ${publicDecisionEvents.length}`);
  }
  if (assistantAuthoredDecisionEvents.length < 1) {
    throw new Error(`expected at least 1 assistant-authored or repaired public decision, observed ${assistantAuthoredDecisionEvents.length}`);
  }
  if (!publicDataArtifactExists(tempDir)) {
    throw new Error("transform_public_data_table did not write a CSV artifact");
  }

  console.log(JSON.stringify({
    ok: true,
    service: "live-decision-context-medium-task",
    model,
    validationToken,
    validationTokenIncluded: result.text.includes(validationToken),
    toolCalls: durableTools,
    completedToolLabels: completedTools,
    decisionSummaries,
    decisionSourceCounts: decisionSourceCounts(publicDecisionEvents),
    publicDecisionCount: publicDecisionEvents.length,
    assistantAuthoredDecisionCount: assistantAuthoredDecisionEvents.length,
    finalChars: result.text.length,
    finalPreview: result.text.slice(0, 400),
    artifactWritten: true,
  }, null, 2));
} finally {
  if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = previousButlerData;
  rmSync(tempDir, { recursive: true, force: true });
}

function assertNaturalUserPrompt(prompt: string): void {
  const forbidden = [
    "web_search",
    "web_read",
    "transform_public_data_table",
    "작업/이유/다음",
    "Work/Why/Next",
    "숨은 reasoning",
    "raw tool",
    "raw payload",
    "tool payload",
    "도구 호출",
    "툴 호출",
    "도구명",
    "툴 호출 순서",
  ];
  const hit = forbidden.find((value) => prompt.includes(value));
  if (hit) throw new Error(`live medium task prompt leaks validation contract text: ${hit}`);
}

function assertSafePublicDecisionSummaries(summaries: string[]): void {
  const forbidden = [
    "FileNotFoundException",
    "root_path",
    "butler-workers",
    "ENOENT",
    "/tmp/",
    "/Users/",
    "raw-payload",
    "raw payload",
    "tool payload",
  ];
  for (const summary of summaries) {
    const hit = forbidden.find((value) => summary.includes(value));
    if (hit) throw new Error(`live medium task public decision leaked internal text: ${hit}`);
  }
}

function decisionSourceCounts(events: Array<{ kind: string; payload?: Record<string, unknown> }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const source = typeof event.payload?.decisionSource === "string"
      ? event.payload.decisionSource
      : "unknown";
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
}

function copyLocalModelConfig(modelRef: string, source: string, target: string): void {
  const model = readLocalModelConfigs(source)
    .find((candidate) => candidate.model_ref === modelRef || candidate.model_id === modelRef.replace(/^local\//u, ""));
  if (!model) throw new Error(`local model ${modelRef} is not registered in source Butler data`);
  upsertLocalModelConfig({
    serverUrl: model.server_url,
    apiType: model.api_type,
    platform: model.platform,
    modelId: model.model_id,
    displayName: model.display_name,
    contextWindowTokens: model.context_window_tokens,
    maxOutputTokens: model.max_output_tokens,
    reasoningBudgetRatio: model.reasoning_budget_ratio,
    source: model.source,
  }, target);
}

function publicToolNamesFromEvents(events: Array<{ kind: string; payload?: Record<string, unknown> }>): string[] {
  return events
    .filter((event) => event.kind === "tool.completed")
    .map((event) => {
      const label = String(event.payload?.safeLabel ?? event.payload?.toolName ?? "");
      if (label.startsWith("Web search")) return "web_search";
      if (label.startsWith("Reading public source") || label.startsWith("Web read")) return "web_read";
      if (label.startsWith("Transforming public data table")) return "transform_public_data_table";
      return label;
    });
}

function durableToolCalls(butlerData: string): string[] {
  const dir = join(butlerData, "transcripts");
  if (!existsSync(dir)) return [];
  const names: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    const text = readFileSync(join(dir, file), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as { kind?: string; payload?: { name?: unknown } };
        if (event.kind === "tool_call" && typeof event.payload?.name === "string") names.push(event.payload.name);
      } catch {
        // Ignore malformed transcript lines.
      }
    }
  }
  return names;
}

function publicDataArtifactExists(butlerData: string): boolean {
  const dir = join(butlerData, "artifacts", "public-data");
  return existsSync(dir) && readdirSync(dir).some((file) => file.endsWith(".csv"));
}

function assertRequiredToolOrder(actual: string[], required: string[], label: string): void {
  let cursor = 0;
  for (const item of actual) {
    if (item === required[cursor]) cursor += 1;
    if (cursor === required.length) return;
  }
  throw new Error(`required tool order not observed in ${label}: ${actual.join(" -> ")}`);
}
