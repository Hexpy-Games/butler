import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { prepareBundledAgentResource } from
  "../../../packages/butler-app/scripts/release/package-app-release.ts";
import { sessionHintForRow } from
  "../../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";
import { SessionBindingStore } from
  "../../../packages/butler-agent/src/test-support/harness/session-store.ts";
import type {
  AccessMode,
  AgentOwnership,
  ElectronFixtureFile,
  ElectronHarnessOptions,
  ElectronScenario,
  PreparedRun,
  ReasoningEffort,
} from "./contracts.ts";
import {
  assert,
  isInside,
  isRecord,
  parseJsonFile,
  resolveFixturePath,
  safeSegment,
} from "./scenario-preflight.ts";

const R3_GUIDED_TURN_STATE = join(
  "packages",
  "butler-agent",
  "src",
  "agent",
  "adapters",
  "btcc",
  "sqlite",
  "guided-turn-state.ts",
);

export function productAgentOwnership(repoRoot: string): AgentOwnership {
  return existsSync(join(resolve(repoRoot), R3_GUIDED_TURN_STATE))
    ? "electron"
    : "harness";
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

const FIXTURE_PROVIDER_CREDENTIAL_ID = "btcc-r3-fixture-provider";
const FIXTURE_PROVIDER_SECRET = "fixture-local-provider-key";

function fixtureModelRefs(
  run: Pick<PreparedRun, "model">,
  modelFallback?: ElectronScenario["modelFallback"],
): string[] {
  return [run.model, ...(modelFallback?.models ?? [])];
}

function ensureFixtureProviderModels(
  config: Record<string, unknown>,
  modelRefs: readonly string[],
): void {
  const models = isRecord(config.models) ? config.models : {};
  const registered = Array.isArray(models.registered) ? models.registered : [];
  const fixtureRefs = new Set(modelRefs);
  const normalizedRegistered = registered.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.model_ref !== "string" ||
        !fixtureRefs.has(candidate.model_ref)) return candidate;
    return {
      ...candidate,
      auth_type: "api_key",
      credential_id: FIXTURE_PROVIDER_CREDENTIAL_ID,
    };
  });
  const existingRefs = new Set(
    normalizedRegistered.flatMap((candidate) =>
      isRecord(candidate) && typeof candidate.model_ref === "string"
        ? [candidate.model_ref]
        : [],
    ),
  );
  const additions = modelRefs.flatMap((modelRef) => {
    if (existingRefs.has(modelRef)) return [];
    const separator = modelRef.indexOf("/");
    if (separator <= 0 || separator === modelRef.length - 1) return [];
    const providerId = modelRef.slice(0, separator);
    const modelId = modelRef.slice(separator + 1);
    return [{
      provider_id: providerId,
      model_id: modelId,
      model_ref: modelRef,
      display_name: modelId,
      auth_type: "api_key",
      credential_id: FIXTURE_PROVIDER_CREDENTIAL_ID,
    }];
  });
  config.models = {
    ...models,
    registered: [...normalizedRegistered, ...additions],
  };
}

function writeFixtureProviderCredential(dataRoot: string): void {
  writeJson(join(dataRoot, "auth", "model-provider-credentials.json"), {
    credentials: [{
      id: FIXTURE_PROVIDER_CREDENTIAL_ID,
      provider_id: "openai",
      auth_type: "api_key",
      label: "BTCC R3 deterministic fixture",
      secret: FIXTURE_PROVIDER_SECRET,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }],
  });
}

function readSourceAppSettings(sourceData: string): Partial<{
  accessMode: AccessMode;
  model: string;
  reasoningEffort: ReasoningEffort;
}> {
  const candidates = [
    join(sourceData, "app-server", "butler-client.sqlite"),
    join(sourceData, "butler-client.sqlite"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const db = new Database(path, { readonly: true });
    try {
      const row = db
        .query<{ value_json: string }, [string]>(
          "SELECT value_json FROM app_settings WHERE key = ? LIMIT 1",
        )
        .get("settings");
      if (!row) continue;
      const parsed = JSON.parse(row.value_json) as unknown;
      if (!isRecord(parsed)) continue;
      const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
      const reasoning = typeof parsed.reasoning_effort === "string"
        ? parsed.reasoning_effort
        : "";
      const access = typeof parsed.access_mode === "string" ? parsed.access_mode : "";
      return {
        ...(model.includes("/") ? { model } : {}),
        ...(["none", "low", "medium", "high", "xhigh", "max"].includes(reasoning)
          ? { reasoningEffort: reasoning as ReasoningEffort }
          : {}),
        ...(["ask_first", "full_access", "read_only"].includes(access)
          ? { accessMode: access as AccessMode }
          : {}),
      };
    } catch {
      // Older source data may not contain the current App settings schema.
    } finally {
      db.close();
    }
  }
  return {};
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local port.")));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

function copyCredentialIfPresent(sourceData: string, dataRoot: string, name: string): void {
  const source = join(sourceData, "auth", name);
  if (!existsSync(source)) return;
  const destination = join(dataRoot, "auth", name);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
}

function copyUserContextIfPresent(
  sourceData: string,
  dataRoot: string,
  relativePath: string,
): void {
  const source = join(sourceData, relativePath);
  if (!existsSync(source)) return;
  const destination = join(dataRoot, relativePath);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
}

function assertRelevantCredentialAvailable(
  sourceData: string,
  selectedModel: string,
  config: Record<string, unknown>,
): void {
  const [provider] = selectedModel.split("/", 1);
  const models = isRecord(config.models) ? config.models : {};
  const registered = Array.isArray(models.registered) ? models.registered : [];
  const entry = registered.find((candidate) =>
    isRecord(candidate) && candidate.model_ref === selectedModel,
  );
  assert(entry || provider === "local", `Selected model is not registered: ${selectedModel}`);
  if (!isRecord(entry)) return;
  if (entry.auth_type === "codex_oauth") {
    assert(
      existsSync(join(sourceData, "auth", "openai-codex.json")),
      "Selected OAuth model has no source auth profile.",
    );
  }
  if (entry.auth_type === "api_key") {
    assert(
      existsSync(join(sourceData, "auth", "model-provider-credentials.json")),
      "Selected API-key model has no source credential store.",
    );
  }
}

function prepareConfig(
  sourceConfig: Record<string, unknown>,
  run: Pick<PreparedRun, "dataRoot" | "model" | "reasoningEffort" | "repoRoot" | "runId" | "workspaceRoot">,
  modelFallback?: ElectronScenario["modelFallback"],
  providerFixture?: ElectronScenario["providerFixture"],
): void {
  const config = structuredClone(sourceConfig);
  if (providerFixture) {
    ensureFixtureProviderModels(config, fixtureModelRefs(run, modelFallback));
  }
  const system = isRecord(config.system) ? config.system : {};
  config.system = {
    ...system,
    butlerData: run.dataRoot,
    butlerHome: run.repoRoot,
    butlerModel: run.model,
    defaultModel: run.model,
    devRoot: run.workspaceRoot,
    openaiModel: run.model.split("/").slice(1).join("/"),
    openaiPromptCacheKeyPrefix: `btcc-r3-e2e-${run.runId}`,
    openaiReasoningEffort: run.reasoningEffort,
  };
  if (modelFallback) {
    config.user = {
      ...(isRecord(config.user) ? config.user : {}),
      modelFallback: {
        enabled: modelFallback.enabled,
        models: [...modelFallback.models],
      },
    };
  }
  config.projects = [];
  config.project = {
    ...(isRecord(config.project) ? config.project : {}),
    discoveryRoots: [run.workspaceRoot],
  };
  if (isRecord(config.memory)) {
    const sleepCycle = isRecord(config.memory.sleepCycle) ? config.memory.sleepCycle : {};
    config.memory = {
      ...config.memory,
      sleepCycle: { ...sleepCycle, enabled: false },
    };
  }
  writeJson(join(run.dataRoot, "butler.config.json"), config);
}

function writeFixtures(
  workspaceRoot: string,
  fixtures: readonly ElectronFixtureFile[],
): void {
  for (const fixture of fixtures) {
    assert(typeof fixture.text === "string", `Fixture ${fixture.path} text is invalid.`);
    const path = resolveFixturePath(workspaceRoot, fixture.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, fixture.text, "utf8");
  }
}

function initializeIsolatedProjectRepository(workspaceRoot: string): void {
  if (existsSync(join(workspaceRoot, ".git"))) return;
  execFileSync("git", ["init", "--quiet"], { cwd: workspaceRoot });
  execFileSync("git", ["config", "user.name", "Butler E2E"], {
    cwd: workspaceRoot,
  });
  execFileSync("git", ["config", "user.email", "butler-e2e@localhost"], {
    cwd: workspaceRoot,
  });
  execFileSync("git", ["add", "--all"], { cwd: workspaceRoot });
  execFileSync(
    "git",
    ["commit", "--quiet", "--allow-empty", "-m", "Initialize isolated project"],
    { cwd: workspaceRoot },
  );
}

function bindPreparedSession(run: PreparedRun): void {
  const bindingStore = new SessionBindingStore(
    join(run.dataRoot, "runtime", "session-store.sqlite"),
  );
  try {
    bindingStore.upsert({
      sessionId: sessionHintForRow(run.sessionId),
      role: "butler",
      ...(run.projectId ? { projectId: run.projectId } : {}),
      workspacePath: run.workspaceRoot,
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId: run.model.split("/", 1)[0] || "openai",
      modelRef: run.model as `${string}/${string}`,
      transportBindings: [],
      metadata: {
        source: "btcc-r3-electron-e2e-fixture",
      },
    });
  } finally {
    bindingStore.close();
  }
}

export function activateProjectSessionWorkspace(
  run: PreparedRun,
  projectId: string,
  fixtures: readonly ElectronFixtureFile[],
): void {
  assert(run.sessionKind === "project", "Only project sessions can adopt a project.");
  const appDbPath = join(run.dataRoot, "app-server", "butler-client.sqlite");
  assert(existsSync(appDbPath), "Electron App database is missing after project creation.");
  const db = new Database(appDbPath, { readonly: true });
  let workspacePath: string | null;
  try {
    workspacePath = db
      .query<{ workspace_path: string }, [string]>(`
        SELECT workspace_path
        FROM projects
        WHERE id = ? AND archived = 0
        LIMIT 1
      `)
      .get(projectId)?.workspace_path ?? null;
  } finally {
    db.close();
  }
  assert(workspacePath, "Electron App did not persist the created project.");
  const resolvedWorkspace = resolve(workspacePath);
  assert(
    isInside(run.projectWorkspaceRoot, resolvedWorkspace),
    "Electron App scratch project escaped the isolated project workspace root.",
  );
  assert(
    existsSync(resolvedWorkspace) && statSync(resolvedWorkspace).isDirectory(),
    "Electron App scratch project workspace is unavailable.",
  );
  run.projectId = projectId;
  run.workspaceRoot = resolvedWorkspace;
  writeFixtures(resolvedWorkspace, fixtures);
  initializeIsolatedProjectRepository(resolvedWorkspace);
}

export async function prepareElectronRun(
  scenario: ElectronScenario,
  options: ElectronHarnessOptions,
): Promise<PreparedRun> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const sourceData = resolve(
    options.sourceData ?? process.env.BUTLER_E2E_SOURCE_DATA ?? join(homedir(), ".butler"),
  );
  const runId = `${safeSegment(scenario.id, "scenario")}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runRoot = resolve(
    options.runRoot ?? join(tmpdir(), "butler-btcc-r3-electron", runId),
  );
  assert(!existsSync(runRoot), `Run root already exists; use a fresh path: ${runRoot}`);
  assert(!isInside(sourceData, runRoot), "Run root must not be inside source Butler data.");
  assert(!isInside(runRoot, sourceData), "Run root must not contain source Butler data.");
  assert(runRoot !== repoRoot, "Run root must not be the source repository.");
  const dataRoot = join(runRoot, "data");
  const electronProfile = join(runRoot, "electron-profile");
  const projectWorkspaceRoot = join(dataRoot, "project-workspaces");
  const sessionKind = scenario.session?.kind ?? "chat";
  const workspaceRoot = sessionKind === "project"
    ? projectWorkspaceRoot
    : join(runRoot, "workspace");
  const evidencePath = join(runRoot, "evidence.json");
  const debugPort = await freePort();
  const serverPort = await freePort();
  assert(debugPort !== serverPort, "Electron debug and App server ports must differ.");

  const sourceConfigPath = join(sourceData, "butler.config.json");
  assert(existsSync(sourceConfigPath), `Source Butler config is missing: ${sourceConfigPath}`);
  const sourceConfig = parseJsonFile(sourceConfigPath);
  assert(isRecord(sourceConfig), "Source Butler config is invalid.");
  const sourceAppSettings = readSourceAppSettings(sourceData);
  const sourceSystem = isRecord(sourceConfig.system) ? sourceConfig.system : {};
  const model = (options.model ?? scenario.model)?.trim() ||
    sourceAppSettings.model ||
    String(sourceSystem.butlerModel ?? sourceSystem.defaultModel ?? "").trim();
  assert(model.includes("/"), "A provider-qualified model is required.");
  if (!scenario.providerFixture) {
    assertRelevantCredentialAvailable(sourceData, model, sourceConfig);
    for (const fallbackModel of scenario.modelFallback?.models ?? []) {
      assertRelevantCredentialAvailable(sourceData, fallbackModel, sourceConfig);
    }
  }
  const reasoningEffort = (options.reasoningEffort ?? scenario.reasoningEffort ??
    sourceAppSettings.reasoningEffort ??
    sourceSystem.openaiReasoningEffort ?? "low") as ReasoningEffort;
  assert(
    ["none", "low", "medium", "high", "xhigh", "max"].includes(reasoningEffort),
    `Unsupported reasoning effort: ${reasoningEffort}`,
  );
  const accessMode = options.accessMode ?? scenario.accessMode ??
    sourceAppSettings.accessMode ?? "full_access";
  const agentOwnership = productAgentOwnership(repoRoot);
  const providedBundledAgentResourceDir = options.bundledAgentResourceDir?.trim()
    ? resolve(options.bundledAgentResourceDir)
    : null;
  const sessionSuffix = safeSegment(scenario.session?.id ?? scenario.id, "r3-e2e");
  const sessionId = `chat-btcc-r3-e2e-${sessionSuffix}`;
  const run: PreparedRun = {
    accessMode,
    agentOwnership,
    bundledAgentResourceDir: agentOwnership === "electron"
      ? providedBundledAgentResourceDir
      : null,
    dataRoot,
    debugPort,
    electronProfile,
    evidencePath,
    interruptedExecutorReplacementUsed: false,
    model,
    modelApiRetryAttempts: scenario.providerFixture?.retryAttempts,
    providerFixtureEnabled: Boolean(scenario.providerFixture),
    projectDisplayName: sessionKind === "project"
      ? scenario.session?.projectDisplayName?.trim() ||
        `BTCC R3 E2E ${scenario.id}`
      : null,
    projectId: null,
    projectWorkspaceRoot,
    reasoningEffort,
    repoRoot,
    runId,
    runRoot,
    serverPort,
    sessionId,
    sessionKind,
    sessionTitle: scenario.session?.title?.trim() || `BTCC R3 E2E ${scenario.id}`,
    sourceData,
    workspaceRoot,
  };
  if (options.dryRun) return run;

  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  mkdirSync(electronProfile, { recursive: true, mode: 0o700 });
  if (sessionKind === "chat") mkdirSync(workspaceRoot, { recursive: true });
  prepareConfig(sourceConfig, run, scenario.modelFallback, scenario.providerFixture);
  if (scenario.providerFixture) {
    writeFixtureProviderCredential(dataRoot);
  } else {
    copyCredentialIfPresent(sourceData, dataRoot, "model-provider-credentials.json");
    copyCredentialIfPresent(sourceData, dataRoot, "openai-codex.json");
  }
  copyUserContextIfPresent(sourceData, dataRoot, join("personas", "active.md"));
  copyUserContextIfPresent(
    sourceData,
    dataRoot,
    join("personalization", "profile.json"),
  );
  if (agentOwnership === "electron") {
    if (providedBundledAgentResourceDir) {
      assert(
        existsSync(providedBundledAgentResourceDir) &&
          statSync(providedBundledAgentResourceDir).isDirectory(),
        `Prepared bundled Agent resource is unavailable: ${providedBundledAgentResourceDir}`,
      );
    } else {
      run.bundledAgentResourceDir = prepareBundledAgentResource(
        repoRoot,
        join(runRoot, "bundled-agent-resource"),
      ).resourceDir;
    }
  }
  if (sessionKind === "chat") {
    writeFixtures(workspaceRoot, scenario.fixtures ?? []);
    bindPreparedSession(run);
  }
  return run;
}

export function bindingWorkspace(run: PreparedRun): string | null {
  const store = new SessionBindingStore(join(run.dataRoot, "runtime", "session-store.sqlite"));
  try {
    return store.getBySessionId(sessionHintForRow(run.sessionId))?.workspacePath ?? null;
  } finally {
    store.close();
  }
}
