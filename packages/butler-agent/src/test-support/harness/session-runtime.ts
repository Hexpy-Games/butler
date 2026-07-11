import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ModelRef, SessionBinding, SessionLifecycleState, StoredSessionBinding } from "./contracts.ts";
import { recordSessionLifecycle } from "./durable-session-transcript.ts";
import { SessionBindingStore } from "./session-store.ts";

type DurableRole = "butler" | "steward";

interface ButlerProjectConfig {
  name?: string;
  path?: string;
}

interface ButlerTelegramTopicConfig {
  project?: string;
  path?: string;
  topicName?: string;
}

interface ButlerConfig {
  system?: {
    runtime?: string;
    butlerModel?: string;
    workerModel?: string;
    defaultModel?: string;
  };
  projects?: ButlerProjectConfig[];
  telegram?: {
    groupId?: string;
    topics?: Record<string, ButlerTelegramTopicConfig>;
  };
}

export interface RegisterRuntimeSessionInput {
  sessionId: string;
  role: DurableRole;
  workspacePath: string;
  butlerHome?: string;
  butlerData?: string;
  modelRef?: string;
  runtimeAdapterId?: string;
  modelProviderId?: string;
  source?: string;
}

export interface TransitionRuntimeSessionInput {
  sessionId: string;
  state: SessionLifecycleState;
  reason?: string;
  role?: DurableRole;
  butlerHome?: string;
  butlerData?: string;
  source?: string;
}

export interface ResolvedRuntimeBinding {
  binding: SessionBinding;
  butlerHome: string;
  butlerData: string;
}

const DEFAULT_TELEGRAM_ACCOUNT_ID = "default";
const DEFAULT_NATIVE_MODEL_REF = "openai/gpt-5.5-codex";

function getButlerHome(explicit?: string): string {
  return explicit || process.env.BUTLER_HOME || process.cwd();
}

function getButlerData(_butlerHome: string, explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function expandHomePath(value: string | undefined, homeDir = homedir()): string | undefined {
  if (!value) return undefined;
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

function readButlerConfig(butlerData: string): ButlerConfig {
  const configPath = join(butlerData, "butler.config.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as ButlerConfig;
  } catch {
    return {};
  }
}

function inferRuntimeAdapterId(config: ButlerConfig, explicit?: string): string {
  return explicit?.trim() || process.env.BUTLER_RUNTIME || config.system?.runtime || "codex-api";
}

function inferProviderId(runtimeAdapterId: string, explicit?: string, modelRef?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const normalizedModel = modelRef?.trim();
  if (normalizedModel && normalizedModel.includes("/")) {
    return normalizedModel.split("/", 1)[0];
  }
  return runtimeAdapterId === "codex-api" ? "openai" : "custom";
}

function normalizeModelRef(model: string | undefined, providerId: string, config: ButlerConfig, role: DurableRole): ModelRef {
  const fallbackModelRef = DEFAULT_NATIVE_MODEL_REF;
  const fallback =
    role === "butler"
      ? config.system?.butlerModel || config.system?.defaultModel || fallbackModelRef
      : config.system?.workerModel || config.system?.defaultModel || fallbackModelRef;
  const chosen = model?.trim() || fallback;
  if (chosen.includes("/")) return chosen as ModelRef;
  return `${providerId}/${chosen}` as ModelRef;
}

function resolveProjectId(workspacePath: string, butlerHome: string, config: ButlerConfig): string | undefined {
  const normalizedWorkspace = expandHomePath(workspacePath, homedir()) || workspacePath;
  const normalizedButlerHome = expandHomePath(butlerHome, homedir()) || butlerHome;
  if (normalizedWorkspace === normalizedButlerHome) return "butler";

  for (const project of config.projects ?? []) {
    const projectPath = expandHomePath(project.path, homedir());
    if (projectPath && projectPath === normalizedWorkspace && project.name) {
      return project.name;
    }
  }

  return undefined;
}

function buildTransportBindings(
  role: DurableRole,
  workspacePath: string,
  butlerHome: string,
  config: ButlerConfig,
): SessionBinding["transportBindings"] {
  const normalizedWorkspace = expandHomePath(workspacePath, homedir()) || workspacePath;
  const normalizedButlerHome = expandHomePath(butlerHome, homedir()) || butlerHome;
  const groupId = config.telegram?.groupId?.trim();
  if (!groupId) return [];

  if (role === "butler") {
    return [
      {
        transport: "telegram",
        accountId: DEFAULT_TELEGRAM_ACCOUNT_ID,
        peerId: groupId,
      },
    ];
  }

  const bindings: SessionBinding["transportBindings"] = [];
  for (const [topicId, topic] of Object.entries(config.telegram?.topics ?? {})) {
    const topicPath = expandHomePath(topic.path, homedir());
    if (topicPath && topicPath === normalizedWorkspace) {
      bindings.push({
        transport: "telegram",
        accountId: DEFAULT_TELEGRAM_ACCOUNT_ID,
        peerId: groupId,
        threadId: topicId,
      });
    }
  }

  if (bindings.length > 0) return bindings;

  if (normalizedWorkspace === normalizedButlerHome) {
    return [
      {
        transport: "telegram",
        accountId: DEFAULT_TELEGRAM_ACCOUNT_ID,
        peerId: groupId,
      },
    ];
  }

  return [];
}

function sessionPointerDir(butlerData: string): string {
  return join(butlerData, "config", "subsession-sessions");
}

function sessionPointerPath(butlerData: string, projectId: string): string {
  return join(sessionPointerDir(butlerData), `${projectId.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`);
}

function writeStewardSessionPointer(butlerData: string, projectId: string | undefined, sessionId: string): void {
  if (!projectId) return;
  mkdirSync(sessionPointerDir(butlerData), { recursive: true });
  writeFileSync(sessionPointerPath(butlerData, projectId), `${sessionId}\n`, "utf8");
}

function removeStewardSessionPointer(butlerData: string, projectId: string | undefined, sessionId: string): void {
  if (!projectId) return;
  const path = sessionPointerPath(butlerData, projectId);
  if (!existsSync(path)) return;
  try {
    const current = readFileSync(path, "utf8").trim();
    if (!current || current === sessionId) {
      rmSync(path, { force: true });
    }
  } catch {
    // non-fatal cleanup
  }
}

export function getStewardSessionPointer(butlerData: string, projectId: string): string | null {
  const path = sessionPointerPath(butlerData, projectId);
  if (!existsSync(path)) return null;
  try {
    const sessionId = readFileSync(path, "utf8").trim();
    return sessionId || null;
  } catch {
    return null;
  }
}

export function resolveRuntimeBinding(input: RegisterRuntimeSessionInput): ResolvedRuntimeBinding {
  const butlerHome = getButlerHome(input.butlerHome);
  const butlerData = getButlerData(butlerHome, input.butlerData);
  const config = readButlerConfig(butlerData);
  const runtimeAdapterId = inferRuntimeAdapterId(config, input.runtimeAdapterId);
  const providerId = inferProviderId(runtimeAdapterId, input.modelProviderId, input.modelRef);
  const workspacePath = expandHomePath(input.workspacePath, homedir()) || input.workspacePath;
  const projectId = resolveProjectId(workspacePath, butlerHome, config);
  const binding: SessionBinding = {
    sessionId: input.sessionId,
    role: input.role,
    projectId,
    workspacePath,
    runtimeAdapterId,
    modelProviderId: providerId,
    modelRef: normalizeModelRef(input.modelRef, providerId, config, input.role),
    transportBindings: buildTransportBindings(input.role, workspacePath, butlerHome, config),
  };

  return {
    binding,
    butlerHome,
    butlerData,
  };
}

export function registerRuntimeSession(input: RegisterRuntimeSessionInput): StoredSessionBinding {
  const { binding, butlerData } = resolveRuntimeBinding(input);
  const store = new SessionBindingStore(join(butlerData, "runtime", "session-store.sqlite"));
  try {
    const stored = store.upsert({
      ...binding,
      lifecycleState: "active",
      metadata: {
        source: input.source ?? "runtime-register",
      },
    });
    recordSessionLifecycle({
      sessionId: stored.sessionId,
      role: stored.role,
      state: "active",
      reason: input.source ?? "runtime-register",
      metadata: {
        projectId: stored.projectId ?? null,
        workspacePath: stored.workspacePath,
      },
    });
    if (stored.role === "steward") {
      writeStewardSessionPointer(butlerData, stored.projectId, stored.sessionId);
    }
    return stored;
  } finally {
    store.close();
  }
}

export function transitionRuntimeSession(input: TransitionRuntimeSessionInput): StoredSessionBinding | null {
  const butlerHome = getButlerHome(input.butlerHome);
  const butlerData = getButlerData(butlerHome, input.butlerData);
  const store = new SessionBindingStore(join(butlerData, "runtime", "session-store.sqlite"));
  try {
    const current = store.getBySessionId(input.sessionId);
    const updated = store.updateLifecycleState(input.sessionId, input.state);
    const role = input.role ?? updated?.role ?? current?.role;
    if (!role) return updated;

    recordSessionLifecycle({
      sessionId: input.sessionId,
      role,
      state: input.state,
      reason: input.reason ?? input.source ?? "runtime-transition",
      metadata: {
        source: input.source ?? "runtime-transition",
      },
    });

    const projectId = updated?.projectId ?? current?.projectId;
    if (role === "steward" && (input.state === "closed" || input.state === "crashed")) {
      removeStewardSessionPointer(butlerData, projectId, input.sessionId);
    }
    return updated;
  } finally {
    store.close();
  }
}
