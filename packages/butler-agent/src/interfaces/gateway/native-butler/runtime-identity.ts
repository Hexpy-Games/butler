import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ModelRef,
  ModelProviderAdapter,
  SessionLifecycleState,
  StoredSessionBinding,
} from "../../../test-support/harness/contracts.ts";
import { registerRuntimeSession } from
  "../../../test-support/harness/session-runtime.ts";
import { SessionBindingStore } from
  "../../../test-support/harness/session-store.ts";
import { runPromptText } from "../../../integrations/providers/provider.ts";
import {
  providerCapabilitiesForModel,
  resolveProviderAdapterDefinition,
} from "../../../integrations/providers/registry.ts";

export type ButlerConfig = {
  system?: {
    runtime?: string;
    butlerModel?: string;
    defaultModel?: string;
  };
};

const DEFAULT_BUTLER_SESSION_ID = "butler/main";

export function resolveButlerHome(explicit?: string): string {
  return explicit || process.env.BUTLER_HOME || process.cwd();
}

export function resolveButlerData(explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

export function readButlerConfig(butlerData: string): ButlerConfig {
  const path = join(butlerData, "butler.config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ButlerConfig;
  } catch {
    return {};
  }
}

type PromptTextRunner = typeof runPromptText;

export function createNativeButlerDefaultProvider(
  config: ButlerConfig = {},
  promptRunner: PromptTextRunner = runPromptText,
): ModelProviderAdapter {
  const configuredModel = config.system?.butlerModel || config.system?.defaultModel || "";
  const invoke: ModelProviderAdapter["invoke"] = async (input) => {
    const prompt = input.messages
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n\n");
    const text = await promptRunner({
      prompt,
      model: input.model,
      instructions: input.systemPrompt,
      responseFormat: input.responseFormat,
      reasoningEffort: input.reasoning?.effort,
      signal: input.signal,
      cacheScope: "native-butler-title-provider",
      ...(input.metadata?.purpose === "app_session_title"
        ? { providerRetryAttempts: 1 }
        : {}),
    });
    return { text };
  };
  const forModel = (model: string): ModelProviderAdapter => ({
    id: resolveProviderAdapterDefinition(model).providerId,
    capabilities: providerCapabilitiesForModel(model),
    capabilitiesFor: providerCapabilitiesForModel,
    forModel,
    invoke,
  });
  return forModel(configuredModel);
}

export function resolveButlerSession(
  store: SessionBindingStore,
  butlerData: string,
): string {
  const pointer = readSessionPointer(butlerData);
  if (pointer) return pointer;
  const existing = store
    .listSessions({
      lifecycleState: ["active", "closing"] satisfies SessionLifecycleState[],
    })
    .filter((session) => session.role === "butler")
    .sort((left, right) =>
      (right.lastActiveAt ?? right.updatedAt)
        .localeCompare(left.lastActiveAt ?? left.updatedAt))[0];
  return existing?.sessionId ?? DEFAULT_BUTLER_SESSION_ID;
}

export function bindButlerSession(input: {
  store: SessionBindingStore;
  sessionId: string;
  butlerHome: string;
  butlerData: string;
  provider: ModelProviderAdapter;
}): StoredSessionBinding {
  const existing = input.store.getBySessionId(input.sessionId);
  if (!existing || existing.lifecycleState === "closed" || existing.lifecycleState === "crashed") {
    return registerRuntimeSession({
      sessionId: input.sessionId,
      role: "butler",
      workspacePath: input.butlerHome,
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId: input.provider.id,
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      source: "native-butler-bootstrap",
    });
  }
  return input.store.upsert({
    sessionId: existing.sessionId,
    role: existing.role,
    projectId: existing.projectId,
    workspacePath: existing.workspacePath,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: providerId(existing.modelRef, input.provider.id),
    modelRef: existing.modelRef,
    runtimeSessionRef: existing.runtimeSessionRef,
    providerThreadRef: existing.providerThreadRef,
    transportBindings: existing.transportBindings,
    metadata: existing.metadata,
    lifecycleState: "active",
    createdAt: existing.createdAt,
  });
}

export function persistButlerSessionPointer(
  butlerData: string,
  sessionId: string,
): void {
  const path = sessionPointerPath(butlerData);
  mkdirSync(join(butlerData, "config"), { recursive: true });
  writeFileSync(path, `${sessionId}\n`, "utf8");
}

function sessionPointerPath(butlerData: string): string {
  return join(butlerData, "config", "session-id.txt");
}

function readSessionPointer(butlerData: string): string | null {
  const path = sessionPointerPath(butlerData);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function providerId(modelRef: string | undefined, fallback: string): string {
  return modelRef?.split("/", 1)[0]?.trim() || fallback;
}

export function requireModelRef(modelRef: string | undefined): ModelRef {
  if (!modelRef?.trim()) throw new Error("Stored Butler session has no model binding");
  if (!modelRef.includes("/")) throw new Error("Stored Butler model binding is not canonical");
  return modelRef as ModelRef;
}
