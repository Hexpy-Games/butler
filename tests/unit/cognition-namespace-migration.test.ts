import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyCognitionNamespaceMigration,
  buildCognitionNamespaceMigrationPlan,
} from "../../packages/butler-agent/src/agent/cognition/migration.ts";

const root = process.cwd();
const cli = join(root, "bin", "butler.js");

function tempRoot(): string {
  const dir = join(tmpdir(), `butler-cognition-migration-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runCli(args: string[], butlerData: string) {
  return Bun.spawnSync(["node", cli, ...args, "--data", butlerData], {
    cwd: root,
    env: {
      ...process.env,
      BUTLER_DATA: butlerData,
      BUTLER_HOME: root,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function stdoutText(result: ReturnType<typeof runCli>): string {
  return new TextDecoder().decode(result.stdout);
}

test("cognition namespace migration moves legacy memory with backup and manifest", () => {
  const butlerData = tempRoot();
  try {
    const legacyRoot = join(butlerData, "memory");
    mkdirSync(join(legacyRoot, "hot"), { recursive: true });
    writeFileSync(join(legacyRoot, "hot", "cache.md"), "cached context\n", "utf8");

    const plan = buildCognitionNamespaceMigrationPlan(butlerData);
    expect(plan.status).toBe("ready");
    expect(plan.legacy_file_count).toBe(1);

    const manifest = applyCognitionNamespaceMigration(butlerData);
    expect(manifest.status).toBe("applied");
    expect(manifest.moved_paths).toHaveLength(1);
    expect(existsSync(join(butlerData, "memory"))).toBe(false);
    expect(readFileSync(join(butlerData, "cognition", "memory", "hot", "cache.md"), "utf8")).toContain("cached context");
    expect(manifest.backup_root ? existsSync(join(manifest.backup_root, "hot", "cache.md")) : false).toBe(true);
    expect(existsSync(join(butlerData, "cognition", "migration", "namespace-v1.json"))).toBe(true);

    const after = buildCognitionNamespaceMigrationPlan(butlerData);
    expect(after.status).toBe("applied");
    expect(after.legacy_exists).toBe(false);
    expect(after.cognition_memory_file_count).toBe(1);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("cognition namespace migration refuses divergent legacy and cognition roots", () => {
  const butlerData = tempRoot();
  try {
    mkdirSync(join(butlerData, "memory"), { recursive: true });
    writeFileSync(join(butlerData, "memory", "legacy.md"), "legacy\n", "utf8");
    mkdirSync(join(butlerData, "cognition", "memory"), { recursive: true });
    writeFileSync(join(butlerData, "cognition", "memory", "new.md"), "new\n", "utf8");

    const plan = buildCognitionNamespaceMigrationPlan(butlerData);
    expect(plan.status).toBe("conflict");
    expect(plan.conflicts[0]).toContain("both contain active data");

    const manifest = applyCognitionNamespaceMigration(butlerData);
    expect(manifest.status).toBe("conflict");
    expect(existsSync(join(butlerData, "memory", "legacy.md"))).toBe(true);
    expect(existsSync(join(butlerData, "cognition", "memory", "new.md"))).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("legacy butler memory command fails instead of aliasing", () => {
  const butlerData = tempRoot();
  try {
    const result = runCli(["memory", "status", "--json"], butlerData);
    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(stdoutText(result));
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("unknown_command");
    expect(parsed.error.message).toBe("unknown Butler command: memory status");
    expect(parsed.error.message).not.toMatch(/cognition|migrat|removed|deprecat|use/i);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
