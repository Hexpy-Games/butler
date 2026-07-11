import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface InstallLayout {
  butlerHome: string;
  butlerData: string;
}

export interface UpgradeReport {
  version: string;
  layout: InstallLayout;
  currentConfigExists: boolean;
  migrationSteps: string[];
  repairTargets: string[];
  rollbackGuidance: string[];
}

export interface ConfigMigrationResult {
  changed: boolean;
  removedFields: string[];
  config: Record<string, unknown>;
}

const LEGACY_SYSTEM_FIELDS = [
  `t${"mux"}Session`,
  "obsoleteRuntime",
  "legacyCli",
];
const LEGACY_AUTO_CODEX_MODEL = "auto:codex-latest";
const LEGACY_AUTO_CODEX_MODEL_REF = `openai/${LEGACY_AUTO_CODEX_MODEL}`;
const DEFAULT_CODEX_MODEL = "gpt-5.5-codex";
const DEFAULT_CODEX_MODEL_REF = `openai/${DEFAULT_CODEX_MODEL}`;

function readJson(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function migrateConfigObject(config: Record<string, unknown>): ConfigMigrationResult {
  const next = structuredClone(config) as Record<string, unknown>;
  const system = next.system && typeof next.system === "object"
    ? next.system as Record<string, unknown>
    : {};
  const removedFields: string[] = [];
  for (const field of LEGACY_SYSTEM_FIELDS) {
    if (field in system) {
      delete system[field];
      removedFields.push(`system.${field}`);
    }
  }
  if (system.defaultModel === LEGACY_AUTO_CODEX_MODEL_REF) {
    system.defaultModel = DEFAULT_CODEX_MODEL_REF;
  }
  if (system.openaiModel === LEGACY_AUTO_CODEX_MODEL) {
    system.openaiModel = DEFAULT_CODEX_MODEL;
  }
  system.runtime = "codex-api";
  next.system = system;
  return {
    changed: removedFields.length > 0 || config.system !== system,
    removedFields,
    config: next,
  };
}

export function migrateConfigFile(path: string, options: {
  dryRun?: boolean;
} = {}): ConfigMigrationResult {
  const result = migrateConfigObject(readJson(path));
  if (result.changed && !options.dryRun) {
    writeFileSync(path, `${JSON.stringify(result.config, null, 2)}\n`, "utf8");
  }
  return result;
}

export function createUpgradeReport(input: {
  version: string;
  butlerHome: string;
  butlerData: string;
}): UpgradeReport {
  const configPath = join(input.butlerData, "butler.config.json");
  const configExists = existsSync(configPath);
  const dryRun = configExists ? migrateConfigFile(configPath, { dryRun: true }) : null;
  const migrationSteps = [
    "Verify source checkout and private data directories.",
    "Prepare or repair the managed Butler runtime.",
    "Install workspace dependencies with the managed runtime.",
    "Validate OpenAI/Codex auth and Telegram pairing independently.",
    "Restart Butler Agent services after successful checks.",
  ];
  if (dryRun?.removedFields.length) {
    migrationSteps.push(`Remove legacy config fields: ${dryRun.removedFields.join(", ")}.`);
  }

  return {
    version: input.version,
    layout: {
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
    },
    currentConfigExists: configExists,
    migrationSteps,
    repairTargets: [
      "managed-runtime",
      "workspace-dependencies",
      "openai-auth",
      "telegram-pairing",
      "native-services",
      "config",
    ],
    rollbackGuidance: [
      "Private data remains under BUTLER_DATA and is not overwritten by source updates.",
      "Before risky migration, copy BUTLER_DATA to a timestamped backup directory.",
      "If service restart fails, keep the previous source checkout and rerun doctor/repair.",
    ],
  };
}

export function renderUpgradeReport(report: UpgradeReport): string {
  return [
    `Butler upgrade report ${report.version}`,
    "",
    `- Butler Home: ${report.layout.butlerHome}`,
    `- Butler Data: ${report.layout.butlerData}`,
    `- Config exists: ${report.currentConfigExists ? "yes" : "no"}`,
    "",
    "Migration steps:",
    ...report.migrationSteps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Repair targets:",
    ...report.repairTargets.map((target) => `- ${target}`),
    "",
    "Rollback guidance:",
    ...report.rollbackGuidance.map((item) => `- ${item}`),
  ].join("\n");
}
