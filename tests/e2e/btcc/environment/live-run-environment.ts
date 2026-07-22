import {
  copyFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadPrivateEnvIntoProcess } from "../../../../packages/butler-agent/src/interfaces/cli/private-env.ts";
import {
  readRegisteredHostedModelConfigs,
  resolveProviderCredentialSecret,
} from "../../../../packages/butler-agent/src/integrations/providers/shared/registered-models.ts";
import type { ModelCell } from "../contracts.ts";

export const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

export type LiveRunEnvironment = {
  runId: string;
  runRoot: string;
  sourceButlerData: string;
  sourceRevision: string;
  sourceTreeClean: boolean;
  restore(): void;
};

export function prepareLiveRunEnvironment(): LiveRunEnvironment {
  const previousButlerData = process.env.BUTLER_DATA;
  const previousButlerHome = process.env.BUTLER_HOME;
  const sourceButlerData = process.env.BTCC_LIVE_SOURCE_BUTLER_DATA?.trim() ||
    previousButlerData || join(homedir(), ".butler");
  loadPrivateEnvIntoProcess(sourceButlerData);
  const runId = process.env.BTCC_LIVE_RUN_ID?.trim() ||
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const outputBase = process.env.BTCC_LIVE_E2E_OUTPUT_ROOT?.trim() ||
    join(REPOSITORY_ROOT, ".tmp", "btcc-live-e2e");
  const runRoot = join(outputBase, runId);
  mkdirSync(runRoot, { recursive: true });
  process.env.BUTLER_HOME = REPOSITORY_ROOT;
  return {
    runId,
    runRoot,
    sourceButlerData,
    sourceRevision: gitRevision(),
    sourceTreeClean: gitTreeClean(),
    restore() {
      restoreEnv("BUTLER_DATA", previousButlerData);
      restoreEnv("BUTLER_HOME", previousButlerHome);
    },
  };
}

export function seedProviderConfiguration(source: string, target: string): void {
  copyIfPresent(join(source, "butler.config.json"), join(target, "butler.config.json"));
  copyIfPresent(
    join(source, "auth", "model-provider-credentials.json"),
    join(target, "auth", "model-provider-credentials.json"),
  );
  copyIfPresent(
    join(source, "auth", "openai-codex.json"),
    join(target, "auth", "openai-codex.json"),
  );
}

export function providerReadiness(cell: ModelCell, sourceButlerData: string): {
  ready: boolean;
  detail: string;
} {
  if (cell.provider === "openai") {
    const candidates = [
      Boolean(process.env.OPENAI_API_KEY?.trim()),
      existsSync(join(sourceButlerData, "auth", "openai-codex.json")),
      existsSync(process.env.CODEX_AUTH_JSON || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json")),
    ];
    return candidates.some(Boolean)
      ? { ready: true, detail: "OpenAI credential source is present" }
      : { ready: false, detail: "No OpenAI credential source is present" };
  }
  const registered = readRegisteredHostedModelConfigs(sourceButlerData)
    .find((candidate) => candidate.model_ref === "zai/glm-5.2");
  const hasCredential = registered?.auth_type === "api_key" && Boolean(
    resolveProviderCredentialSecret(registered.credential_id, "zai", sourceButlerData),
  );
  return registered && hasCredential
    ? { ready: true, detail: "Exact ZAI GLM registration resolves a credential" }
    : { ready: false, detail: "Exact ZAI GLM registration or credential is missing" };
}

function copyIfPresent(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function gitRevision(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Unable to read Butler source revision: ${result.stderr}`);
  return result.stdout.trim();
}

function gitTreeClean(): boolean {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Unable to inspect Butler source tree: ${result.stderr}`);
  return result.stdout.trim().length === 0;
}
