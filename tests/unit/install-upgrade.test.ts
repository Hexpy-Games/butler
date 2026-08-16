import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createUpgradeReport,
  migrateConfigFile,
  renderUpgradeReport,
} from "../../packages/butler-agent/src/operations/install/upgrade.ts";

let tempDir = "";
const legacySessionField = `t${"mux"}Session`;

beforeEach(() => {
  tempDir = join(tmpdir(), `butler-install-upgrade-${Date.now()}-${Math.random()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("config migration removes legacy runtime fields and preserves private config", () => {
  const path = join(tempDir, "butler.config.json");
  writeFileSync(path, `${JSON.stringify({
    user: {
      name: "Example User",
    },
    system: {
      runtime: "old",
      [legacySessionField]: "legacy",
      obsoleteRuntime: true,
      legacyCli: "old-cli",
      defaultModel: "openai/auto:codex-latest",
      openaiModel: "auto:codex-latest",
    },
  }, null, 2)}\n`, "utf8");

  const migrated = migrateConfigFile(path);

  expect(migrated.changed).toBe(true);
  expect(migrated.removedFields).toEqual([
    `system.${legacySessionField}`,
    "system.obsoleteRuntime",
    "system.legacyCli",
  ]);
  expect(migrated.config).toMatchObject({
    user: {
      name: "Example User",
    },
    system: {
      runtime: "codex-api",
      defaultModel: "openai/gpt-5.5-codex",
      openaiModel: "gpt-5.5-codex",
    },
  });
});

test("upgrade report explains layout, migration, repair targets, and rollback", () => {
  mkdirSync(join(tempDir, "data"), { recursive: true });
  writeFileSync(join(tempDir, "data", "butler.config.json"), `${JSON.stringify({
    system: {
      [legacySessionField]: "old",
    },
  })}\n`, "utf8");

  const report = createUpgradeReport({
    version: "test-version",
    butlerHome: join(tempDir, "home"),
    butlerData: join(tempDir, "data"),
  });
  const rendered = renderUpgradeReport(report);

  expect(report.currentConfigExists).toBe(true);
  expect(report.migrationSteps.join("\n")).toContain(`system.${legacySessionField}`);
  expect(report.repairTargets).toEqual([
    "managed-runtime",
    "workspace-dependencies",
    "openai-auth",
    "native-services",
    "config",
  ]);
  expect(rendered).toContain("Butler upgrade report test-version");
  expect(rendered).toContain("Private data remains under BUTLER_DATA");
});
