#!/usr/bin/env bun
import { spawn, spawnSync } from "child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import { buildMetricsStatus } from "../../../scripts/metrics-status.ts";
import { buildContextStats } from "../../../scripts/status-context.ts";
import { compactTranscript } from "../../agent/context/compaction.ts";
import { pruneContextMetricFiles } from "../../agent/context/metrics-retention.ts";
import { pruneToolOutputArtifacts } from "../../agent/context/tool-output-budgeter.ts";
import {
  applyCognitionNamespaceMigration,
  buildCognitionNamespaceMigrationPlan,
} from "../../agent/cognition/migration.ts";
import {
  aggregateSourceQuality,
  listKnowHowEntries,
  readKnowHowEntry,
  rebuildKnowHowIndex,
  retrieveKnowHow,
  writeKnowHowEntry,
} from "../../agent/cognition/know-how/store.ts";
import {
  addFeedbackEntry,
  clearResolvedFeedbackEntries,
  listFeedbackEntries,
  readFeedbackEntry,
  resolveFeedbackEntry,
  type FeedbackEntry,
  type FeedbackResolveStatus,
} from "../../agent/cognition/feedback/buffer.ts";
import { runCognitionConsolidationCycle } from "../../agent/cognition/consolidation/cycle.ts";
import {
  boxItemRoot,
  boxItemSummary,
  listIndexedBoxItems,
  readBoxManifest,
  rebuildBoxIndex,
  writeBoxManifest,
} from "../../agent/cognition/box/store.ts";
import { MockTransportAdapter } from "../transport/mock/adapter.ts";
import { parseModelRef } from "../../integrations/providers/model-ref.ts";
import { FALLBACK_OPENAI_MODELS } from "../../integrations/providers/openai-models.ts";
import { inspectProjectCapsule } from "../../agent/cognition/memory/project-memory.ts";
import {
  checkMemoryMetadataIntegrity,
  readMemoryChunkWithRefs,
  repairMemoryMetadataIntegrity,
} from "../../agent/cognition/memory/metadata.ts";
import { readMemoryHealth } from "../../agent/cognition/memory/quality.ts";
import { recallMemory } from "../../agent/cognition/memory/recall/engine.ts";
import { tailOperationalMetricEvents } from "../../operations/metrics/operational-metrics.ts";
import { listServices } from "../../operations/service/native-service-supervisor.ts";
import {
  applyComponentUpdate,
  checkComponentUpdates,
  normalizeUpdateComponentId,
  renderServiceUpdateResult,
  type UpdateComponentId,
} from "../../operations/update/component-updater.ts";
import { readWebSearchMetrics } from "../../integrations/search/provider.ts";
import { createConfiguredWebSearchProvider } from "../../integrations/search/provider.ts";
import { configuredPageReaderBackend, readPageConfigured } from "../../integrations/search/page-reader.ts";
import {
  PERSONALIZATION_PROFILE_STORAGE_LABEL,
  readPersonalizationProfile,
  updatePersonalizationProfile,
  type PersonalizationProfileUpdate,
} from "../../personalization/profile.ts";
import {
  clearProfilingData,
  importProfileCandidatesFromThirdPartyDumpWithModel,
  PROFILE_BLACK_BOX_STORAGE_LABEL,
  profileThirdPartyMigrationPrompt,
  readProfilingExtractorModelConfig,
  readProfilingConsentSnapshot,
  setProfilingExtractorModel,
  setProfilingMode,
} from "../../personalization/profiling.ts";
import { TaskStore } from "../../agent/work/task-store.ts";
import { performWorkControl, createWorkDashboard, renderWorkDashboard, type WorkDashboard } from "../../agent/work/work-dashboard.ts";
import { parseCommonOptions, type ParsedCommonOptions } from "./args.ts";
import { renderJsonEnvelope } from "./output.ts";
import {
  loadPrivateEnvIntoProcess,
  privateEnvPath,
  readPrivateEnv,
  upsertPrivateEnvValue,
} from "./private-env.ts";
import {
  buildTelegramCliStatus,
  pairTelegramChat,
  redactTelegramToken,
  sendTelegramTestMessage,
  unpairTelegramChat,
} from "./telegram.ts";
import {
  deleteMcpServer,
  listMcpServers,
  updateMcpServer,
  upsertMcpServer,
  type McpKeyValueSecret,
  type McpServerUpsertInput,
  type McpTransportKind,
} from "../mcp-client/registry.ts";
import { probeMcpServer } from "../mcp-client/client.ts";
import {
  importSkillZip,
  listSkillProjectsInDataHome,
  skillSettingsView,
  validateSkillSettings,
  type SkillSummaryView,
} from "../../integrations/skills/manager.ts";
import {
  appGatewayLogPaths,
  assertGatewayId,
  buildGatewayStatusView,
  clearAppGatewayPid,
  GATEWAY_DEFINITIONS,
  isProcessAlive,
  patchGatewaySettings,
  readAppGatewayPid,
  readGatewaySettings,
  removeGatewayConfigKeys,
  resolveAppGatewayRuntimeConfig,
  resolveTelegramGatewayRuntimeConfig,
  updateTelegramCompatibilityConfig,
  writeAppGatewayPid,
} from "../../operations/gateway/registry.ts";

type JsonRecord = Record<string, any>;

const SAFE_CONFIG_PATHS = new Set([
  "user.language",
  "user.techLanguage",
  "user.timezone",
  "system.defaultModel",
  "system.butlerModel",
  "system.workerModel",
  "system.openaiModel",
  "system.openaiReasoningEffort",
  "system.openaiPromptCacheKeyPrefix",
  "system.openaiPromptCacheRetention",
  "personalization.profiling.extractorModel",
  "webSearch.provider",
  "webSearch.readerBackend",
  "webSearch.model",
  "webSearch.apiBase",
  "webSearch.braveApiBase",
  "webSearch.tavilyApiBase",
  "webSearch.planning.enabled",
  "webSearch.planning.defaultDepth",
  "metrics.enabled",
  "metrics.retentionDays",
  "telegram.defaultFormat",
]);

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function optionValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function optionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value && !value.startsWith("--")) values.push(value);
  }
  return values;
}

function numericOption(args: string[], name: string, fallback: number, max = 500): number {
  const value = optionValue(args, name);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(max, Math.trunc(parsed)) : fallback;
}

function commandString(args: string[]): string {
  return `butler ${args.join(" ")}`.trim();
}

function fail(
  parsed: ParsedCommonOptions,
  code: string,
  message: string,
  exitCode = 2,
): never {
  if (parsed.options.json) {
    process.stdout.write(renderJsonEnvelope({
      ok: false,
      command: commandString(parsed.args),
      error: { code, message },
    }));
  } else {
    console.error(message);
  }
  process.exit(exitCode);
}

function print(
  parsed: ParsedCommonOptions,
  command: string,
  data: unknown,
  human: string,
): void {
  if (parsed.options.json) {
    process.stdout.write(renderJsonEnvelope({
      ok: true,
      command,
      data,
    }));
  } else if (!parsed.options.quiet) {
    process.stdout.write(`${human.trimEnd()}\n`);
  }
}

function requireYes(parsed: ParsedCommonOptions, message: string): void {
  if (parsed.options.yes || parsed.options.nonInteractive) return;
  fail(parsed, "invalid_arguments", `${message} requires --yes`, 2);
}

function prepareEnvironment(parsed: ParsedCommonOptions): void {
  process.env.BUTLER_HOME = parsed.options.home;
  process.env.BUTLER_DATA = parsed.options.data;
  loadPrivateEnvIntoProcess(parsed.options.data);
}

function configPath(butlerData: string): string {
  return join(butlerData, "butler.config.json");
}

function readConfig(butlerData: string): JsonRecord {
  const path = configPath(butlerData);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function valueAtPath(config: JsonRecord, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as JsonRecord)[part];
  }, config);
}

function setPath(config: JsonRecord, dottedPath: string, value: unknown): void {
  const parts = dottedPath.split(".");
  let current = config;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) current[part] = {};
    current = current[part] as JsonRecord;
  }
  current[parts.at(-1)!] = value;
}

function isSecretPath(path: string): boolean {
  return /(token|secret|password|credential|api[_-]?key|authorization|refresh)/i.test(path);
}

function parseConfigValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return value;
}

function safeValueSummary(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  }
  return value ?? null;
}

function validateConfigObject(config: JsonRecord): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const runtime = config.system?.runtime;
  if (runtime !== undefined && runtime !== "codex-api") {
    errors.push("system.runtime must be codex-api");
  }
  const provider = config.webSearch?.provider;
  if (
    provider !== undefined &&
    !["duckduckgo-html", "duckduckgo", "brave", "tavily", "openai-web-search", "codex-subscription-web-search", "auto", "mock", "disabled"].includes(String(provider))
  ) {
    errors.push("webSearch.provider is not supported");
  }
  const reader = config.webSearch?.readerBackend;
  if (
    reader !== undefined &&
    !["auto", "lightpanda", "lightweight", "jina-hosted", "disabled"].includes(String(reader))
  ) {
    errors.push("webSearch.readerBackend is not supported");
  }
  const planning = config.webSearch?.planning;
  if (planning !== undefined) {
    if (!planning || typeof planning !== "object" || Array.isArray(planning)) {
      errors.push("webSearch.planning must be an object");
    } else {
      if (planning.enabled !== undefined && typeof planning.enabled !== "boolean") {
        errors.push("webSearch.planning.enabled must be boolean");
      }
      if (planning.mode !== undefined)
        warnings.push("webSearch.planning.mode is deprecated; use webSearch.planning.enabled");
      if (planning.defaultDepth !== undefined && !["quick", "balanced", "deep"].includes(String(planning.defaultDepth))) {
        errors.push("webSearch.planning.defaultDepth is not supported");
      }
    }
  }
  const model = config.system?.defaultModel ?? config.system?.butlerModel ?? config.system?.workerModel;
  if (model !== undefined) {
    const parsed = parseModelRef(String(model));
    if (!parsed.modelId) errors.push("system model ref must include a model id");
    if (parsed.source !== "namespaced") warnings.push("system model ref will be canonicalized to provider/model form");
  }
  const profileExtractorModel = config.personalization?.profiling?.extractorModel;
  if (profileExtractorModel !== undefined && String(profileExtractorModel).trim() !== "default") {
    const parsed = parseModelRef(String(profileExtractorModel));
    if (!parsed.modelId) errors.push("personalization.profiling.extractorModel must include a model id or be default");
    if (parsed.source !== "namespaced") warnings.push("personalization.profiling.extractorModel will be canonicalized to provider/model form");
  }
  if (config.metrics?.enabled !== undefined && typeof config.metrics.enabled !== "boolean") {
    errors.push("metrics.enabled must be boolean");
  }
  return { errors, warnings };
}

function configGet(parsed: ParsedCommonOptions, args: string[]): void {
  const dottedPath = args[1];
  if (!dottedPath) fail(parsed, "invalid_arguments", "config get requires <path>");
  if (isSecretPath(dottedPath)) {
    const data = { path: dottedPath, redacted: true, exists: valueAtPath(readConfig(parsed.options.data), dottedPath) !== undefined };
    print(parsed, "butler config get", data, `${dottedPath}: [redacted]`);
    return;
  }
  const value = valueAtPath(readConfig(parsed.options.data), dottedPath);
  const data = { path: dottedPath, exists: value !== undefined, value: safeValueSummary(value) };
  print(parsed, "butler config get", data, `${dottedPath}: ${value === undefined ? "(missing)" : String(data.value)}`);
}

function configSet(parsed: ParsedCommonOptions, args: string[]): void {
  const dottedPath = args[1];
  const rawValue = args[2];
  if (!dottedPath || rawValue === undefined) fail(parsed, "invalid_arguments", "config set requires <path> <value>");
  if (isSecretPath(dottedPath)) fail(parsed, "invalid_arguments", "secret config values must use domain-specific auth commands");
  if (!SAFE_CONFIG_PATHS.has(dottedPath)) fail(parsed, "invalid_arguments", `config path is not writable through CLI: ${dottedPath}`);
  const path = configPath(parsed.options.data);
  const config = readConfig(parsed.options.data);
  const previous = valueAtPath(config, dottedPath);
  const value = parseConfigValue(rawValue);
  setPath(config, dottedPath, value);
  const validation = validateConfigObject(config);
  if (validation.errors.length > 0) fail(parsed, "health_failed", validation.errors.join("; "), 3);
  atomicWriteJson(path, config);
  const data = {
    path: dottedPath,
    oldValue: safeValueSummary(previous),
    newValue: safeValueSummary(value),
    warnings: validation.warnings,
    configPath: path,
  };
  print(parsed, "butler config set", data, `Updated ${dottedPath}.`);
}

function configValidate(parsed: ParsedCommonOptions): void {
  let config: JsonRecord;
  try {
    config = readConfig(parsed.options.data);
  } catch (error) {
    fail(parsed, "health_failed", `config JSON parse failed: ${error instanceof Error ? error.message : String(error)}`, 3);
  }
  const validation = validateConfigObject(config);
  const data = {
    ok: validation.errors.length === 0,
    configPath: configPath(parsed.options.data),
    errors: validation.errors,
    warnings: validation.warnings,
    redacted: true,
  };
  if (validation.errors.length > 0) {
    if (parsed.options.json) {
      process.stdout.write(renderJsonEnvelope({
        ok: false,
        command: "butler config validate",
        data,
        error: { code: "health_failed", message: validation.errors.join("; ") },
      }));
    } else {
      console.error(`Config invalid: ${validation.errors.join("; ")}`);
    }
    process.exit(3);
  }
  print(parsed, "butler config validate", data, `Config valid. warnings=${validation.warnings.length}`);
}

function configEdit(parsed: ParsedCommonOptions): never {
  if (parsed.options.nonInteractive) fail(parsed, "invalid_arguments", "config edit requires an interactive editor");
  const path = configPath(parsed.options.data);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) atomicWriteJson(path, {});
  const editor = process.env.EDITOR?.trim() || "vi";
  const result = spawnSync(editor, [path], { stdio: "inherit", env: process.env });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
  const validation = validateConfigObject(readConfig(parsed.options.data));
  if (validation.errors.length > 0) {
    console.error(`Config invalid after edit: ${validation.errors.join("; ")}`);
    process.exit(3);
  }
  console.log(`Config edited and validated: ${path}`);
  process.exit(0);
}

function tailFile(path: string, lines: number): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return text.split(/\r?\n/).filter(Boolean).slice(-lines);
}

function safeLogLine(line: string): string {
  return line
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]")
    .replace(/(OPENAI_API_KEY=)[^\s]+/gi, "$1[redacted]")
    .replace(/(TELEGRAM_BOT_TOKEN=)[^\s]+/gi, "$1[redacted]")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]");
}

interface LogLineView {
  file: string;
  text: string;
}

interface FollowLogState {
  file: string;
  offset: number;
  pending: string;
}

function tailLogEntries(entries: string[], lines: number): LogLineView[] {
  return entries.flatMap((file) => tailFile(file, lines).map((line) => ({
    file: basename(file),
    text: safeLogLine(line),
  }))).slice(-lines);
}

function logFollowPollMs(): number {
  const parsed = Number(process.env.BUTLER_LOG_FOLLOW_POLL_MS ?? "");
  return Number.isFinite(parsed) && parsed >= 10 ? Math.trunc(parsed) : 500;
}

function logFollowStopAfterMs(): number | null {
  const parsed = Number(process.env.BUTLER_LOG_FOLLOW_TEST_MS ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function emitFollowText(state: FollowLogState, text: string): void {
  const combined = `${state.pending}${text}`;
  const parts = combined.split(/\r?\n/);
  state.pending = combined.endsWith("\n") || combined.endsWith("\r") ? "" : parts.pop() ?? "";
  for (const line of parts) {
    if (!line) continue;
    process.stdout.write(`[${basename(state.file)}] ${safeLogLine(line)}\n`);
  }
}

function readFollowChunk(state: FollowLogState): void {
  const stat = statSync(state.file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return;
  if (stat.size < state.offset) {
    state.offset = 0;
    state.pending = "";
  }
  if (stat.size === state.offset) return;

  const fd = openSync(state.file, "r");
  try {
    while (state.offset < stat.size) {
      const length = Math.min(64 * 1024, stat.size - state.offset);
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, buffer, 0, length, state.offset);
      if (bytesRead <= 0) break;
      state.offset += bytesRead;
      emitFollowText(state, buffer.toString("utf8", 0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
}

function followLogFiles(entries: string[]): void {
  const states: FollowLogState[] = entries.map((file) => ({
    file,
    offset: statSync(file, { throwIfNoEntry: false })?.size ?? 0,
    pending: "",
  }));
  const pollMs = logFollowPollMs();
  const stopAfterMs = logFollowStopAfterMs();
  let stopped = false;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;

  const timer = setInterval(() => {
    for (const state of states) readFollowChunk(state);
  }, pollMs);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (stopTimer) clearTimeout(stopTimer);
    for (const state of states) {
      if (state.pending) {
        process.stdout.write(`[${basename(state.file)}] ${safeLogLine(state.pending)}\n`);
        state.pending = "";
      }
    }
    process.exit(0);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (stopAfterMs) stopTimer = setTimeout(stop, stopAfterMs);
}

function maybeFollowLogs(parsed: ParsedCommonOptions, args: string[], entries: string[]): void {
  if (!hasFlag(args, "--follow")) return;
  if (parsed.options.json || parsed.options.quiet) return;
  followLogFiles(entries);
}

function logs(parsed: ParsedCommonOptions, args: string[]): void {
  const service = optionValue(args, "--service") || "butler-main";
  const lines = numericOption(args, "--lines", 80, 1_000);
  const logDir = join(parsed.options.data, "logs");
  const candidates = service === "butler-main"
    ? ["butler-out.log", "butler-err.log"]
    : [`${service}-out.log`, `${service}-err.log`, `${service}.log`];
  const entries = candidates.map((name) => join(logDir, name)).filter(existsSync);
  if (entries.length === 0) fail(parsed, "not_found", `no logs found for service ${service}`, 1);
  const data = {
    service,
    files: entries,
    lines: tailLogEntries(entries, lines),
    follow: hasFlag(args, "--follow"),
  };
  print(parsed, "butler logs", data, data.lines.map((line) => `[${line.file}] ${line.text}`).join("\n") || "No log lines found.");
  maybeFollowLogs(parsed, args, entries);
}

function ps(parsed: ParsedCommonOptions): void {
  const services = listServices({
    butlerHome: parsed.options.home,
    butlerData: parsed.options.data,
  }).map((service) => ({
    name: service.serviceId,
    pid: service.pid,
    status: service.status,
    supervisor: service.supervisor,
    startedAt: service.startedAt,
    restartPolicy: service.restartPolicy,
    stdoutFile: service.stdoutFile,
    stderrFile: service.stderrFile,
  }));
  const data = { source: "native-supervisor", services };
  print(parsed, "butler ps", data, services.length
    ? services.map((service) => `${service.name}: ${service.status} pid=${service.pid ?? "none"}`).join("\n")
    : "No Butler native services found.");
}

function metricsTail(parsed: ParsedCommonOptions, args: string[]): void {
  const lines = numericOption(args, "--lines", 20, 500);
  const events = tailOperationalMetricEvents({
    butlerData: parsed.options.data,
    lines,
  });
  const data = { events, lines, enabled: buildMetricsStatus({ butlerData: parsed.options.data }).enabled };
  print(parsed, "butler metrics tail", data, events.length
    ? events.map((event) => `${new Date(event.ts).toISOString()} ${event.category}:${event.name} ${event.status}`).join("\n")
    : "No operational metrics found.");
}

function authLogout(parsed: ParsedCommonOptions): void {
  requireYes(parsed, "auth logout");
  const profilePath = process.env.BUTLER_CODEX_AUTH_PROFILE ||
    process.env.BUTLER_OPENAI_AUTH_PROFILE ||
    join(parsed.options.data, "auth", "openai-codex.json");
  const existed = existsSync(profilePath);
  if (existed) rmSync(profilePath, { force: true });
  const data = {
    removed: existed,
    profilePath,
    envPath: privateEnvPath(parsed.options.data),
    apiKeyEnvUntouched: true,
    redacted: true,
  };
  print(parsed, "butler auth logout", data, existed ? "Local auth profile removed." : "No local auth profile was present.");
}

async function modelList(parsed: ParsedCommonOptions): Promise<void> {
  const refs = FALLBACK_OPENAI_MODELS.map((model) => `openai/${model}`);
  const data = {
    source: "bundled-catalog",
    models: refs,
  };
  print(parsed, "butler model list", data, data.models.join("\n"));
}

function modelSet(parsed: ParsedCommonOptions, args: string[]): void {
  const ref = args[1];
  if (!ref) fail(parsed, "invalid_arguments", "model set requires <provider/model>");
  const parsedRef = parseModelRef(ref);
  if (parsedRef.source !== "namespaced") fail(parsed, "invalid_arguments", "model set requires canonical provider/model ref");
  const config = readConfig(parsed.options.data);
  const previous = config.system?.defaultModel ?? null;
  config.system = { ...(config.system ?? {}), defaultModel: parsedRef.canonicalRef };
  if (parsedRef.providerId === "openai") config.system.openaiModel = parsedRef.modelId;
  atomicWriteJson(configPath(parsed.options.data), config);
  const data = {
    oldModel: previous,
    newModel: parsedRef.canonicalRef,
    provider: parsedRef.providerId,
    model: parsedRef.modelId,
    restartRecommended: true,
  };
  print(parsed, "butler model set", data, `Model set to ${parsedRef.canonicalRef}. Restart recommended.`);
}

async function transportStatus(parsed: ParsedCommonOptions): Promise<void> {
  const telegram = buildTelegramCliStatus(parsed.options.data);
  const mock = new MockTransportAdapter({ id: "mock" });
  const data = {
    transports: [
      {
        id: "telegram",
        configured: telegram.tokenConfigured,
        paired: telegram.chatPaired,
        capabilities: ["send", "poll", "markdownv2"],
      },
      {
        id: mock.id,
        configured: true,
        paired: true,
        capabilities: Object.entries(mock.capabilities)
          .filter(([, enabled]) => enabled)
          .map(([name]) => name),
      },
    ],
  };
  print(parsed, "butler transport status", data, data.transports.map((item) =>
    `${item.id}: configured=${item.configured} paired=${item.paired}`,
  ).join("\n"));
}

async function transportTest(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const transport = optionValue(args, "--transport") || "mock";
  if (transport === "mock") {
    const mock = new MockTransportAdapter({ id: "mock" });
    const result = await mock.send({
      actionId: `cli-transport-test-${Date.now()}`,
      transport: "mock",
      accountId: "local",
      peer: { kind: "dm", id: "operator" },
      message: { text: "Butler transport test." },
    });
    const data = { transport, ok: result.ok, sentActions: mock.sentActions.length, transportMessageId: result.transportMessageId ?? null };
    print(parsed, "butler transport test", data, `Mock transport test: ${result.ok ? "passed" : "failed"}.`);
    return;
  }
  if (transport === "telegram") {
    const status = buildTelegramCliStatus(parsed.options.data);
    const data = { transport, configured: status.tokenConfigured, paired: status.chatPaired, sendTestCommand: "butler telegram send-test" };
    print(parsed, "butler transport test", data, `Telegram configured=${status.tokenConfigured} paired=${status.chatPaired}.`);
    return;
  }
  fail(parsed, "invalid_arguments", `unsupported transport: ${transport}`);
}

function gatewayIdOrFail(parsed: ParsedCommonOptions, value: string | undefined) {
  try {
    return assertGatewayId(value);
  } catch (error) {
    fail(parsed, "invalid_arguments", error instanceof Error ? error.message : String(error));
  }
}

function renderGatewayStatus(view: Awaited<ReturnType<typeof buildGatewayStatusView>>): string {
  return [
    `${view.id}: ${view.status}`,
    `enabled: ${view.enabled}`,
    `configured: ${view.configured}`,
    typeof view.config.serverUrl === "string" ? `url: ${view.config.serverUrl}` : "",
    `lifecycle: ${view.lifecycle}`,
    `running: ${view.running}`,
    `restart required: ${view.restartRequired}`,
    view.nextActions.length ? `next: ${view.nextActions.join(" | ")}` : "",
  ].filter(Boolean).join("\n");
}

async function gatewayList(parsed: ParsedCommonOptions): Promise<void> {
  const gateways = await Promise.all(
    GATEWAY_DEFINITIONS.map((definition) => buildGatewayStatusView(parsed.options.data, definition.id)),
  );
  print(parsed, "butler gateway list", { gateways }, gateways.map((gateway) =>
    `${gateway.id}: ${gateway.status} enabled=${gateway.enabled} configured=${gateway.configured}`,
  ).join("\n"));
}

async function gatewayStatus(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const id = args[1];
  if (!id) {
    const gateways = await Promise.all(
      GATEWAY_DEFINITIONS.map((definition) => buildGatewayStatusView(parsed.options.data, definition.id)),
    );
    print(parsed, "butler gateway status", { gateways }, gateways.map(renderGatewayStatus).join("\n\n"));
    return;
  }
  const gatewayId = gatewayIdOrFail(parsed, id);
  const view = await buildGatewayStatusView(parsed.options.data, gatewayId);
  print(parsed, `butler gateway status ${gatewayId}`, view, renderGatewayStatus(view));
}

async function gatewayInspect(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const gatewayId = gatewayIdOrFail(parsed, args[1]);
  const settings = readGatewaySettings(parsed.options.data, gatewayId);
  const view = await buildGatewayStatusView(parsed.options.data, gatewayId);
  const data = {
    ...view,
    settingsStored: Boolean(settings.updatedAt),
    settingsPath: `gateways/${gatewayId}.json`,
  };
  print(parsed, `butler gateway inspect ${gatewayId}`, data, [
    renderGatewayStatus(view),
    `settings: ${data.settingsPath}`,
    `stored: ${data.settingsStored}`,
    "secrets: redacted",
  ].join("\n"));
}

async function gatewaySetEnabled(
  parsed: ParsedCommonOptions,
  args: string[],
  enabled: boolean,
): Promise<void> {
  const gatewayId = gatewayIdOrFail(parsed, args[1]);
  patchGatewaySettings(parsed.options.data, gatewayId, { enabled });
  const view = await buildGatewayStatusView(parsed.options.data, gatewayId);
  const data = {
    ...view,
    restartRecommended: gatewayId === "telegram" && enabled,
  };
  print(parsed, `butler gateway ${enabled ? "enable" : "disable"} ${gatewayId}`, data, [
    `${gatewayId} gateway ${enabled ? "enabled" : "disabled"}.`,
    gatewayId === "telegram" && enabled ? "Restart Butler Agent to start embedded Telegram polling." : "",
    gatewayId === "telegram" && !enabled ? "Embedded Telegram polling will stop shortly if Butler is running." : "",
  ].filter(Boolean).join("\n"));
}

function parseGatewayPort(parsed: ParsedCommonOptions, args: string[]): number | undefined {
  const raw = optionValue(args, "--port");
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isFinite(port) || port < 1 || port > 65_535) {
    fail(parsed, "invalid_arguments", "--port must be a number between 1 and 65535");
  }
  return Math.trunc(port);
}

async function gatewayConfigureApp(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const host = optionValue(args, "--host");
  const port = parseGatewayPort(parsed, args);
  const dbPath = optionValue(args, "--db");
  if (!host && port === undefined && !dbPath) {
    fail(parsed, "invalid_arguments", "gateway configure app requires --host, --port, or --db");
  }
  const config: Record<string, unknown> = {};
  if (host) config.host = host;
  if (port !== undefined) config.port = port;
  if (dbPath) config.dbPath = dbPath;
  patchGatewaySettings(parsed.options.data, "app", { enabled: true, config });
  const view = await buildGatewayStatusView(parsed.options.data, "app");
  print(parsed, "butler gateway configure app", view, [
    "App gateway configured.",
    `url: ${(view.config.serverUrl as string | undefined) ?? "unknown"}`,
    `db configured: ${Boolean(view.config.dbConfigured)}`,
  ].join("\n"));
}

async function gatewayConfigureTelegram(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const chatId = optionValue(args, "--chat-id");
  const format = optionValue(args, "--format");
  if (!chatId && !format) {
    fail(parsed, "invalid_arguments", "gateway configure telegram requires --chat-id or --format");
  }
  if (format && format !== "markdownv2" && format !== "plain") {
    fail(parsed, "invalid_arguments", "--format must be markdownv2 or plain");
  }
  const config: Record<string, unknown> = {};
  if (chatId) {
    config.chatId = chatId;
    upsertPrivateEnvValue(parsed.options.data, "TELEGRAM_CHAT_ID", chatId);
  }
  if (format) config.defaultFormat = format;
  patchGatewaySettings(parsed.options.data, "telegram", { enabled: true, config });
  updateTelegramCompatibilityConfig(parsed.options.data, {
    ...(chatId ? { chatId } : {}),
    ...(format ? { defaultFormat: format as "markdownv2" | "plain" } : {}),
  });
  const view = await buildGatewayStatusView(parsed.options.data, "telegram");
  print(parsed, "butler gateway configure telegram", view, [
    "Telegram gateway configured.",
    `chat paired: ${Boolean(view.config.chatPaired)}`,
    `format: ${String(view.config.defaultFormat ?? "markdownv2")}`,
    "Restart Butler Agent to apply embedded gateway changes.",
  ].join("\n"));
}

async function gatewayConfigure(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const gatewayId = gatewayIdOrFail(parsed, args[1]);
  if (gatewayId === "app") return await gatewayConfigureApp(parsed, args);
  return await gatewayConfigureTelegram(parsed, args);
}

async function gatewayCredential(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const action = args[1];
  const gatewayId = gatewayIdOrFail(parsed, args[2]);
  if (action !== "set" || gatewayId !== "telegram") {
    fail(parsed, "invalid_arguments", "supported credential command: gateway credential set telegram --token-stdin");
  }
  if (!hasFlag(args, "--token-stdin")) {
    fail(parsed, "invalid_arguments", "telegram credentials must be provided with --token-stdin");
  }
  const token = (await Bun.stdin.text()).trim();
  if (!token) fail(parsed, "invalid_arguments", "telegram token is required on stdin");
  upsertPrivateEnvValue(parsed.options.data, "TELEGRAM_BOT_TOKEN", token);
  patchGatewaySettings(parsed.options.data, "telegram", { enabled: true });
  const view = await buildGatewayStatusView(parsed.options.data, "telegram");
  print(parsed, "butler gateway credential set telegram", {
    gateway: view.id,
    credentials: view.credentials,
    tokenStored: true,
    tokenValueIncluded: false,
    envPath: ".env",
  }, [
    "Telegram token stored.",
    "token: [redacted]",
  ].join("\n"));
}

async function gatewayPair(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const gatewayId = gatewayIdOrFail(parsed, args[1]);
  if (gatewayId !== "telegram") fail(parsed, "invalid_arguments", "only telegram pairing is currently supported");
  const env = readPrivateEnv(parsed.options.data);
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
  if (!token) fail(parsed, "invalid_arguments", "telegram token is not configured; run gateway credential set telegram --token-stdin");
  try {
    const result = await pairTelegramChat({
      butlerData: parsed.options.data,
      token,
      timeoutMs: numericOption(args, "--timeout-ms", 0, Number.MAX_SAFE_INTEGER),
      apiBase: process.env.BUTLER_TELEGRAM_API_BASE,
    });
    const chatId = result.chatId ?? "";
    patchGatewaySettings(parsed.options.data, "telegram", {
      enabled: true,
      config: { chatId },
    });
    updateTelegramCompatibilityConfig(parsed.options.data, { chatId });
    const view = await buildGatewayStatusView(parsed.options.data, "telegram");
    print(parsed, "butler gateway pair telegram", {
      gateway: view.id,
      chatPaired: true,
      tokenValueIncluded: false,
      pairedAt: result.pairedAt,
    }, [
      "Telegram paired.",
      "chat id: [configured]",
      "Restart Butler Agent to apply embedded gateway changes.",
    ].join("\n"));
  } catch (error) {
    fail(
      parsed,
      "external_unavailable",
      redactTelegramToken(error instanceof Error ? error.message : String(error), token),
      5,
    );
  }
}

async function gatewayUnpair(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const gatewayId = gatewayIdOrFail(parsed, args[1]);
  if (gatewayId !== "telegram") fail(parsed, "invalid_arguments", "only telegram unpair is currently supported");
  requireYes(parsed, "gateway unpair telegram");
  const result = unpairTelegramChat(parsed.options.data);
  removeGatewayConfigKeys(parsed.options.data, "telegram", ["chatId"]);
  updateTelegramCompatibilityConfig(parsed.options.data, { chatId: "" });
  const view = await buildGatewayStatusView(parsed.options.data, "telegram");
  print(parsed, "butler gateway unpair telegram", {
    gateway: view.id,
    removed: result.removed,
    chatPaired: false,
    tokenConfigured: view.credentials.botToken,
  }, [
    "Telegram unpaired.",
    "token retained: yes",
    "Restart Butler Agent to apply embedded gateway changes.",
  ].join("\n"));
}

async function gatewayTest(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const gatewayId = gatewayIdOrFail(parsed, args[1]);
  const view = await buildGatewayStatusView(parsed.options.data, gatewayId);
  if (gatewayId === "app") {
    const data = {
      gateway: gatewayId,
      ok: view.enabled && view.running,
      status: view.status,
      serverUrl: view.config.serverUrl,
    };
    print(parsed, "butler gateway test app", data, `App gateway test: ${data.ok ? "passed" : "not running"}.`);
    return;
  }
  const telegram = resolveTelegramGatewayRuntimeConfig({ butlerData: parsed.options.data });
  const data = {
    gateway: gatewayId,
    ok: telegram.enabled && telegram.tokenConfigured && telegram.chatPaired,
    enabled: telegram.enabled,
    tokenConfigured: telegram.tokenConfigured,
    chatPaired: telegram.chatPaired,
    deliveryAttempted: false,
  };
  print(parsed, "butler gateway test telegram", data, [
    `Telegram gateway readiness: ${data.ok ? "ready" : "not ready"}.`,
    "Delivery test: skipped; use `butler telegram send-test` for a live send.",
  ].join("\n"));
}

function ensureAppGateway(parsed: ParsedCommonOptions, gatewayId: ReturnType<typeof gatewayIdOrFail>): void {
  if (gatewayId !== "app") {
    fail(parsed, "unsupported_operation", `${gatewayId} is embedded in butler-main; restart Butler Agent to apply lifecycle changes`);
  }
}

function appGatewayCommand(parsed: ParsedCommonOptions): string[] {
  const app = resolveAppGatewayRuntimeConfig({ butlerData: parsed.options.data });
  return [
    process.execPath,
    "run",
    join(parsed.options.home, "packages", "butler-agent", "src", "gateways", "app", "interface", "cli", "app-gateway-cli.ts"),
    `--port=${app.port}`,
  ];
}

function gatewayRun(parsed: ParsedCommonOptions, args: string[]): never {
  const gatewayId = gatewayIdOrFail(parsed, args[1]);
  ensureAppGateway(parsed, gatewayId);
  const [_program, ...commandArgs] = appGatewayCommand(parsed);
  runShell(process.execPath, commandArgs, parsed);
}

async function gatewayStart(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const gatewayId = gatewayIdOrFail(parsed, args[1]);
  ensureAppGateway(parsed, gatewayId);
  const current = await buildGatewayStatusView(parsed.options.data, "app");
  if (!current.enabled) {
    print(parsed, "butler gateway start app", { ...current, started: false }, "App gateway is disabled. Run `butler gateway enable app` first.");
    return;
  }
  const started = await startAppGatewayProcess(parsed);
  const view = await buildGatewayStatusView(parsed.options.data, "app");
  print(parsed, "butler gateway start app", {
    ...view,
    alreadyRunning: started.alreadyRunning,
    pid: started.pid,
  }, started.alreadyRunning ? "App gateway already running." : `App gateway started pid=${started.pid ?? "unknown"}.`);
}

async function startAppGatewayProcess(parsed: ParsedCommonOptions): Promise<{ pid: number | null; alreadyRunning: boolean }> {
  const currentPid = readAppGatewayPid(parsed.options.data);
  if (isProcessAlive(currentPid)) return { pid: currentPid, alreadyRunning: true };
  const logs = appGatewayLogPaths(parsed.options.data);
  mkdirSync(dirname(logs.stdout), { recursive: true, mode: 0o700 });
  const stdoutFd = openSync(logs.stdout, "a", 0o600);
  const stderrFd = openSync(logs.stderr, "a", 0o600);
  const [_program, ...commandArgs] = appGatewayCommand(parsed);
  const child = spawn(process.execPath, commandArgs, {
    cwd: parsed.options.home,
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    env: {
      ...process.env,
      BUTLER_HOME: parsed.options.home,
      BUTLER_DATA: parsed.options.data,
    },
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  child.unref();
  if (child.pid) writeAppGatewayPid(parsed.options.data, child.pid);
  return { pid: child.pid ?? null, alreadyRunning: false };
}

async function gatewayStop(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const gatewayId = gatewayIdOrFail(parsed, args[1]);
  ensureAppGateway(parsed, gatewayId);
  const pid = readAppGatewayPid(parsed.options.data);
  const running = isProcessAlive(pid);
  if (running && pid) process.kill(pid, "SIGTERM");
  clearAppGatewayPid(parsed.options.data);
  const view = await buildGatewayStatusView(parsed.options.data, "app");
  print(parsed, "butler gateway stop app", { ...view, stoppedPid: running ? pid : null }, running ? `App gateway stopped pid=${pid}.` : "App gateway was not running.");
}

async function gatewayRestart(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const gatewayId = gatewayIdOrFail(parsed, args[1]);
  if (gatewayId !== "app") {
    requireYes(parsed, `gateway restart ${gatewayId}`);
    print(parsed, `butler gateway restart ${gatewayId}`, {
      gateway: gatewayId,
      lifecycle: "embedded",
      restarted: false,
      restartRequired: true,
      serviceCommand: "butler restart",
    }, `${gatewayId} is embedded in butler-main. Run \`butler restart\` to apply changes.`);
    return;
  }
  const current = await buildGatewayStatusView(parsed.options.data, "app");
  if (!current.enabled) {
    print(parsed, "butler gateway restart app", { ...current, restarted: false }, "App gateway is disabled. Run `butler gateway enable app` first.");
    return;
  }
  const pid = readAppGatewayPid(parsed.options.data);
  const wasRunning = isProcessAlive(pid);
  if (wasRunning && pid) process.kill(pid, "SIGTERM");
  clearAppGatewayPid(parsed.options.data);
  const started = await startAppGatewayProcess(parsed);
  const view = await buildGatewayStatusView(parsed.options.data, "app");
  print(parsed, "butler gateway restart app", {
    ...view,
    stoppedPid: wasRunning ? pid : null,
    pid: started.pid,
  }, `App gateway restarted pid=${started.pid ?? "unknown"}.`);
}

function gatewayLogs(parsed: ParsedCommonOptions, args: string[]): void {
  const gatewayId = gatewayIdOrFail(parsed, args[1]);
  if (gatewayId !== "app") {
    print(parsed, `butler gateway logs ${gatewayId}`, {
      gateway: gatewayId,
      lifecycle: "embedded",
      supported: false,
      serviceLogCommand: "butler logs --service butler-main",
    }, `${gatewayId} is embedded in butler-main. Use \`butler logs --service butler-main\`.`);
    return;
  }
  const lines = numericOption(args, "--lines", 80, 1_000);
  const logs = appGatewayLogPaths(parsed.options.data);
  const entries = [logs.stdout, logs.stderr].filter(existsSync);
  const data = {
    gateway: gatewayId,
    files: entries.map((file) => basename(file)),
    lines: tailLogEntries(entries, lines),
    follow: hasFlag(args, "--follow"),
  };
  print(parsed, "butler gateway logs app", data, data.lines.map((line) => `[${line.file}] ${line.text}`).join("\n") || "No app gateway log lines found.");
  maybeFollowLogs(parsed, args, entries);
}

function mcpTransportOption(parsed: ParsedCommonOptions, args: string[]): McpTransportKind {
  const value = optionValue(args, "--transport") ?? "stdio";
  if (value === "stdio" || value === "http" || value === "sse") return value;
  fail(parsed, "invalid_arguments", "--transport must be stdio, http, or sse");
}

function mcpSecretOptions(
  args: string[],
  literalFlag: string,
  envFlag: string,
  fileFlag: string,
): McpKeyValueSecret[] {
  return [
    ...optionValues(args, literalFlag).map((value) => mcpSecretOption(value, "literal")),
    ...optionValues(args, envFlag).map((value) => mcpSecretOption(value, "env")),
    ...optionValues(args, fileFlag).map((value) => mcpSecretOption(value, "file")),
  ];
}

function mcpSecretOption(value: string, source: McpKeyValueSecret["source"]): McpKeyValueSecret {
  const index = value.indexOf("=");
  if (index <= 0) {
    throw new Error("MCP secret options must use KEY=VALUE form.");
  }
  return {
    key: value.slice(0, index).trim(),
    source,
    value: value.slice(index + 1).trim(),
  };
}

function mcpTarget(server: { transport: string; command?: string; args?: string[]; url?: string }): string {
  if (server.transport === "stdio") {
    return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
  }
  return server.url ?? "";
}

function mcpList(parsed: ParsedCommonOptions): void {
  const data = listMcpServers(parsed.options.data);
  print(parsed, "butler mcp list", data, data.servers.length
    ? data.servers.map((server) =>
      `${server.id}: ${server.enabled ? "enabled" : "disabled"} ${server.transport} ${mcpTarget(server)}`,
    ).join("\n")
    : "No MCP servers configured.");
}

function mcpUpsert(parsed: ParsedCommonOptions, args: string[]): void {
  const id = optionValue(args, "--id") ?? args[1];
  if (!id) fail(parsed, "invalid_arguments", "mcp add requires --id <id>");
  try {
    const input: McpServerUpsertInput = {
      id,
      display_name: optionValue(args, "--name") ?? optionValue(args, "--display-name") ?? undefined,
      enabled: !hasFlag(args, "--disabled"),
      transport: mcpTransportOption(parsed, args),
      command: optionValue(args, "--command") ?? undefined,
      args: optionValues(args, "--arg"),
      cwd: optionValue(args, "--cwd") ?? undefined,
      url: optionValue(args, "--url") ?? undefined,
      env: mcpSecretOptions(args, "--env", "--env-ref", "--env-file"),
      headers: mcpSecretOptions(args, "--header", "--header-env", "--header-file"),
    };
    const server = upsertMcpServer(parsed.options.data, input);
    print(
      parsed,
      "butler mcp add",
      { server, redacted: true },
      `MCP server saved: ${server.id} (${server.transport}).`,
    );
  } catch (error) {
    fail(parsed, "invalid_arguments", error instanceof Error ? error.message : String(error));
  }
}

function mcpSetEnabled(parsed: ParsedCommonOptions, args: string[], enabled: boolean): void {
  const id = args[1];
  if (!id) fail(parsed, "invalid_arguments", `mcp ${enabled ? "enable" : "disable"} requires <id>`);
  try {
    const server = updateMcpServer(parsed.options.data, id, { enabled });
    print(
      parsed,
      `butler mcp ${enabled ? "enable" : "disable"}`,
      { server },
      `MCP server ${enabled ? "enabled" : "disabled"}: ${server.id}.`,
    );
  } catch (error) {
    fail(parsed, "not_found", error instanceof Error ? error.message : String(error), 1);
  }
}

function mcpDelete(parsed: ParsedCommonOptions, args: string[]): void {
  requireYes(parsed, "mcp delete");
  const id = args[1];
  if (!id) fail(parsed, "invalid_arguments", "mcp delete requires <id>");
  const result = deleteMcpServer(parsed.options.data, id);
  print(
    parsed,
    "butler mcp delete",
    result,
    result.removed ? `MCP server deleted: ${result.id}.` : `MCP server not found: ${result.id}.`,
  );
}

async function mcpTest(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const id = args[1];
  if (!id) fail(parsed, "invalid_arguments", "mcp test requires <id>");
  const result = await probeMcpServer({
    butlerData: parsed.options.data,
    serverId: id,
  });
  const data = { server: result };
  if (!result.ok) {
    if (parsed.options.json) {
      process.stdout.write(renderJsonEnvelope({
        ok: false,
        command: "butler mcp test",
        data,
        error: { code: "external_unavailable", message: result.error ?? "MCP server probe failed." },
      }));
    } else {
      console.error(`MCP server probe failed: ${result.error ?? result.id}`);
    }
    process.exit(5);
  }
  print(parsed, "butler mcp test", data, [
    `MCP server reachable: ${result.id}`,
    `tools=${result.tools.length} resources=${result.resources.length} templates=${result.resource_templates.length}`,
  ].join("\n"));
}

async function mcp(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const subcommand = args[0] ?? "list";
  if (subcommand === "list") return mcpList(parsed);
  if (subcommand === "add" || subcommand === "set") return mcpUpsert(parsed, args);
  if (subcommand === "enable") return mcpSetEnabled(parsed, args, true);
  if (subcommand === "disable") return mcpSetEnabled(parsed, args, false);
  if (subcommand === "delete" || subcommand === "remove") return mcpDelete(parsed, args);
  if (subcommand === "test" || subcommand === "probe") return await mcpTest(parsed, args);
  fail(parsed, "unknown_command", `unknown mcp command: ${subcommand}`);
}

function skillProjectRefs(parsed: ParsedCommonOptions, args: string[]): Array<{ id: string; display_name: string }> {
  const explicitProjects = optionValues(args, "--project");
  if (explicitProjects.length > 0) {
    return explicitProjects.map((id) => ({ id, display_name: id }));
  }
  return listSkillProjectsInDataHome(parsed.options.data).map((project) => ({
    id: project.id,
    display_name: project.display_name,
  }));
}

function flattenSkillView(input: ReturnType<typeof skillSettingsView>): SkillSummaryView[] {
  return [
    ...input.core,
    ...input.user,
    ...input.projects.flatMap((project) => project.skills),
  ];
}

function skillsList(parsed: ParsedCommonOptions, args: string[]): void {
  const data = skillSettingsView({
    butlerHome: parsed.options.home,
    butlerData: parsed.options.data,
    projects: skillProjectRefs(parsed, args),
  });
  const human = [
    data.core.length ? `Core: ${data.core.map((skill) => skill.name).join(", ")}` : "Core: none",
    data.user.length ? `User: ${data.user.map((skill) => skill.name).join(", ")}` : "User: none",
    ...data.projects.map((project) =>
      project.skills.length
        ? `Project ${project.id}: ${project.skills.map((skill) => skill.name).join(", ")}`
        : `Project ${project.id}: none`,
    ),
  ].join("\n");
  print(parsed, "butler skills list", data, human);
}

function skillsInspect(parsed: ParsedCommonOptions, args: string[]): void {
  const name = args[1] ?? optionValue(args, "--name");
  if (!name) fail(parsed, "invalid_arguments", "skills inspect requires <name>");
  const view = skillSettingsView({
    butlerHome: parsed.options.home,
    butlerData: parsed.options.data,
    projects: skillProjectRefs(parsed, args),
  });
  const matches = flattenSkillView(view).filter((skill) => skill.name === name);
  if (matches.length === 0) fail(parsed, "not_found", `skill not found: ${name}`, 1);
  print(parsed, "butler skills inspect", { skills: matches }, matches.map((skill) =>
    `${skill.name} (${skill.source}${skill.project_id ? `:${skill.project_id}` : ""})\n${skill.description}\n${skill.file_path}`,
  ).join("\n\n"));
}

function skillsImport(parsed: ParsedCommonOptions, args: string[]): void {
  const zipPath = args[1] ?? optionValue(args, "--zip") ?? optionValue(args, "--file");
  if (!zipPath) fail(parsed, "invalid_arguments", "skills import requires <zip-path>");
  if (!existsSync(zipPath)) fail(parsed, "not_found", `zip file not found: ${zipPath}`, 1);
  const bytes = readFileSync(zipPath);
  const result = importSkillZip({
    butlerData: parsed.options.data,
    zipName: basename(zipPath),
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    projectId: optionValue(args, "--project") ?? undefined,
  });
  print(parsed, "butler skills import", result, result.imported.length
    ? `Imported skills: ${result.imported.map((skill) => skill.name).join(", ")}`
    : "No skills imported.");
}

function skillsValidate(parsed: ParsedCommonOptions, args: string[]): void {
  const projectIds = optionValues(args, "--project");
  const data = validateSkillSettings({
    butlerHome: parsed.options.home,
    butlerData: parsed.options.data,
    projectIds: projectIds.length > 0 ? projectIds : undefined,
  });
  if (!data.ok) {
    if (parsed.options.json) {
      process.stdout.write(renderJsonEnvelope({
        ok: false,
        command: "butler skills validate",
        data,
        error: { code: "health_failed", message: `${data.issues.length} skill validation issue(s).` },
      }));
    } else {
      console.error(data.issues.map((issue) =>
        `${issue.source}${issue.project_id ? `:${issue.project_id}` : ""} ${issue.filePath}: ${issue.message}`,
      ).join("\n"));
    }
    process.exit(3);
  }
  print(parsed, "butler skills validate", data, [
    "Skill validation passed.",
    `core=${data.counts.core} user=${data.counts.user} project=${data.counts.project}`,
  ].join("\n"));
}

function skills(parsed: ParsedCommonOptions, args: string[]): void {
  const subcommand = args[0] ?? "list";
  if (subcommand === "list") return skillsList(parsed, args);
  if (subcommand === "inspect" || subcommand === "show") return skillsInspect(parsed, args);
  if (subcommand === "import") return skillsImport(parsed, args);
  if (subcommand === "validate") return skillsValidate(parsed, args);
  fail(parsed, "unknown_command", `unknown skills command: ${subcommand}`);
}

async function telegramSendTest(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  try {
    const data = await sendTelegramTestMessage({
      butlerData: parsed.options.data,
      message: optionValue(args, "--message") ?? undefined,
      apiBase: process.env.BUTLER_TELEGRAM_API_BASE,
    });
    print(parsed, "butler telegram send-test", data, `Telegram test delivered to chat ${data.chatId}.`);
  } catch (error) {
    const token = readPrivateEnv(parsed.options.data).TELEGRAM_BOT_TOKEN ?? "";
    fail(parsed, "external_unavailable", redactTelegramToken(error instanceof Error ? error.message : String(error), token), 5);
  }
}

function telegramUnpair(parsed: ParsedCommonOptions): void {
  requireYes(parsed, "telegram unpair");
  const data = unpairTelegramChat(parsed.options.data);
  print(parsed, "butler telegram unpair", data, data.removed ? "Telegram chat pairing removed." : "No Telegram chat pairing was present.");
}

function compactTaskSummary(summary: ReturnType<TaskStore["summaries"]>[number]) {
  return {
    task_id: summary.task_id,
    task_type: summary.task_type,
    status: summary.status,
    planned_status: summary.planned_status,
    work_mode: summary.work_mode,
    safe_to_report: summary.safe_to_report,
    completion_claim_allowed: summary.completion_claim_allowed,
    can_resume: summary.can_resume,
    user_summary: supportSafeTaskSummary(summary),
    next_step: summary.next_step,
    guard_reason: summary.guard_reason,
    has_result: summary.has_result,
    has_log: summary.has_log,
  };
}

function supportSafeTaskSummary(summary: ReturnType<TaskStore["summaries"]>[number]): string {
  const status = summary.planned_status ?? summary.status;
  if (summary.work_mode === "executing") return `${summary.task_type} work is still running (${status}).`;
  if (summary.work_mode === "repairing") return `${summary.task_type} work is recoverable (${status}).`;
  if (summary.work_mode === "complete") return `${summary.task_type} work has completed (${status}).`;
  if (summary.work_mode === "failed") return `${summary.task_type} work needs failure review (${status}).`;
  return `${summary.task_type} work state is ${status}.`;
}

function sanitizeDashboardForCli(dashboard: WorkDashboard): WorkDashboard {
  const sanitizeItem = (item: WorkDashboard["active"][number]) => ({
    ...item,
    summary: `${item.task_type} work state is ${item.status}.`,
  });
  return {
    ...dashboard,
    active: dashboard.active.map(sanitizeItem),
    recoverable: dashboard.recoverable.map(sanitizeItem),
    failed: dashboard.failed.map(sanitizeItem),
    reportReady: dashboard.reportReady.map(sanitizeItem),
    delivery: dashboard.delivery.map((item) => ({
      ...item,
      summary: `Delivery notification is ${item.status}.`,
    })),
  };
}

function work(parsed: ParsedCommonOptions, args: string[]): void {
  const subcommand = args[0] || "dashboard";
  const store = new TaskStore(parsed.options.data);
  if (subcommand === "dashboard") {
    const data = sanitizeDashboardForCli(createWorkDashboard({
      butlerData: parsed.options.data,
      debug: hasFlag(args, "--debug"),
    }));
    print(parsed, "butler work dashboard", data, renderWorkDashboard(data));
    return;
  }
  if (subcommand === "list") {
    const status = optionValue(args, "--status");
    const items = store.summaries(25)
      .filter((item) => !status || item.status.toLowerCase() === status.toLowerCase() || item.work_mode === status)
      .map(compactTaskSummary);
    print(parsed, "butler work list", { items, status: status ?? null }, items.length
      ? items.map((item) => `${item.task_id}: ${item.status} ${item.user_summary}`).join("\n")
      : "No work items found.");
    return;
  }
  if (subcommand === "show") {
    const id = args[1];
    if (!id) fail(parsed, "invalid_arguments", "work show requires <id>");
    const summary = store.summaries(25).find((item) => item.task_id === id);
    if (!summary) fail(parsed, "not_found", `work item not found: ${id}`, 1);
    print(parsed, "butler work show", compactTaskSummary(summary), `${summary.task_id}: ${summary.user_summary}\nnext: ${summary.next_step}`);
    return;
  }
  if (subcommand === "resume") {
    const idArg = args[1];
    if (!idArg) fail(parsed, "invalid_arguments", "work resume requires <id|latest>");
    const taskId = idArg === "latest" ? store.latestRecoverableTask()?.taskId : idArg;
    if (!taskId) fail(parsed, "not_found", "no recoverable work item found", 1);
    const result = performWorkControl({ butlerData: parsed.options.data, action: "resume", taskId });
    if (!result.ok) fail(parsed, "invalid_state", result.message, 1);
    print(parsed, "butler work resume", result, `${result.message}: ${taskId}`);
    return;
  }
  if (subcommand === "cancel") {
    requireYes(parsed, "work cancel");
    const taskId = args[1];
    if (!taskId) fail(parsed, "invalid_arguments", "work cancel requires <id>");
    const result = performWorkControl({ butlerData: parsed.options.data, action: "cancel", taskId });
    if (!result.ok) fail(parsed, "invalid_state", result.message, 1);
    const task = store.read(taskId);
    if (task) {
      const pidText = existsSync(join(task.taskDir, "pid")) ? readFileSync(join(task.taskDir, "pid"), "utf8").trim() : "";
      const pid = Number.parseInt(pidText, 10);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Idempotent cancellation: missing process is still cancelled in durable state.
        }
      }
      writeFileSync(join(task.taskDir, "status"), "KILLED\n", "utf8");
    }
    print(parsed, "butler work cancel", { ...result, status: "KILLED" }, `Work cancelled: ${taskId}`);
    return;
  }
  if (subcommand === "retry") {
    const id = args[1];
    if (!id) fail(parsed, "invalid_arguments", "work retry requires <id>");
    const delivery = performWorkControl({ butlerData: parsed.options.data, action: "retry_delivery", notificationId: id });
    if (delivery.ok) {
      print(parsed, "butler work retry", delivery, delivery.message);
      return;
    }
    const task = store.read(id);
    if (task?.status === "RECOVERABLE") {
      const result = performWorkControl({ butlerData: parsed.options.data, action: "resume", taskId: id });
      print(parsed, "butler work retry", result, result.message);
      return;
    }
    fail(parsed, "invalid_state", delivery.message, 1);
  }
  fail(parsed, "unknown_command", `unknown work command: ${subcommand}`);
}

function memory(parsed: ParsedCommonOptions, args: string[], commandBase: string): void {
  const subcommand = args[0] || "status";
  if (subcommand === "status") {
    const data = readMemoryHealth({ butlerData: parsed.options.data });
    print(parsed, `${commandBase} status`, data, [
      `hotCacheFiles=${data.hotCacheFiles} transcriptFiles=${data.transcriptFiles}`,
      `projectCapsules=${data.projectCapsules} missing=${data.missingProjectCapsules} refreshFailures=${data.projectRefreshFailureCount}`,
      `memoryChunks=${data.memoryChunkCount} vectorRows=${data.vectorRowCount ?? "unknown"} graphEntities=${data.graphEntityCount} graphEdges=${data.graphEdgeCount}`,
      `maintenance=${data.maintenanceStatus}`,
    ].join("\n"));
    return;
  }
  if (subcommand === "recall") {
    const cue = args.slice(1).filter((arg) => !arg.startsWith("--")).join(" ").trim();
    if (!cue) fail(parsed, "invalid_arguments", "memory recall requires <cue>");
    const recall = recallMemory({ butlerData: parsed.options.data, cue, limit: 5 });
    const data = {
      cue,
      seeds: recall.seeds,
      abstained: recall.abstained,
      diagnostics: recall.diagnostics,
      results: recall.items.map((item) => ({
        summary: item.summary,
        confidence: item.confidence,
        source: item.source,
        provenance: item.provenance.map((value) => value.startsWith(parsed.options.data) ? basename(value) : value),
      })),
    };
    print(parsed, `${commandBase} recall`, data, data.results.length
      ? data.results.map((item) => `${item.source} ${(item.confidence * 100).toFixed(1)}%: ${item.summary}`).join("\n")
      : "No high-confidence memory recall results.");
    return;
  }
  if (subcommand === "project" && args[1] === "inspect") {
    const projectId = args[2];
    if (!projectId) fail(parsed, "invalid_arguments", "memory project inspect requires <project-id>");
    const data = inspectProjectCapsule({
      butlerData: parsed.options.data,
      projectId,
    });
    print(parsed, `${commandBase} project inspect`, data, [
      `project=${data.projectId} exists=${data.exists} bytes=${data.bytes}`,
      `updated=${data.updatedAt ?? "missing"}`,
      `sections=${data.sectionHeadings.join(", ") || "none"}`,
      `refreshFailures=${data.refreshFailures.count}`,
      data.diagnostics.length ? `diagnostics=${data.diagnostics.join("; ")}` : "",
    ].filter(Boolean).join("\n"));
    return;
  }
  if (subcommand === "metadata" && args[1] === "inspect") {
    const memoryChunkId = args[2];
    if (!memoryChunkId) fail(parsed, "invalid_arguments", "memory metadata inspect requires <memory_chunk_id>");
    const chunk = readMemoryChunkWithRefs(parsed.options.data, memoryChunkId);
    if (!chunk) fail(parsed, "not_found", `memory chunk not found: ${memoryChunkId}`, 1);
    print(parsed, `${commandBase} metadata inspect`, { chunk }, `${chunk.memory_chunk_id}: ${chunk.status} ${chunk.summary}`);
    return;
  }
  if (subcommand === "metadata" && args[1] === "repair-links") {
    requireYes(parsed, "memory metadata repair-links");
    const report = repairMemoryMetadataIntegrity(parsed.options.data);
    print(parsed, `${commandBase} metadata repair-links`, report, `metadata links repaired: box=${report.repaired_box_refs} feedback=${report.repaired_feedback_refs}`);
    return;
  }
  if (subcommand === "metadata" && args[1] === "check") {
    const report = checkMemoryMetadataIntegrity(parsed.options.data);
    print(parsed, `${commandBase} metadata check`, report, `metadata integrity: missingBox=${report.missing_box_refs.length} missingFeedback=${report.missing_feedback_refs.length}`);
    return;
  }
  fail(parsed, "unknown_command", `unknown memory command: ${subcommand}`);
}

function removedLegacyMemory(parsed: ParsedCommonOptions): never {
  fail(parsed, "unknown_command", `unknown Butler command: ${parsed.args.join(" ")}`, 2);
}

function cognitionMigrate(parsed: ParsedCommonOptions, args: string[], commandBase: "butler cognition" | "butler cog"): void {
  const dryRun = hasFlag(args, "--dry-run");
  const status = hasFlag(args, "--status");
  const apply = hasFlag(args, "--apply");
  if (!dryRun && !status && !apply) {
    fail(parsed, "invalid_arguments", "cognition migrate requires --status, --dry-run, or --apply");
  }
  if (apply) {
    const manifest = applyCognitionNamespaceMigration(parsed.options.data);
    if (manifest.status === "conflict" || manifest.status === "failed") {
      fail(parsed, "invalid_state", `cognition migration ${manifest.status}: ${manifest.conflicts.join("; ")}`, 1);
    }
    print(parsed, `${commandBase} migrate --apply`, manifest, `Cognition migration applied: moved=${manifest.moved_paths.length}`);
    return;
  }

  const plan = buildCognitionNamespaceMigrationPlan(parsed.options.data);
  const command = status ? `${commandBase} migrate --status` : `${commandBase} migrate --dry-run`;
  print(parsed, command, { ...plan, dryRun }, [
    `status=${plan.status}`,
    `legacyFiles=${plan.legacy_file_count} legacyBytes=${plan.legacy_byte_count}`,
    `cognitionFiles=${plan.cognition_memory_file_count} cognitionBytes=${plan.cognition_memory_byte_count}`,
    plan.conflicts.length ? `conflicts=${plan.conflicts.join("; ")}` : "",
  ].filter(Boolean).join("\n"));
}

function cognitionFeedback(parsed: ParsedCommonOptions, args: string[], commandBase: string): void {
  const subcommand = args[0] ?? "list";
  if (subcommand === "list") {
    const entries = listFeedbackEntries(parsed.options.data);
    const summaries = entries.map(feedbackListSummary);
    print(parsed, `${commandBase} list`, { entries: summaries }, entries.length
      ? entries.map((entry) => `${entry.feedback_id}: ${entry.status} ${entry.target_ref}`).join("\n")
      : "No feedback entries.");
    return;
  }
  if (subcommand === "add") {
    const text = optionValue(args, "--text");
    if (!text) fail(parsed, "invalid_arguments", "feedback add requires --text");
    const entry = addFeedbackEntry(parsed.options.data, {
      text,
      targetRef: optionValue(args, "--target") ?? "unknown",
      category: optionValue(args, "--category") ?? "unrouted",
      scope: optionValue(args, "--scope") ?? "global",
      promotionTarget: optionValue(args, "--promotion-target") ?? "discard",
    });
    print(parsed, `${commandBase} add`, { entry }, `Feedback recorded: ${entry.feedback_id}`);
    return;
  }
  if (subcommand === "show") {
    const feedbackId = args[1];
    if (!feedbackId) fail(parsed, "invalid_arguments", "feedback show requires <feedback_id>");
    const entry = readFeedbackEntry(parsed.options.data, feedbackId);
    if (!entry) fail(parsed, "not_found", `feedback not found: ${feedbackId}`, 1);
    print(parsed, `${commandBase} show`, { entry }, `${entry.feedback_id}: ${entry.status} ${entry.target_ref}\n${entry.text}`);
    return;
  }
  if (subcommand === "resolve") {
    const feedbackId = args[1];
    if (!feedbackId) fail(parsed, "invalid_arguments", "feedback resolve requires <feedback_id>");
    const status = optionValue(args, "--status") ?? "applied";
    if (!isFeedbackResolveStatus(status)) {
      fail(parsed, "invalid_arguments", "feedback resolve --status must be applied, discarded, superseded, or needs_clarification");
    }
    const entry = resolveFeedbackEntry(parsed.options.data, feedbackId, status);
    print(parsed, `${commandBase} resolve`, { entry }, `Feedback ${entry.status}: ${entry.feedback_id}`);
    return;
  }
  if (subcommand === "clear" && hasFlag(args, "--applied")) {
    requireYes(parsed, "feedback clear");
    const result = clearResolvedFeedbackEntries(parsed.options.data);
    print(parsed, `${commandBase} clear --applied`, result, `Feedback cleared: removed=${result.removed} remaining=${result.remaining}`);
    return;
  }
  fail(parsed, "unknown_command", `unknown feedback command: ${subcommand}`);
}

function cognitionBox(parsed: ParsedCommonOptions, args: string[], commandBase: string): void {
  const subcommand = args[0] ?? "list";
  if (subcommand === "list") {
    const items = listIndexedBoxItems(parsed.options.data, numericOption(args, "--limit", 100));
    print(parsed, `${commandBase} list`, { items }, items.length
      ? items.map((item) => `${item.box_item_id}: ${item.status} ${item.kind} ${item.title ?? ""}`.trim()).join("\n")
      : "No Box items.");
    return;
  }
  if (subcommand === "show") {
    const boxItemId = args[1];
    if (!boxItemId) fail(parsed, "invalid_arguments", "box show requires <box_item_id>");
    const manifest = readBoxManifest(parsed.options.data, boxItemId);
    if (!manifest) fail(parsed, "not_found", `Box item not found: ${boxItemId}`, 1);
    print(parsed, `${commandBase} show`, { item: boxItemSummary(manifest), manifest }, `${manifest.box_item_id}: ${manifest.status} ${manifest.title}`);
    return;
  }
  if (subcommand === "inspect") {
    const boxItemId = args[1];
    if (!boxItemId) fail(parsed, "invalid_arguments", "box inspect requires <box_item_id>");
    const manifest = readBoxManifest(parsed.options.data, boxItemId);
    if (!manifest) fail(parsed, "not_found", `Box item not found: ${boxItemId}`, 1);
    const includeRaw = hasFlag(args, "--include-raw");
    const raw = includeRaw
      ? manifest.files
        .filter((file) => file.ownership === "box-owned" && file.box_relative_path)
        .map((file) => ({
          role: file.role,
          box_relative_path: file.box_relative_path,
          text: existsSync(join(boxItemRoot(parsed.options.data, boxItemId), file.box_relative_path!))
            ? readFileSync(join(boxItemRoot(parsed.options.data, boxItemId), file.box_relative_path!), "utf8")
            : null,
        }))
      : [];
    print(parsed, `${commandBase} inspect`, { item: boxItemSummary(manifest), manifest, raw }, `${manifest.box_item_id}: ${manifest.status} ${manifest.title}`);
    return;
  }
  if (subcommand === "forget") {
    const boxItemId = args[1];
    if (!boxItemId) fail(parsed, "invalid_arguments", "box forget requires <box_item_id>");
    requireYes(parsed, "box forget");
    const mode = optionValue(args, "--mode") ?? "hide";
    if (!["hide", "derived", "raw"].includes(mode)) fail(parsed, "invalid_arguments", "box forget --mode must be hide, derived, or raw");
    const manifest = readBoxManifest(parsed.options.data, boxItemId);
    if (!manifest) fail(parsed, "not_found", `Box item not found: ${boxItemId}`, 1);
    if (mode === "raw") {
      for (const file of manifest.files) {
        if (file.ownership === "box-owned" && file.box_relative_path) {
          rmSync(join(boxItemRoot(parsed.options.data, boxItemId), file.box_relative_path), { force: true });
        }
      }
    }
    const next = {
      ...manifest,
      status: "forgotten" as const,
      updated_at: new Date().toISOString(),
      quality: {
        ...manifest.quality,
        signals: [...manifest.quality.signals, `forgotten:${mode}`],
      },
    };
    writeBoxManifest(parsed.options.data, next);
    print(parsed, `${commandBase} forget`, { item: boxItemSummary(next), mode }, `Box item forgotten: ${boxItemId}`);
    return;
  }
  if (subcommand === "rebuild-index") {
    const report = rebuildBoxIndex(parsed.options.data);
    print(parsed, `${commandBase} rebuild-index`, report, `Box index rebuilt: indexed=${report.indexed_count} skipped=${report.skipped_count}`);
    return;
  }
  fail(parsed, "unknown_command", `unknown box command: ${subcommand}`);
}

function feedbackListSummary(entry: FeedbackEntry): Record<string, unknown> {
  return {
    feedback_id: entry.feedback_id,
    status: entry.status,
    priority: entry.priority,
    scope: entry.scope,
    category: entry.category,
    target_ref: entry.target_ref,
    promotion_target: entry.promotion_target,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    review_after: entry.review_after,
    expires_at: entry.expires_at,
    privacy_class: entry.privacy_class,
    text_chars: entry.text.length,
  };
}

function isFeedbackResolveStatus(value: string): value is FeedbackResolveStatus {
  return value === "applied" ||
    value === "discarded" ||
    value === "superseded" ||
    value === "needs_clarification";
}

function cognitionKnowHow(parsed: ParsedCommonOptions, args: string[], commandBase: string): void {
  const subcommand = args[0] ?? "list";
  if (subcommand === "list") {
    const entries = listKnowHowEntries(parsed.options.data);
    print(parsed, `${commandBase} list`, { entries }, entries.length
      ? entries.map((entry) => `${entry.knowhow_id}: ${entry.status} ${entry.name}`).join("\n")
      : "No know-how entries.");
    return;
  }
  if (subcommand === "show") {
    const knowhowId = args[1];
    if (!knowhowId) fail(parsed, "invalid_arguments", "know-how show requires <knowhow_id>");
    const entry = readKnowHowEntry(parsed.options.data, knowhowId);
    if (!entry) fail(parsed, "not_found", `know-how not found: ${knowhowId}`, 1);
    print(parsed, `${commandBase} show`, { entry }, `${entry.knowhow_id}: ${entry.status} ${entry.summary}`);
    return;
  }
  if (subcommand === "disable") {
    const knowhowId = args[1];
    if (!knowhowId) fail(parsed, "invalid_arguments", "know-how disable requires <knowhow_id>");
    requireYes(parsed, "know-how disable");
    const entry = readKnowHowEntry(parsed.options.data, knowhowId);
    if (!entry) fail(parsed, "not_found", `know-how not found: ${knowhowId}`, 1);
    const next = {
      ...entry,
      status: "disabled" as const,
      updated_at: new Date().toISOString(),
      revision_history: [
        ...entry.revision_history,
        { at: new Date().toISOString(), kind: "operator_disable", previous_status: entry.status },
      ],
    };
    writeKnowHowEntry(parsed.options.data, next);
    print(parsed, `${commandBase} disable`, { entry: next }, `Know-how disabled: ${knowhowId}`);
    return;
  }
  if (subcommand === "retrieve") {
    const query = args.slice(1).filter((arg) => !arg.startsWith("--")).join(" ").trim();
    if (!query) fail(parsed, "invalid_arguments", "know-how retrieve requires <query>");
    const result = retrieveKnowHow({
      butlerData: parsed.options.data,
      query,
      limit: numericOption(args, "--limit", 5),
    });
    print(parsed, `${commandBase} retrieve`, result, result.selected
      ? `${result.selected.knowhow_id}: ${result.selected.name}`
      : "No applicable know-how.");
    return;
  }
  if (subcommand === "source-quality") {
    const summaries = aggregateSourceQuality(parsed.options.data);
    print(parsed, `${commandBase} source-quality`, { summaries }, summaries.length
      ? summaries.map((item) => `${item.tool_name}/${item.source_id}: score=${item.score} events=${item.event_count}`).join("\n")
      : "No source-quality events.");
    return;
  }
  if (subcommand === "rebuild-index") {
    const result = rebuildKnowHowIndex(parsed.options.data);
    print(parsed, `${commandBase} rebuild-index`, result, `Know-how index rebuilt: indexed=${result.indexed_count} sourceQuality=${result.source_quality_count}`);
    return;
  }
  fail(parsed, "unknown_command", `unknown know-how command: ${subcommand}`);
}

async function cognitionConsolidation(parsed: ParsedCommonOptions, args: string[], commandBase: string): Promise<void> {
  const subcommand = args[0] ?? "status";
  if (subcommand === "status") {
    const feedbackEntries = listFeedbackEntries(parsed.options.data);
    const knowHowEntries = listKnowHowEntries(parsed.options.data);
    const boxItems = listIndexedBoxItems(parsed.options.data, 100);
    const state = {
      feedbackCount: feedbackEntries.length,
      activeFeedbackCount: feedbackEntries.filter((entry) => entry.status === "active").length,
      knowhowCount: knowHowEntries.length,
      boxItems: boxItems.length,
    };
    print(parsed, `${commandBase} status`, state, [
      `feedback=${state.feedbackCount} active=${state.activeFeedbackCount}`,
      `knowhow=${state.knowhowCount}`,
      `boxItems=${state.boxItems}`,
    ].join("\n"));
    return;
  }
  if (subcommand === "run" && hasFlag(args, "--manual")) {
    const result = await runCognitionConsolidationCycle({
      butlerData: parsed.options.data,
      manual: true,
      runId: optionValue(args, "--run-id") ?? undefined,
      resume: hasFlag(args, "--resume"),
    });
    print(parsed, `${commandBase} run --manual`, result, `Consolidation cycle ${result.status}: phases=${result.phases.length}`);
    return;
  }
  fail(parsed, "unknown_command", `unknown consolidation command: ${subcommand}`);
}

async function cognition(parsed: ParsedCommonOptions, args: string[], commandBase: "butler cognition" | "butler cog"): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "memory") return memory(parsed, rest, `${commandBase} memory`);
  if (subcommand === "migrate") return cognitionMigrate(parsed, rest, commandBase);
  if (subcommand === "feedback") return cognitionFeedback(parsed, rest, `${commandBase} feedback`);
  if (subcommand === "box") return cognitionBox(parsed, rest, `${commandBase} box`);
  if (subcommand === "know-how") return cognitionKnowHow(parsed, rest, `${commandBase} know-how`);
  if (subcommand === "consolidation") return await cognitionConsolidation(parsed, rest, `${commandBase} consolidation`);
  fail(parsed, "unknown_command", `unknown cognition command: ${subcommand ?? ""}`);
}

async function context(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const subcommand = args[0] || "status";
  if (subcommand === "status") {
    const data = buildContextStats(parsed.options.home);
    print(parsed, "butler context status", data, [
      `model=${data.model}`,
      `total=${data.total} budget=${data.budget} usedRatio=${(data.usedRatio * 100).toFixed(1)}%`,
      `threshold=${data.thresholdState}`,
    ].join("\n"));
    return;
  }
  if (subcommand === "compact") {
    requireYes(parsed, "context compact");
    const sessionId = optionValue(args, "--session");
    if (!sessionId) fail(parsed, "invalid_arguments", "context compact requires --session SESSION_ID");
    const snapshot = await compactTranscript({
      butlerData: parsed.options.data,
      sessionId,
      trigger: "manual",
      modelRef: null,
    });
    print(parsed, "butler context compact", {
      snapshotId: snapshot.snapshot_id,
      sessionId: snapshot.session_id,
      status: snapshot.status,
      preEstimatedTokens: snapshot.pre_estimated_tokens,
      postEstimatedTokens: snapshot.post_estimated_tokens,
      diagnostics: snapshot.diagnostics,
    }, `Compaction ${snapshot.status}: ${snapshot.snapshot_id}`);
    return;
  }
  if (subcommand === "prune") {
    const data = runContextPrune(parsed.options.data);
    print(parsed, "butler context prune", data, [
      "Context maintenance prune complete.",
      `Artifacts deleted=${data.artifacts.deleted} bytesDeleted=${data.artifacts.bytesDeleted}`,
      `Metrics deleted=${data.metrics.deleted} parseErrors=${data.metrics.parseErrors}`,
    ].join("\n"));
    return;
  }
  fail(parsed, "unknown_command", `unknown context command: ${subcommand}`);
}

function runContextPrune(butlerData: string) {
  const dayMs = 24 * 60 * 60 * 1000;
  const artifacts = pruneToolOutputArtifacts({
    butlerData,
    maxAgeMs: 30 * dayMs,
    maxBytes: 512 * 1024 * 1024,
    recordTelemetry: true,
  });
  const metrics = pruneContextMetricFiles({
    butlerData,
    maxAgeMs: 90 * dayMs,
  }).totals;
  return {
    ok: true,
    butlerData,
    artifacts,
    metrics,
    privacy: { rawTextStored: false },
  };
}

function searchStatus(parsed: ParsedCommonOptions): void {
  const config = (() => {
    try {
      return readConfig(parsed.options.data);
    } catch {
      return {};
    }
  })();
  const provider = String(process.env.BUTLER_WEB_SEARCH_PROVIDER || config.webSearch?.provider || "duckduckgo-html");
  const env = readPrivateEnv(parsed.options.data);
  const data = {
    provider,
    providerEffective: createConfiguredWebSearchProvider({ butlerData: parsed.options.data }).id,
    braveKeyConfigured: Boolean(process.env.BUTLER_BRAVE_SEARCH_API_KEY || process.env.BRAVE_SEARCH_API_KEY || env.BUTLER_BRAVE_SEARCH_API_KEY),
    tavilyKeyConfigured: Boolean(process.env.BUTLER_TAVILY_API_KEY || process.env.TAVILY_API_KEY || env.BUTLER_TAVILY_API_KEY),
    openAIKeyConfigured: Boolean(process.env.OPENAI_API_KEY || env.OPENAI_API_KEY),
    readerBackend: configuredPageReaderBackend({ butlerData: parsed.options.data }),
    metrics: readWebSearchMetrics(parsed.options.data),
    redacted: true,
  };
  print(parsed, "butler search status", data, [
    `provider=${data.provider}`,
    `effective=${data.providerEffective}`,
    `reader=${data.readerBackend}`,
    `requests=${data.metrics.requestCount}`,
  ].join("\n"));
}

async function searchTest(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const query = args.slice(1).filter((arg) => !arg.startsWith("--")).join(" ").trim();
  if (!query) fail(parsed, "invalid_arguments", "search test requires <query>");
  try {
    const output = await createConfiguredWebSearchProvider({ butlerData: parsed.options.data }).search({
      query,
      max_results: 5,
    });
    const data = {
      provider: output.provider,
      duration_ms: output.duration_ms,
      results: output.results.map((result) => ({
        title: result.title,
        source: result.source,
        url: result.url,
        snippet: result.snippet.slice(0, 300),
      })),
      usage: output.usage,
    };
    print(parsed, "butler search test", data, data.results.length
      ? data.results.map((result) => `${result.title} — ${result.source}`).join("\n")
      : "Search completed with no results.");
  } catch (error) {
    fail(parsed, "external_unavailable", error instanceof Error ? error.message : String(error), 5);
  }
}

async function webRead(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const url = args[1];
  if (!url) fail(parsed, "invalid_arguments", "web read requires <url>");
  const result = await readPageConfigured({
    butlerData: parsed.options.data,
    url,
  });
  const data = {
    ok: result.ok,
    reader: result.reader,
    requestedUrl: result.requestedUrl,
    finalUrl: result.finalUrl,
    status: result.status ?? null,
    title: result.title ?? null,
    method: result.method,
    durationMs: result.durationMs,
    warnings: result.warnings,
    renderRecommended: result.renderRecommended,
    preview: result.markdown.replace(/\s+/g, " ").slice(0, 500),
    chunkCount: result.chunks.length,
    error: result.error ?? null,
  };
  print(parsed, "butler web read", data, [
    `reader=${data.reader} ok=${data.ok} status=${data.status ?? "unknown"}`,
    `title=${data.title ?? "unknown"}`,
    `warnings=${data.warnings.join(", ") || "none"}`,
    data.preview,
  ].filter(Boolean).join("\n"));
}

function updateComponentFromArgs(args: string[]): UpdateComponentId | null {
  return normalizeUpdateComponentId(optionValue(args, "--component") ?? "agent");
}

async function update(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  const dryRun = hasFlag(args, "--dry-run");
  const checkOnly = hasFlag(args, "--check");
  const apply = hasFlag(args, "--apply") || dryRun || !checkOnly;
  if (checkOnly && hasFlag(args, "--apply")) {
    fail(parsed, "invalid_arguments", "update accepts either --check or --apply, not both");
  }
  const component = updateComponentFromArgs(args);
  if (!component) fail(parsed, "invalid_arguments", "unknown update component");
  if (component !== "service" && apply && !dryRun) {
    fail(parsed, "unsupported_component", "CLI update apply currently supports --component agent; Butler App updates are applied by the App updater");
  }
  const manifestPath = optionValue(args, "--manifest");
  const channel = optionValue(args, "--channel") ?? "stable";
  try {
    if (checkOnly && !dryRun) {
      const view = await checkComponentUpdates({
        root: parsed.options.home,
        butlerData: parsed.options.data,
        components: [component],
        manifestPath,
        channel,
      });
      const status = view.components[0]!;
      print(parsed, "butler update", {
        ...status,
        dryRun: false,
      }, renderServiceUpdateResult(status));
      return;
    }
    if (apply && !dryRun) requireYes(parsed, "update");
    const result = await applyComponentUpdate({
      root: parsed.options.home,
      butlerData: parsed.options.data,
      component,
      manifestPath,
      channel,
      dryRun,
    });
    print(parsed, "butler update", result, dryRun
      ? result.planned_actions.map((action) => `would ${action}`).join("\n")
      : renderServiceUpdateResult(result));
    if (result.stage_status === "rolled_back") {
      process.exitCode = 1;
    }
  } catch (error) {
    fail(parsed, "update_failed", error instanceof Error ? error.message : String(error), 1);
  }
}

function uninstall(parsed: ParsedCommonOptions, args: string[]): never {
  requireYes(parsed, "uninstall");
  runShell("bash", [join(parsed.options.home, "uninstall.sh"), hasFlag(args, "--keep-data") ? "--keep-data" : ""].filter(Boolean), parsed);
}

function runShell(program: string, args: string[], parsed: ParsedCommonOptions): never {
  const result = spawnSync(program, args, {
    cwd: parsed.options.home,
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

function auth(parsed: ParsedCommonOptions, args: string[]): void {
  if (args[0] === "logout") return authLogout(parsed);
  fail(parsed, "unknown_command", `unknown auth command: ${args[0] ?? ""}`);
}

async function model(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  if (args[0] === "list") return await modelList(parsed);
  if (args[0] === "set") return modelSet(parsed, args);
  fail(parsed, "unknown_command", `unknown model command: ${args[0] ?? ""}`);
}

async function transport(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  if (args[0] === "status") return await transportStatus(parsed);
  if (args[0] === "test") return await transportTest(parsed, args);
  fail(parsed, "unknown_command", `unknown transport command: ${args[0] ?? ""}`);
}

async function gateway(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  if (args[0] === "list") return await gatewayList(parsed);
  if (args[0] === "status") return await gatewayStatus(parsed, args);
  if (args[0] === "inspect") return await gatewayInspect(parsed, args);
  if (args[0] === "enable") return await gatewaySetEnabled(parsed, args, true);
  if (args[0] === "disable") return await gatewaySetEnabled(parsed, args, false);
  if (args[0] === "configure") return await gatewayConfigure(parsed, args);
  if (args[0] === "credential") return await gatewayCredential(parsed, args);
  if (args[0] === "pair") return await gatewayPair(parsed, args);
  if (args[0] === "unpair") return await gatewayUnpair(parsed, args);
  if (args[0] === "test") return await gatewayTest(parsed, args);
  if (args[0] === "logs") return gatewayLogs(parsed, args);
  if (args[0] === "run") return gatewayRun(parsed, args);
  if (args[0] === "start") return await gatewayStart(parsed, args);
  if (args[0] === "stop") return await gatewayStop(parsed, args);
  if (args[0] === "restart") return await gatewayRestart(parsed, args);
  fail(parsed, "unknown_command", `unknown gateway command: ${args[0] ?? ""}`);
}

async function telegram(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  if (args[0] === "send-test") return await telegramSendTest(parsed, args);
  if (args[0] === "unpair") return telegramUnpair(parsed);
  fail(parsed, "unknown_command", `unknown telegram command: ${args[0] ?? ""}`);
}

function config(parsed: ParsedCommonOptions, args: string[]): void {
  if (args[0] === "get") return configGet(parsed, args);
  if (args[0] === "set") return configSet(parsed, args);
  if (args[0] === "validate") return configValidate(parsed);
  if (args[0] === "edit") return configEdit(parsed);
  fail(parsed, "unknown_command", `unknown config command: ${args[0] ?? ""}`);
}

function personalizationShow(parsed: ParsedCommonOptions): void {
  const profile = readPersonalizationProfile(parsed.options.data);
  const profiling = readProfilingConsentSnapshot(parsed.options.data);
  const extractorModel = readProfilingExtractorModelConfig(parsed.options.data);
  print(
    parsed,
    "butler personalization show",
    {
      profile,
      storage_label: PERSONALIZATION_PROFILE_STORAGE_LABEL,
      profiling: {
        mode: profiling.mode,
        enabled: profiling.mode !== "off",
        consent_version: profiling.consent_version,
        consented_at: profiling.consented_at,
        storage_label: PROFILE_BLACK_BOX_STORAGE_LABEL,
        raw_profile_browser_visible: false,
        extractor_model: extractorModel.configured_model ?? "default",
        effective_extractor_model: extractorModel.effective_model,
        extractor_uses_butler_model: extractorModel.uses_butler_model,
      },
    },
    [
      "Personalization profile",
      `Butler nickname: ${profile.butler_nickname || "(unset)"}`,
      `Principal name: ${profile.principal_name || "(unset)"}`,
      `Preferred address: ${profile.preferred_address || "(unset)"}`,
      `Storage: ${PERSONALIZATION_PROFILE_STORAGE_LABEL}`,
      `Profiling: ${profiling.mode}`,
      `Profile extractor model: ${extractorModel.configured_model ?? "default"} (${extractorModel.effective_model})`,
      `Profile black box: ${PROFILE_BLACK_BOX_STORAGE_LABEL}`,
    ].join("\n"),
  );
}

function personalizationSet(parsed: ParsedCommonOptions, args: string[]): void {
  const update: PersonalizationProfileUpdate = {};
  const butlerNickname =
    optionValue(args, "--butler-nickname") ?? optionValue(args, "--butler-name");
  const principalName =
    optionValue(args, "--principal-name") ?? optionValue(args, "--user-name");
  const preferredAddress =
    optionValue(args, "--preferred-address") ?? optionValue(args, "--address");
  const profilingMode = optionValue(args, "--profiling-mode");
  const profilingExtractorModel =
    optionValue(args, "--profiling-extractor-model") ??
    optionValue(args, "--profile-extractor-model");
  const clearProfile = hasFlag(args, "--clear-profile");

  if (butlerNickname !== null) update.butler_nickname = butlerNickname;
  if (principalName !== null) update.principal_name = principalName;
  if (preferredAddress !== null) update.preferred_address = preferredAddress;
  if (
    profilingMode !== null &&
    profilingMode !== "off" &&
    profilingMode !== "basic" &&
    profilingMode !== "deep"
  ) {
    fail(parsed, "invalid_arguments", "--profiling-mode must be off, basic, or deep");
  }
  if (Object.keys(update).length === 0 && profilingMode === null && profilingExtractorModel === null && !clearProfile) {
    fail(
      parsed,
      "invalid_arguments",
      "personalization set requires at least one of --butler-nickname, --principal-name, --preferred-address, --profiling-mode, --profiling-extractor-model, or --clear-profile",
    );
  }

  const profile = Object.keys(update).length > 0
    ? updatePersonalizationProfile(parsed.options.data, update)
    : readPersonalizationProfile(parsed.options.data);
  const profiling = profilingMode === null
    ? readProfilingConsentSnapshot(parsed.options.data)
    : setProfilingMode(parsed.options.data, profilingMode);
  const extractorModel = profilingExtractorModel === null
    ? readProfilingExtractorModelConfig(parsed.options.data)
    : setProfilingExtractorModel(parsed.options.data, profilingExtractorModel);
  const cleared = clearProfile ? clearProfilingData(parsed.options.data) : null;
  print(
    parsed,
    "butler personalization set",
    {
      profile,
      storage_label: PERSONALIZATION_PROFILE_STORAGE_LABEL,
      updated_fields: Object.keys(update).sort(),
      profiling: {
        mode: profiling.mode,
        enabled: profiling.mode !== "off",
        consent_version: profiling.consent_version,
        consented_at: profiling.consented_at,
        storage_label: PROFILE_BLACK_BOX_STORAGE_LABEL,
        raw_profile_browser_visible: false,
        extractor_model: extractorModel.configured_model ?? "default",
        effective_extractor_model: extractorModel.effective_model,
        extractor_uses_butler_model: extractorModel.uses_butler_model,
      },
      cleared_profile: cleared,
    },
    [
      "Personalization profile updated.",
      `Storage: ${PERSONALIZATION_PROFILE_STORAGE_LABEL}`,
      `Profiling: ${profiling.mode}`,
      `Profile extractor model: ${extractorModel.configured_model ?? "default"} (${extractorModel.effective_model})`,
      `Profile black box: ${PROFILE_BLACK_BOX_STORAGE_LABEL}`,
    ].join("\n"),
  );
}

function personalizationMigrationPrompt(parsed: ParsedCommonOptions, args: string[]): void {
  const localeValue = optionValue(args, "--locale");
  const locale = localeValue === "ko" ? "ko" : "en";
  const prompt = profileThirdPartyMigrationPrompt(locale);
  print(
    parsed,
    "butler personalization migration prompt",
    {
      locale,
      prompt,
      raw_profile_included: false,
    },
    prompt,
  );
}

async function personalizationMigrationImport(
  parsed: ParsedCommonOptions,
  args: string[],
): Promise<void> {
  const source = optionValue(args, "--source") ?? "external-ai";
  const file = optionValue(args, "--file");
  const model = optionValue(args, "--model");
  const useStdin = hasFlag(args, "--stdin") || file === "-";
  if (!file && !useStdin) {
    fail(parsed, "invalid_arguments", "personalization migration import requires --file PATH or --stdin");
  }
  const text = useStdin
    ? readFileSync(0, "utf8")
    : readFileSync(file!, "utf8");
  const result = await importProfileCandidatesFromThirdPartyDumpWithModel(
    parsed.options.data,
    { source, text, model },
  );
  print(
    parsed,
    "butler personalization migration import",
    result,
    [
      result.profiling_enabled
        ? "Profile migration imported."
        : "Profiling is off; profile migration skipped.",
      `Source: ${result.source}`,
      `Model called: ${result.model_called}`,
      `Imported candidates: ${result.imported_candidate_count}`,
      `Promoted entries: ${result.promoted_count}`,
      `Stable profile entries: ${result.stable_entry_count}`,
      "Raw import text stored: no",
    ].join("\n"),
  );
}

async function personalizationMigration(
  parsed: ParsedCommonOptions,
  args: string[],
): Promise<void> {
  const subcommand = args[1] ?? "prompt";
  if (subcommand === "prompt") return personalizationMigrationPrompt(parsed, args);
  if (subcommand === "import") return await personalizationMigrationImport(parsed, args);
  fail(parsed, "unknown_command", `unknown personalization migration command: ${subcommand}`);
}

async function personalization(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  if (args[0] === "show" || args[0] === "get" || !args[0]) {
    return personalizationShow(parsed);
  }
  if (args[0] === "set") return personalizationSet(parsed, args);
  if (args[0] === "migration" || args[0] === "migrate") {
    return await personalizationMigration(parsed, args);
  }
  fail(parsed, "unknown_command", `unknown personalization command: ${args[0]}`);
}

async function search(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  if (args[0] === "status") return searchStatus(parsed);
  if (args[0] === "test") return await searchTest(parsed, args);
  fail(parsed, "unknown_command", `unknown search command: ${args[0] ?? ""}`);
}

async function web(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  if (args[0] === "read") return await webRead(parsed, args);
  fail(parsed, "unknown_command", `unknown web command: ${args[0] ?? ""}`);
}

async function main(): Promise<void> {
  const parsed = parseCommonOptions(Bun.argv.slice(2));
  if (parsed.errors.length > 0) fail(parsed, "invalid_arguments", parsed.errors.join("; "));
  prepareEnvironment(parsed);
  const [command, ...args] = parsed.args;
  if (command === "update") return update(parsed, args);
  if (command === "uninstall") return uninstall(parsed, args);
  if (command === "logs") return logs(parsed, args);
  if (command === "ps") return ps(parsed);
  if (command === "metrics" && args[0] === "tail") return metricsTail(parsed, args);
  if (command === "config") return config(parsed, args);
  if (command === "personalization") return await personalization(parsed, args);
  if (command === "auth") return auth(parsed, args);
  if (command === "model") return await model(parsed, args);
  if (command === "transport") return await transport(parsed, args);
  if (command === "gateway") return await gateway(parsed, args);
  if (command === "mcp") return await mcp(parsed, args);
  if (command === "skills") return skills(parsed, args);
  if (command === "telegram") return await telegram(parsed, args);
  if (command === "work") return work(parsed, args);
  if (command === "cognition") return await cognition(parsed, args, "butler cognition");
  if (command === "cog") return await cognition(parsed, args, "butler cog");
  if (command === "memory") return removedLegacyMemory(parsed);
  if (command === "context") return await context(parsed, args);
  if (command === "maintenance" && args[0] === "context") {
    const data = runContextPrune(parsed.options.data);
    print(parsed, "butler maintenance context", data, [
      "Context maintenance prune complete.",
      `Artifacts deleted=${data.artifacts.deleted} bytesDeleted=${data.artifacts.bytesDeleted}`,
      `Metrics deleted=${data.metrics.deleted} parseErrors=${data.metrics.parseErrors}`,
    ].join("\n"));
    return;
  }
  if (command === "search") return await search(parsed, args);
  if (command === "web") return await web(parsed, args);
  fail(parsed, "unknown_command", `unknown Butler operator command: ${parsed.args.join(" ")}`);
}

if (import.meta.main) {
  await main();
}
