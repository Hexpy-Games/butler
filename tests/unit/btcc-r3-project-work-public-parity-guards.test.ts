import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

test("the production public path has one structural Project Work selector and one adapter constructor", () => {
  const composition = source(
    "packages/butler-agent/src/agent/composition/create-btcc-composition.ts",
  );
  const selector = source(
    "packages/butler-agent/src/agent/adapters/btcc/scope-selected-work-store.ts",
  );
  expect(composition).toContain("workSelection:");
  expect(selector).toContain("createProjectWorkStore");
  expect(matchesInProduct("export function createProjectWorkStore")).toEqual([
    "packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-work-store.ts",
  ]);
  expect(matchesInProduct("class ScopeSelectedWorkStore")).toEqual([
    "packages/butler-agent/src/agent/adapters/btcc/scope-selected-work-store.ts",
  ]);
});

test("App POST, native queue, binder, and dispatcher remain the singular production ingress chain", () => {
  const messages = source(
    "packages/butler-agent/src/gateways/app/domain/sessions/user-message-turn-contract.ts",
  );
  const queue = source("packages/butler-agent/src/gateways/core/inbound-queue.ts");
  const dispatcher = source(
    "packages/butler-agent/src/interfaces/gateway/btcc/btcc-inbound-dispatcher.ts",
  );
  expect(messages).toContain("enqueue");
  expect(queue).toContain("enqueueIdempotent");
  expect(dispatcher).toContain("bindQueuedInboundSession");
  expect(dispatcher).toContain("server.handleInbound(item.envelope)");
});

test("SQLite declares one legacy Session semantic schema while Project authority stays record-backed", () => {
  for (const table of [
    "btcc_guided_work_plan_revisions",
    "btcc_guided_work_checkpoint_revisions",
    "btcc_guided_work_review_revisions",
    "btcc_guided_work_disposition_revisions",
  ]) {
    expect(matchesInProduct(`CREATE TABLE IF NOT EXISTS ${table}`)).toEqual([
      "packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/guided-work-schema.ts",
    ]);
  }
  const projectSources = matchesInDirectory(
    "packages/butler-agent/src/agent/adapters/btcc/project-ledger",
    "INSERT INTO btcc_guided_work_plan_revisions",
  );
  expect(projectSources).toEqual([]);
});

test("dedicated parity tests contain no skip, todo, only, direct adapter construction, or manual envelope", () => {
  const files = lines(command([
    "rg",
    "--files",
    "tests/unit",
    "-g",
    "btcc-r3-project-work-public-parity*.ts",
  ]));
  expect(files.length).toBeGreaterThanOrEqual(5);
  const behavioralFiles = files.filter((path) => !path.endsWith("-guards.test.ts"));
  const combined = behavioralFiles.map((path) => source(path)).join("\n");
  expect(combined).not.toMatch(/\b(?:test|describe)\.(?:skip|todo|only)\b/u);
  expect(combined).not.toContain("createProjectWorkStore(");
  expect(combined).not.toContain("createDurableWorkService(");
  expect(combined).not.toContain("const envelope: InboundEnvelope");
  expect(combined).not.toContain("TaskMachine");
  expect(combined).not.toContain("AttemptMachine");
  expect(combined).not.toContain("R20");
});

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function matchesInProduct(pattern: string): string[] {
  return matchesInDirectory("packages/butler-agent/src", pattern);
}

function matchesInDirectory(directory: string, pattern: string): string[] {
  const output = command(["rg", "-l", "-F", pattern, directory], true);
  return lines(output).sort();
}

function command(args: string[], allowNoMatches = false): string {
  const result = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode === 0 || (allowNoMatches && result.exitCode === 1)) {
    return result.stdout.toString();
  }
  throw new Error(result.stderr.toString());
}

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}
