import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const root = process.cwd();
const cliPath = join(root, "packages", "project-ledger", "bin", "project-ledger");

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runLedgerJson(args: string[]): any {
  const result = spawnSync(process.execPath, [cliPath, ...args, "--json"], {
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

test("install-skill can symlink the packaged Project Ledger skill into an external skill dir", () => {
  const target = tempDir("project-ledger-skill-");
  try {
    const result = runLedgerJson(["install-skill", "--target", target]);
    const destination = join(target, "project-ledger");

    expect(result.data.mode).toBe("symlink");
    expect(result.data.installed).toBe(true);
    expect(existsSync(join(destination, "SKILL.md"))).toBe(true);
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("install-skill copy mode creates a portable external copy", () => {
  const target = tempDir("project-ledger-skill-copy-");
  try {
    const result = runLedgerJson(["install-skill", "--target", target, "--mode", "copy"]);
    const destination = join(target, "project-ledger");

    expect(result.data.mode).toBe("copy");
    expect(result.data.installed).toBe(true);
    expect(existsSync(join(destination, "bin", "project-ledger"))).toBe(true);
    expect(lstatSync(destination).isSymbolicLink()).toBe(false);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
