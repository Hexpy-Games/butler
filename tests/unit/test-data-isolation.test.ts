import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const fsUrl = pathToFileURL(join(process.cwd(), "packages", "project-ledger", "src", "fs.js")).href;

// test-category: security
test("the test process never resolves the owner's real home or data folder", async () => {
  const root = process.env.BUTLER_TEST_ROOT ?? "";
  expect(root.startsWith(realpathSync(tmpdir()))).toBe(true);
  for (const name of ["HOME", "BUTLER_DATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    expect(process.env[name]?.startsWith(root)).toBe(true);
  }
  expect(process.env.PROJECT_LEDGER_ROOT).toBeUndefined();

  const { ledgerRoot } = (await import(fsUrl)) as { ledgerRoot: (project: string) => string };
  const project = mkdtempSync(join(tmpdir(), "isolation-project-"));
  try {
    expect(ledgerRoot(project).startsWith(join(process.env.BUTLER_DATA ?? "", "project-ledger"))).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
