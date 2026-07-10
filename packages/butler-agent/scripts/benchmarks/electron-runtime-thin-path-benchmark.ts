import { spawn, type ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createAppServer } from "../../src/gateways/app/interface/server/create-app-server.ts";
import { NativeToolLoopRuntime } from "../../src/agent/turn/native-tool-loop.ts";
import {
  runFunctionToolPromptText,
  runPromptText,
  type FunctionToolPromptOptions,
} from "../../src/integrations/providers/provider.ts";
import { modelSupportsJsonSchemaResponseFormat } from "../../src/integrations/providers/model-catalog.ts";
import { readPromptCacheMetrics } from "../../src/integrations/providers/prompt-cache-metrics.ts";
import { readOperationalMetricEvents } from "../../src/operations/metrics/operational-metrics.ts";
import { loadPrivateEnvIntoProcess } from "../../src/interfaces/cli/private-env.ts";
import type { ModelProviderAdapter } from "../../src/test-support/harness/contracts.ts";
import { AppGatewayBridge } from "../../../../tests/support/app-gateway-bridge.ts";

type BenchPromptKind = "review" | "context-answer" | "tool-required";
type PromptOptions = Parameters<typeof runPromptText>[0];

interface BenchPrompt {
  id: string;
  kind: BenchPromptKind;
  text: string;
}

interface FetchMetric {
  status: number;
  durationMs: number;
  requestBytes: number;
  toolCount: number;
  messageCount: number;
  promptTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
}

interface PromptMetric {
  id: string;
  kind: BenchPromptKind;
  ok: boolean;
  timedOut: boolean;
  error: string | null;
  promptChars: number;
  wallMs: number;
  firstVisibleMs: number | null;
  firstMeaningfulMs: number | null;
  textPromptCalls: number;
  toolPromptCalls: number;
  toolCalls: number;
  toolNames: Record<string, number>;
  httpRequests: number;
  requestBytes: number;
  maxToolSchemaCount: number;
  promptTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  cpuRatio: number | null;
  rssBytes: number | null;
  heapUsedBytes: number | null;
  finalChars: number;
  assistantFinalCountBefore: number;
  assistantFinalCountAfter: number;
  screenshot: string | null;
  fetches: FetchMetric[];
}

interface CdpClient {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

const BENCH_PROMPTS: BenchPrompt[] = [
  {
    id: "review-no-tools",
    kind: "review",
    text: [
      "지금까지 이야기한 버틀러의 opening decision 문제를 코드 변경 없이 설계 관점에서만 검토해줘.",
      "가능한 원인 3개와 가장 위험한 재발 조건만 짧게 정리하고, 지금 당장 파일이나 로그는 확인하지 마.",
    ].join("\n"),
  },
  {
    id: "context-answer-no-tools",
    kind: "context-answer",
    text: [
      "방금 말한 얇은 응답 경로, prompt cache, context 계측 세 가지가 서로 어떻게 연결되는지 설명해줘.",
      "새로운 조사는 하지 말고 현재 대화 맥락만 바탕으로 답해.",
    ].join("\n"),
  },
  {
    id: "repo-tool-required",
    kind: "tool-required",
    text: [
      "현재 Butler 레포에서 OpenAI prompt cache key와 retention 설정을 읽는 파일과 함수명을 실제로 확인해줘.",
      "답변에는 확인한 파일명과 함수명만 간단히 적어줘.",
    ].join("\n"),
  },
];

const root = resolve(process.env.BUTLER_HOME || process.cwd());
const electronBin = resolve(
  root,
  "packages",
  "butler-app",
  "client",
  "electron",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);
const electronAppRoot = resolve(root, "packages", "butler-app", "client", "electron");
const uiRoot = resolve(root, "packages", "butler-app", "client", "ui", "dist");
const sourceButlerData = resolve(
  process.env.BUTLER_LIVE_SOURCE_BUTLER_DATA ||
    process.env.BUTLER_DATA ||
    join(process.env.HOME || "", ".butler"),
);
const model = process.env.BUTLER_THIN_PATH_BENCH_MODEL || "zai/glm-5.2";
const reasoningEffort = process.env.BUTLER_THIN_PATH_BENCH_REASONING || "medium";
const label = process.env.BUTLER_THIN_PATH_BENCH_LABEL || "baseline";
const perPromptTimeoutMs = positiveInteger(process.env.BUTLER_THIN_PATH_BENCH_TIMEOUT_MS, 120_000);
const keepData = process.env.BUTLER_THIN_PATH_BENCH_KEEP_DATA === "1";
const outDir = resolve(process.env.BUTLER_THIN_PATH_BENCH_OUT_DIR || join(root, ".tmp", "runtime-thin-path-benchmarks"));
const screenshotDir = join(outDir, "screenshots");
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`;
const tempRoot = mkdtempSync(join(tmpdir(), `butler-electron-thin-path-${label}-`));
const originalFetch = globalThis.fetch;
const originalButlerData = process.env.BUTLER_DATA;
const originalRuntime = process.env.BUTLER_RUNTIME;

const composerSelector = "[data-test-class~=\"composer-card\"]";
const composerTextareaSelector = `${composerSelector} textarea`;
const composerSendButtonSelector = `${composerSelector} button[type="submit"]`;
const assistantMessageSelector = "article[data-test-class~=\"message\"][data-test-class~=\"assistant\"]";
const turnActivityMessageSelector = "[data-test-class~=\"turn-activity-message\"]";
const markdownDocumentSelector = "[data-test-class~=\"markdown-document\"]";
const assistantFinalMarkdownSelector =
  `${assistantMessageSelector}:not(${turnActivityMessageSelector}) ${markdownDocumentSelector}`;
const visibleProgressSelector = [
  "[data-test-class~=\"turn-activity-message\"]",
  "[data-test-class~=\"turn-work-panel\"]",
  "[data-test-class~=\"turn-work-collapsed\"]",
  "[data-test-class~=\"turn-work-block\"]",
  assistantMessageSelector,
].join(", ");
const meaningfulProgressSelector = [
  "[data-test-class~=\"turn-decision-row\"]",
  "[data-test-class~=\"turn-work-block\"]",
  assistantFinalMarkdownSelector,
].join(", ");
const FIRST_RUN_STORAGE_KEY = "butler:first-run-setup:v1";

let activeMetric: PromptMetric | null = null;

const provider: ModelProviderAdapter = {
  id: model.includes("/") ? model.split("/", 1)[0]! : "zai",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: true,
    supportsStructuredOutputs: modelSupportsJsonSchemaResponseFormat(model),
  },
  async invoke() {
    return { text: "unused" };
  },
};

try {
  assert(existsSync(electronBin), "Electron binary is missing; run npm --prefix packages/butler-app/client/electron install first.");
  assert(existsSync(join(uiRoot, "index.html")), "UI dist is missing; run npm --prefix packages/butler-app/client/ui run build first.");
  loadPrivateEnvIntoProcess(sourceButlerData);
  process.env.BUTLER_HOME = root;
  process.env.BUTLER_RUNTIME ||= "codex-api";
  mkdirSync(outDir, { recursive: true });
  mkdirSync(screenshotDir, { recursive: true });
  installFetchRecorder();

  const results: PromptMetric[] = [];
  for (const prompt of BENCH_PROMPTS) {
    console.error(`[bench:${label}] prompt ${prompt.id} start`);
    results.push(await runElectronPrompt(prompt));
    const latest = results.at(-1)!;
    console.error(`[bench:${label}] prompt ${prompt.id} done ok=${latest.ok} timeout=${latest.timedOut} wallMs=${latest.wallMs}`);
  }

  const outPath = join(outDir, `${runId}.json`);
  const summary = summarize(results);
  writeFileSync(outPath, `${JSON.stringify({
    ok: true,
    label,
    runId,
    model,
    reasoningEffort,
    perPromptTimeoutMs,
    results,
    summary,
  }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, label, runId, model, reasoningEffort, outPath, summary, results }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  if (originalRuntime === undefined) delete process.env.BUTLER_RUNTIME;
  else process.env.BUTLER_RUNTIME = originalRuntime;
  if (!keepData) rmSync(tempRoot, { recursive: true, force: true });
}

async function runElectronPrompt(prompt: BenchPrompt): Promise<PromptMetric> {
  const butlerData = join(tempRoot, prompt.id, "data");
  const electronProfile = join(tempRoot, prompt.id, "electron-profile");
  const appDbPath = join(butlerData, "app.sqlite");
  prepareButlerData(sourceButlerData, butlerData);
  process.env.BUTLER_DATA = butlerData;

  const metric: PromptMetric = {
    id: prompt.id,
    kind: prompt.kind,
    ok: false,
    timedOut: false,
    error: null,
    promptChars: prompt.text.length,
    wallMs: 0,
    firstVisibleMs: null,
    firstMeaningfulMs: null,
    textPromptCalls: 0,
    toolPromptCalls: 0,
    toolCalls: 0,
    toolNames: {},
    httpRequests: 0,
    requestBytes: 0,
    maxToolSchemaCount: 0,
    promptTokens: null,
    cachedTokens: null,
    totalTokens: null,
    cpuRatio: null,
    rssBytes: null,
    heapUsedBytes: null,
    finalChars: 0,
    assistantFinalCountBefore: 0,
    assistantFinalCountAfter: 0,
    screenshot: null,
    fetches: [],
  };

  const runtime = new NativeToolLoopRuntime({
    butlerHome: root,
    butlerData,
    appMessageDbPath: appDbPath,
    disableAutomaticRecall: true,
    messageLanguage: "ko",
    runPromptText: async (options: PromptOptions) => {
      metric.textPromptCalls += 1;
      return await runPromptText(options);
    },
    runFunctionToolPromptText: async (options: FunctionToolPromptOptions) => {
      metric.toolPromptCalls += 1;
      return await runFunctionToolPromptText({
        ...options,
        executeTool: async (call) => {
          metric.toolCalls += 1;
          metric.toolNames[call.name] = (metric.toolNames[call.name] || 0) + 1;
          return await options.executeTool(call);
        },
      });
    },
  });
  const bridge = new AppGatewayBridge({
    butlerHome: root,
    butlerData,
    runtime,
    provider,
    sessionTitleGenerator: false,
  });
  const server = createAppServer({
    dbPath: appDbPath,
    butlerData,
    butlerHome: root,
    bridgeMode: "local",
    port: 0,
    uiRoot,
    responderTimeoutMs: perPromptTimeoutMs,
    automationSchedulerIntervalMs: false,
    responder: bridge.responder,
  });
  server.store.updateSettings({
    model,
    reasoning_effort: isReasoningEffort(reasoningEffort) ? reasoningEffort : undefined,
    access_mode: "full_access",
  });

  let electronProcess: ChildProcess | null = null;
  let cdp: CdpClient | null = null;
  const output: string[] = [];
  activeMetric = metric;
  let started = performance.now();
  try {
    const debugPort = await freePort();
    console.error(`[bench:${label}:${prompt.id}] launch electron`);
    electronProcess = spawn(electronBin, [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${electronProfile}`,
      electronAppRoot,
    ], {
      cwd: root,
      env: {
        ...process.env,
        BUTLER_APP_SERVER_URL: server.url,
        BUTLER_APP_UI_URL: server.url,
        BUTLER_DATA: butlerData,
        ELECTRON_ENABLE_LOGGING: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    electronProcess.stdout?.on("data", (chunk) => output.push(String(chunk)));
    electronProcess.stderr?.on("data", (chunk) => output.push(String(chunk)));

    console.error(`[bench:${label}:${prompt.id}] connect cdp`);
    cdp = await connectToElectronPage(debugPort, server.url, () => electronProcess);
    console.error(`[bench:${label}:${prompt.id}] seed first-run`);
    await completeFirstRunSetupForE2e(cdp);
    console.error(`[bench:${label}:${prompt.id}] wait composer`);
    await waitForVisible(cdp, composerTextareaSelector, "composer textarea", 60_000);
    console.error(`[bench:${label}:${prompt.id}] wait model ${model}`);
    await waitForComposerModel(cdp, model);
    metric.assistantFinalCountBefore = await assistantFinalCount(cdp);
    console.error(`[bench:${label}:${prompt.id}] send`);
    started = performance.now();
    await sendComposerTurn(cdp, prompt.text);

    console.error(`[bench:${label}:${prompt.id}] wait final`);
    await waitForFinalAndFirstVisible(cdp, metric, started);
    metric.assistantFinalCountAfter = await assistantFinalCount(cdp);
    const finalText = await lastAssistantFinalText(cdp);
    metric.finalChars = finalText.length;
    metric.wallMs = Math.round(performance.now() - started);
    applyRuntimeMetrics(metric, butlerData);
    const screenshotPath = join(screenshotDir, `${runId}-${prompt.id}.png`);
    await captureScreenshot(cdp, screenshotPath);
    if (existsSync(screenshotPath) && statSync(screenshotPath).size > 0) {
      metric.screenshot = screenshotPath;
    }
    metric.ok = true;
    return metric;
  } catch (error) {
    metric.wallMs = Math.round(performance.now() - started);
    metric.error = [
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      output.join("").trim().slice(0, 2000),
    ].filter(Boolean).join("\n");
    return metric;
  } finally {
    activeMetric = null;
    cdp?.close();
    stopElectron(electronProcess);
    server.stop();
    bridge.close();
  }
}

function installFetchRecorder(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const parsedBody = safeJson(bodyText);
    const started = performance.now();
    const recordProvider = activeMetric && shouldRecordProviderFetch(url, parsedBody);
    if (recordProvider) {
      console.error(`[bench:${label}:${activeMetric?.id}] provider fetch start bytes=${bodyText.length}`);
    }
    const response = await originalFetch(input, init);
    if (recordProvider && activeMetric) {
      const durationMs = Math.round(performance.now() - started);
      console.error(`[bench:${label}:${activeMetric.id}] provider fetch done status=${response.status} durationMs=${durationMs}`);
      const parsedResponse = await response.clone().text().then(safeJson).catch(() => null);
      const usage = parsedResponse && typeof parsedResponse === "object" && !Array.isArray(parsedResponse)
        ? (parsedResponse as Record<string, any>).usage
        : null;
      const promptTokens = numberOrNull(usage?.prompt_tokens ?? usage?.input_tokens);
      const cachedTokens = numberOrNull(usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens);
      const totalTokens = numberOrNull(usage?.total_tokens);
      const toolCount = Array.isArray((parsedBody as any)?.tools) ? (parsedBody as any).tools.length : 0;
      const messageCount = Array.isArray((parsedBody as any)?.messages) ? (parsedBody as any).messages.length : 0;
      activeMetric.fetches.push({
        status: response.status,
        durationMs,
        requestBytes: bodyText.length,
        toolCount,
        messageCount,
        promptTokens,
        cachedTokens,
        totalTokens,
      });
      activeMetric.httpRequests += 1;
      activeMetric.requestBytes += bodyText.length;
      activeMetric.maxToolSchemaCount = Math.max(activeMetric.maxToolSchemaCount, toolCount);
      activeMetric.promptTokens = sumNullable(activeMetric.promptTokens, promptTokens);
      activeMetric.cachedTokens = sumNullable(activeMetric.cachedTokens, cachedTokens);
      activeMetric.totalTokens = sumNullable(activeMetric.totalTokens, totalTokens);
    }
    return response;
  }) as typeof fetch;
}

function shouldRecordProviderFetch(url: string, body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  if (typeof record.model === "string" && record.model === model.split("/").at(-1)) return true;
  return /z\.ai|chat\/completions|responses/u.test(url) && typeof record.model === "string";
}

function prepareButlerData(source: string, target: string): void {
  copyIfExists(join(source, "butler.config.json"), join(target, "butler.config.json"), (raw) => {
    const config = JSON.parse(raw) as Record<string, any>;
    config.system = {
      ...(config.system ?? {}),
      butlerHome: root,
      butlerData: target,
      runtime: "codex-api",
      defaultModel: model,
      butlerModel: model,
    };
    return `${JSON.stringify(config, null, 2)}\n`;
  });
  copyIfExists(join(source, ".env"), join(target, ".env"));
  copyIfExists(join(source, "auth", "model-provider-credentials.json"), join(target, "auth", "model-provider-credentials.json"));
  for (const relative of [
    "eol.md",
    "personas",
    "memory/hot/cache.md",
    "memory/projects/butler.md",
    "memory/rules",
    "personalization/profile.json",
    "personalization/onboarding.json",
  ]) {
    copyTreeIfExists(join(source, relative), join(target, relative));
  }
}

function copyIfExists(source: string, target: string, transform?: (raw: string) => string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  if (transform) {
    writeFileSync(target, transform(readFileSync(source, "utf8")), "utf8");
    return;
  }
  cpSync(source, target, { recursive: true });
}

function copyTreeIfExists(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

async function sendComposerTurn(client: CdpClient, text: string): Promise<void> {
  await evaluateBoolean(client, `(() => {
    const element = document.querySelector(${JSON.stringify(composerTextareaSelector)});
    if (!(element instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(element, ${JSON.stringify(text)});
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: ${JSON.stringify(text)}, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value === ${JSON.stringify(text)};
  })()`);
  await waitForExpression(client, `(() => {
    const button = Array.from(document.querySelectorAll(${JSON.stringify(composerSendButtonSelector)})).at(-1);
    return Boolean(button && !button.disabled);
  })()`, "send button enabled", 20_000);
  await evaluateBoolean(client, `(() => {
    const button = Array.from(document.querySelectorAll(${JSON.stringify(composerSendButtonSelector)})).at(-1);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
}

function visibleProgressExpression(): string {
  return `(() => {
    return Array.from(document.querySelectorAll(${JSON.stringify(visibleProgressSelector)})).some((element) => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
  })()`;
}

async function waitForFinalAndFirstVisible(
  client: CdpClient,
  metric: PromptMetric,
  started: number,
): Promise<void> {
  const waitStarted = Date.now();
  while (Date.now() - waitStarted < perPromptTimeoutMs) {
    if (metric.firstVisibleMs === null) {
      const visible = await evaluateValue<boolean>(client, visibleProgressExpression());
      if (visible === true) metric.firstVisibleMs = Math.round(performance.now() - started);
    }
    if (metric.firstMeaningfulMs === null) {
      const meaningful = await evaluateValue<boolean>(client, meaningfulProgressExpression());
      if (meaningful === true) metric.firstMeaningfulMs = Math.round(performance.now() - started);
    }
    const finalCount = await assistantFinalCount(client);
    if (finalCount > metric.assistantFinalCountBefore) return;
    await delay(150);
  }
  metric.timedOut = true;
  throw new Error(`timed out after ${perPromptTimeoutMs}ms`);
}

function meaningfulProgressExpression(): string {
  return `(() => {
    return Array.from(document.querySelectorAll(${JSON.stringify(meaningfulProgressSelector)})).some((element) => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
  })()`;
}

function applyRuntimeMetrics(metric: PromptMetric, butlerData: string): void {
  const promptEvents = readPromptCacheMetrics({ butlerData });
  if (promptEvents.length > 0) {
    metric.promptTokens = promptEvents.reduce((sum, event) => sum + event.promptTokens, 0);
    metric.cachedTokens = promptEvents.reduce((sum, event) => sum + event.cachedTokens, 0);
    metric.totalTokens = promptEvents.reduce((sum, event) => sum + (event.totalTokens ?? 0), 0);
  }
  const processEvents = readOperationalMetricEvents({ butlerData })
    .filter((event) => event.category === "process");
  metric.cpuRatio = latestMetricValue(processEvents, "turn_cpu_ratio");
  metric.rssBytes = latestMetricValue(processEvents, "turn_memory_rss");
  metric.heapUsedBytes = latestMetricValue(processEvents, "turn_memory_heap_used");
}

function latestMetricValue(
  events: ReturnType<typeof readOperationalMetricEvents>,
  name: string,
): number | null {
  const value = events.filter((event) => event.name === name).at(-1)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function assistantFinalCount(client: CdpClient): Promise<number> {
  const result = await client.send<{ result?: { value?: number } }>("Runtime.evaluate", {
    expression: `document.querySelectorAll(${JSON.stringify(assistantFinalMarkdownSelector)}).length`,
    returnByValue: true,
  });
  return typeof result.result?.value === "number" ? result.result.value : 0;
}

async function evaluateValue<T>(client: CdpClient, expression: string): Promise<T | undefined> {
  const result = await client.send<{ result?: { value?: T } }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  return result.result?.value;
}

async function lastAssistantFinalText(client: CdpClient): Promise<string> {
  const result = await client.send<{ result?: { value?: string } }>("Runtime.evaluate", {
    expression: `(() => {
      const items = Array.from(document.querySelectorAll(${JSON.stringify(assistantFinalMarkdownSelector)}));
      return (items.at(-1)?.textContent ?? "").trim();
    })()`,
    returnByValue: true,
  });
  return typeof result.result?.value === "string" ? result.result.value : "";
}

async function waitForVisible(client: CdpClient, selector: string, label: string, timeoutMs = 20_000): Promise<void> {
  await waitForExpression(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  })()`, `${label} visible`, timeoutMs);
}

async function waitForComposerModel(client: CdpClient, modelRef: string): Promise<void> {
  const modelId = modelRef.replace(/^[^/]+\//u, "");
  await waitForExpression(client, `(() => {
    const element = document.querySelector(${JSON.stringify("[data-test-class~=\"model-button\"]")});
    const text = (element?.textContent ?? "").replace(/\\s+/g, " ").trim();
    return text.includes(${JSON.stringify(modelRef)}) || text.toLowerCase().includes(${JSON.stringify(modelId.toLowerCase())});
  })()`, `composer model ${modelRef}`, 30_000);
}

async function waitForExpression(
  client: CdpClient,
  expression: string,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  const started = Date.now();
  let lastValue = "";
  while (Date.now() - started < timeoutMs) {
    const result = await client.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    lastValue = String(result.result?.value);
    if (result.result?.value === true) return;
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${label}; last=${lastValue}`);
}

async function evaluateBoolean(client: CdpClient, expression: string): Promise<void> {
  const result = await client.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  assert(result.result?.value === true, `expression returned false: ${expression.slice(0, 160)}`);
}

async function captureScreenshot(client: CdpClient, path: string): Promise<void> {
  await client.send("Page.enable");
  const result = await client.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  writeFileSync(path, Buffer.from(result.data, "base64"));
}

async function connectToElectronPage(
  port: number,
  appUrl: string,
  electronProcess: () => ChildProcess | null,
): Promise<CdpClient> {
  const origin = new URL(appUrl).origin;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const child = electronProcess();
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`Electron exited before CDP target appeared: ${child.exitCode}`);
    }
    try {
      const targets = await originalFetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()) as CdpTarget[];
      const target = targets.find((item) =>
        item.type === "page" &&
        item.url?.startsWith(origin) &&
        item.webSocketDebuggerUrl,
      );
      if (target?.webSocketDebuggerUrl) {
        const client = await connectCdp(target.webSocketDebuggerUrl);
        await client.send("Runtime.enable");
        await client.send("Page.enable");
        return client;
      }
    } catch {
      // Retry while Electron starts and exposes the renderer target.
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for Electron page target at ${origin}.`);
}

async function completeFirstRunSetupForE2e(client: CdpClient): Promise<void> {
  const stateJson = JSON.stringify({
    schema: "butler.app.first-run.v1",
    status: "complete",
    language: "ko",
    step: "model",
    language_confirmed: true,
    safety_accepted: true,
    install_status: "ready",
    connection_mode: "bundled-agent",
    completed_at: "2026-06-15T00:00:00.000Z",
  });
  const seed = `localStorage.setItem(${JSON.stringify(FIRST_RUN_STORAGE_KEY)}, ${JSON.stringify(stateJson)});`;
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: seed });
  await client.send("Runtime.evaluate", { expression: `${seed} true`, returnByValue: true });
  await client.send("Runtime.evaluate", { expression: "location.reload(); true", returnByValue: true });
  await waitForExpression(
    client,
    `localStorage.getItem(${JSON.stringify(FIRST_RUN_STORAGE_KEY)}) === ${JSON.stringify(stateJson)}`,
    "first-run setup completion state seeded",
    20_000,
  );
}

async function connectCdp(url: string): Promise<CdpClient> {
  const socket = new WebSocket(url);
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  let nextId = 1;
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => rejectOpen(new Error(`Timed out opening CDP socket: ${url}`)), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolveOpen();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      rejectOpen(new Error(`Failed to open CDP socket: ${url}`));
    }, { once: true });
  });
  socket.addEventListener("message", (message) => {
    const payload = JSON.parse(String(message.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (!payload.id) return;
    const entry = pending.get(payload.id);
    if (!entry) return;
    pending.delete(payload.id);
    if (payload.error) entry.reject(new Error(payload.error.message ?? "CDP command failed."));
    else entry.resolve(payload.result);
  });

  return {
    send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const id = nextId;
      nextId += 1;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: (value) => resolve(value as T), reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
      for (const entry of pending.values()) entry.reject(new Error("CDP socket closed."));
      pending.clear();
    },
  };
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
    server.on("error", rejectPort);
  });
}

function stopElectron(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 1500).unref();
}

function summarize(results: PromptMetric[]) {
  const noTool = results.filter((result) => result.kind !== "tool-required");
  return {
    promptCount: results.length,
    okCount: results.filter((result) => result.ok).length,
    timedOutCount: results.filter((result) => result.timedOut).length,
    totalWallMs: results.reduce((sum, result) => sum + result.wallMs, 0),
    totalFirstMeaningfulMs: results.reduce((sum, result) => sum + (result.firstMeaningfulMs ?? 0), 0),
    totalHttpRequests: results.reduce((sum, result) => sum + result.httpRequests, 0),
    totalToolCalls: results.reduce((sum, result) => sum + result.toolCalls, 0),
    totalRequestBytes: results.reduce((sum, result) => sum + result.requestBytes, 0),
    noToolWallMs: noTool.reduce((sum, result) => sum + result.wallMs, 0),
    noToolHttpRequests: noTool.reduce((sum, result) => sum + result.httpRequests, 0),
    noToolToolCalls: noTool.reduce((sum, result) => sum + result.toolCalls, 0),
    noToolRequestBytes: noTool.reduce((sum, result) => sum + result.requestBytes, 0),
    maxToolSchemaCount: Math.max(0, ...results.map((result) => result.maxToolSchemaCount)),
  };
}

function safeJson(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumNullable(left: number | null, right: number | null): number | null {
  if (right === null) return left;
  return (left ?? 0) + right;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isReasoningEffort(value: string): value is "none" | "low" | "medium" | "high" | "xhigh" {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
