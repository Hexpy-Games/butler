#!/usr/bin/env bun
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { SessionBindingStore } from "../src/test-support/harness/session-store.ts";
import { readTranscript } from "../src/test-support/harness/transcripts.ts";
import { getRuntimeControlPlaneSummary } from "../src/integrations/providers/provider.ts";
import { readPromptCacheMetrics, summarizePromptCacheMetrics } from "../src/integrations/providers/prompt-cache-metrics.ts";
import { readOperationalHealth, renderOperationalHealth } from "../src/operations/health/operational-health.ts";
import { evaluateContextBudget } from "../src/agent/context/budget.ts";
import { cognitionMemoryRoot } from "../src/agent/cognition/paths.ts";
import { butlerAgentResourcesPath } from "../src/runtime/paths.ts";

const HOME = homedir();
const BUTLER_HOME_DEFAULT = join(HOME, "butler");
export const BUDGET = 200_000;
export const AUTOCOMPACT = 33_000;

function roughTokenCount(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function readTextIfExists(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export interface ContextStats {
  model: string;
  budget: number;
  systemPrompt: number;
  systemTools: number;
  mcpTools: number;
  customAgents: number;
  memoryFiles: number;
  skills: number;
  messages: number;
  freeSpace: number;
  autocompact: number;
  total: number;
  thresholdState: string;
  usedRatio: number;
  reservedOutput: number;
  reservedTool: number;
}

function readConfiguredButlerModel(butlerData: string): string {
  const configPath = join(butlerData, "butler.config.json");
  if (!existsSync(configPath)) return "openai/gpt-5.5-codex";
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    return cfg?.system?.butlerModel || cfg?.system?.defaultModel || "openai/gpt-5.5-codex";
  } catch {
    return "openai/gpt-5.5-codex";
  }
}

function activeButlerSession(butlerData: string) {
  const storePath = join(butlerData, "runtime", "session-store.sqlite");
  if (!existsSync(storePath)) return null;
  const store = new SessionBindingStore(storePath);
  try {
    return store
      .listSessions({ lifecycleState: ["active", "closing"] })
      .find((session) => session.role === "butler") ?? null;
  } finally {
    store.close();
  }
}

function promptText(butlerHome: string, butlerData: string): string {
  return [
    readTextIfExists(butlerAgentResourcesPath(butlerHome, "prompts", "butler.md")),
    readTextIfExists(butlerAgentResourcesPath(butlerHome, "eol.md")),
    readTextIfExists(join(butlerData, "personas", "active.md")),
  ].filter(Boolean).join("\n\n");
}

function memoryText(butlerData: string): string {
  const memoryRoot = cognitionMemoryRoot(butlerData);
  return [
    readTextIfExists(join(memoryRoot, "user-profile.md")),
    readTextIfExists(join(memoryRoot, "hot", "cache.md")),
    readTextIfExists(join(memoryRoot, "rules", "INDEX.md")),
  ].filter(Boolean).join("\n\n");
}

function transcriptText(sessionId: string | undefined): string {
  if (!sessionId) return "";
  return readTranscript(sessionId)
    .map((event) => JSON.stringify(event.payload ?? {}))
    .join("\n");
}

export function buildContextStats(
  butlerHome: string = process.env.BUTLER_HOME ?? BUTLER_HOME_DEFAULT,
): ContextStats {
  const butlerData = process.env.BUTLER_DATA || join(HOME, ".butler");
  const session = activeButlerSession(butlerData);
  const model = session?.modelRef || readConfiguredButlerModel(butlerData);
  const systemPrompt = roughTokenCount(promptText(butlerHome, butlerData));
  const memoryFiles = roughTokenCount(memoryText(butlerData));
  const messages = roughTokenCount(transcriptText(session?.sessionId));
  const systemTools = 0;
  const mcpTools = 0;
  const customAgents = 0;
  const skills = 0;
  const total = systemPrompt + systemTools + mcpTools + customAgents + memoryFiles + skills + messages;
  const budget = evaluateContextBudget({
    modelRef: model,
    inputTokens: total,
  });
  const autoCompactAt = Math.floor(budget.contextWindowTokens * budget.autoCompactThresholdRatio);
  return {
    model,
    budget: budget.contextWindowTokens,
    systemPrompt,
    systemTools,
    mcpTools,
    customAgents,
    memoryFiles,
    skills,
    messages,
    freeSpace: Math.max(0, autoCompactAt - total),
    autocompact: autoCompactAt,
    total,
    thresholdState: budget.thresholdState,
    usedRatio: budget.usedRatio,
    reservedOutput: budget.reservedOutputTokens,
    reservedTool: budget.reservedToolTokens,
  };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function renderStatusContext(): string {
  const butlerData = process.env.BUTLER_DATA || join(HOME, ".butler");
  const stats = buildContextStats();
  const control = getRuntimeControlPlaneSummary({ cacheScope: "status-context" });
  const cacheMetrics = summarizePromptCacheMetrics(readPromptCacheMetrics());
  const operationalHealth = renderOperationalHealth(readOperationalHealth(butlerData));
  const cachePolicy = control.promptCache.configured
    ? [
        control.promptCache.effectiveKey ? `key=${control.promptCache.effectiveKey}` : null,
        control.promptCache.retention ? `retention=${control.promptCache.retention}` : null,
      ].filter(Boolean).join(", ")
    : "default";
  return [
    "## Runtime",
    `runtime: ${control.runtime}`,
    `provider: ${control.providerId}`,
    `model: ${control.modelRef}`,
    `prompt cache policy: ${cachePolicy}`,
    `prompt cache telemetry: requests=${cacheMetrics.requestCount}, cached=${cacheMetrics.cachedTokens}, hitRatio=${cacheMetrics.cacheHitRatio.toFixed(3)}`,
    "",
    "## Context Estimate",
    `model: ${stats.model}`,
    `budget: ${fmt(stats.budget)}`,
    `system prompt: ${fmt(stats.systemPrompt)}`,
    `memory: ${fmt(stats.memoryFiles)}`,
    `messages: ${fmt(stats.messages)}`,
    `total: ${fmt(stats.total)}`,
    `used ratio: ${(stats.usedRatio * 100).toFixed(1)}%`,
    `threshold: ${stats.thresholdState}`,
    `reserved output: ${fmt(stats.reservedOutput)}`,
    `reserved tool: ${fmt(stats.reservedTool)}`,
    `free before autocompact: ${fmt(stats.freeSpace)}`,
    "",
    operationalHealth,
  ].join("\n");
}

if (import.meta.main) {
  console.log(renderStatusContext());
}
