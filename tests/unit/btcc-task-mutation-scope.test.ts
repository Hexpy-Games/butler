import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupProductionOperationsFixtures,
  createDirectoryFixture,
  createRuntime,
  provisionWorkspace,
  workspaceEnvelope,
  workspaceRequest,
} from "./support/btcc-production-operations-fixture.ts";

afterEach(cleanupProductionOperationsFixtures);

describe("BTCC Task mutation scope", () => {
  test("rejects a request outside accepted mutation paths before dispatch", async () => {
    const fixture = createDirectoryFixture();
    let dispatched = false;
    fixture.workspace = () => {
      dispatched = true;
      return { changed: false };
    };
    const runtime = createRuntime(fixture);
    const provision = await provisionWorkspace(runtime.artifacts, fixture.targetPath);
    const request = workspaceRequest(
      provision.workspace.ref, fixture.targetPath, "denied", "guide.md",
    );
    const result = await runtime.operations.perform({
      request,
      envelope: workspaceEnvelope(provision, {
        kind: "contained_paths", writablePaths: ["src/feature.ts"],
      }),
    });

    expect(result.outcome).toBe("operation_rejected");
    expect(result.content).toContain("task_mutation_target_denied");
    expect(dispatched).toBe(false);
  });

  test("rejects undeclared changes produced by an authorized command", async () => {
    const fixture = createDirectoryFixture();
    fixture.workspace = ({ workspacePath }) => {
      writeFileSync(join(workspacePath, "other.md"), "escaped delta\n");
      return { changed: "other.md" };
    };
    const runtime = createRuntime(fixture);
    const provision = await provisionWorkspace(runtime.artifacts, fixture.targetPath);
    const request = workspaceRequest(
      provision.workspace.ref, fixture.targetPath, "unused", "guide.md",
    );
    const result = await runtime.operations.perform({
      request,
      envelope: workspaceEnvelope(provision, {
        kind: "contained_paths", writablePaths: ["guide.md"],
      }),
    });

    expect(result.outcome).toBe("operation_rejected");
    expect(result.content).toContain("task_mutation_scope_escaped");
    expect(readFileSync(join(fixture.targetPath, "guide.md"), "utf8")).toBe(fixture.original);
  });

  test("rejects persistent deltas from read-only verification", async () => {
    const fixture = createDirectoryFixture();
    fixture.workspace = ({ workspacePath }) => {
      writeFileSync(join(workspacePath, "guide.md"), "forbidden verification delta\n");
      return { changed: "guide.md" };
    };
    const runtime = createRuntime(fixture);
    const provision = await provisionWorkspace(runtime.artifacts, fixture.targetPath);
    const request = workspaceRequest(provision.workspace.ref, fixture.targetPath, "unused", ".");
    const result = await runtime.operations.perform({
      request,
      envelope: workspaceEnvelope(provision, { kind: "read_only" }),
    });

    expect(result.outcome).toBe("operation_rejected");
    expect(result.content).toContain("read_only_task_mutated_workspace");
    expect(readFileSync(join(fixture.targetPath, "guide.md"), "utf8")).toBe(fixture.original);
  });
});
