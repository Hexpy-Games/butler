import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import commandData from "../../packages/butler-agent/src/interfaces/cli/commands.json";
import { readRepoOrLedgerFile } from "../support/project-ledger-root.ts";

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("README normal workflows use the product CLI instead of internal scripts", () => {
  const readme = readRepoFile("README.md");

  for (const expected of [
    "butler install --home ~/butler --data ~/.butler",
    "butler commands",
    "butler status",
    "butler ps",
    "butler doctor --check delivery --verbose",
    "butler logs --service butler-main --lines 100",
    "butler context prune --json",
    "butler start",
    "butler stop",
    "butler restart",
    "REF-CLI-REFERENCE - Butler CLI Reference",
  ]) {
    expect(readme).toContain(expected);
  }

  for (const forbidden of [
    "packages/butler-agent/scripts/",
    "butler check",
    "butler release gate",
    "external process manager status",
    "external process manager restart all",
    "bash -n install.sh",
  ]) {
    expect(readme).not.toContain(forbidden);
  }
});

test("CLI reference lists every registry command with availability state", () => {
  const reference = readRepoOrLedgerFile(".project-ledger/references/cli-reference.md");
  const documentedCommands = [...reference.matchAll(/^- `([^`]+)`\s+-\s+(available|planned|deferred)\./gm)]
    .map((match) => ({
      usage: match[1],
      state: match[2],
    }));
  const documentedByUsage = new Map(documentedCommands.map((command) => [command.usage, command.state]));

  expect(reference).toContain("This reference mirrors `packages/butler-agent/src/interfaces/cli/commands.json`.");
  expect(documentedCommands).toHaveLength(commandData.length);
  for (const command of commandData) {
    expect(documentedByUsage.get(command.usage)).toBe(command.implemented ? "available" : command.status);
  }
});

test("CLI spec defines the user documentation gate", () => {
  const spec = readRepoOrLedgerFile(".project-ledger/specs/butler-cli.md");

  expect(spec).toContain("Product Documentation Contract");
  expect(spec).toContain("must link to a command reference");
  expect(spec).toContain("README must not advertise maintainer package scripts as user commands.");
  expect(spec).toContain("docs/cli-reference.md");
});
