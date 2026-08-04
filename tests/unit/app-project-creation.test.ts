import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { AppProjectFolderStore } from "../../packages/butler-agent/src/gateways/app/domain/projects/project-folder-store.ts";
import { AppProjectStore } from "../../packages/butler-agent/src/gateways/app/domain/projects/project-store.ts";

let tempDir = "";

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = "";
});

test("named scratch projects reject unsafe portable directory components", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-project-create-"));
  const workspaceRoot = join(tempDir, "workspace");
  const server = createTestAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    projectWorkspaceRoot: workspaceRoot,
    port: 0,
  });
  const unsafeNames = [
    "",
    "   ",
    "../outside",
    "nested/name",
    "nested\\name",
    "bad\u0001name",
    "bad<name>",
    ".",
    "..",
    "CON",
    "con.txt",
    "name.",
    "name ",
    "😀".repeat(81),
  ];
  try {
    for (const display_name of unsafeNames) {
      const response = await fetch(`${server.url}projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "scratch", display_name }),
      });
      expect(response.status).toBe(400);
    }
    expect(existsSync(workspaceRoot)).toBe(false);
  } finally {
    server.stop();
  }
});

test("database failure rolls back the exact empty scratch folder", () => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-project-rollback-"));
  const workspaceRoot = join(tempDir, "workspace");
  const folders = new AppProjectFolderStore(() => workspaceRoot);
  const failingDb = {
    query() {
      throw new Error("database unavailable");
    },
  } as unknown as Database;
  const projects = new AppProjectStore(
    failingDb,
    folders,
    undefined,
    () => [],
    () => undefined,
  );

  expect(() =>
    projects.createProject({ source: "scratch", display_name: "Rollback" }),
  ).toThrow("database unavailable");
  expect(existsSync(join(workspaceRoot, "Rollback"))).toBe(false);
});

test("database failure never removes a scratch folder that became non-empty", () => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-project-rollback-nonempty-"));
  const workspaceRoot = join(tempDir, "workspace");
  const folders = new AppProjectFolderStore(() => workspaceRoot);
  const failingDb = {
    query() {
      writeFileSync(
        join(workspaceRoot, "Rollback", "sentinel.txt"),
        "unexpected",
      );
      throw new Error("database unavailable");
    },
  } as unknown as Database;
  const projects = new AppProjectStore(
    failingDb,
    folders,
    undefined,
    () => [],
    () => undefined,
  );

  expect(() =>
    projects.createProject({ source: "scratch", display_name: "Rollback" }),
  ).toThrow("database unavailable");
  expect(
    readFileSync(join(workspaceRoot, "Rollback", "sentinel.txt"), "utf8"),
  ).toBe("unexpected");
});
