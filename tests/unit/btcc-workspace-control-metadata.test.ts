import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupProductionOperationsFixtures,
  createDirectoryFixture,
  createFaultableRuntime,
  promotionRequest,
  provisionWorkspace,
  workspaceEnvelope,
  workspaceRequest,
} from "./support/btcc-production-operations-fixture.ts";

afterEach(cleanupProductionOperationsFixtures);

describe("BTCC workspace control metadata boundary", () => {
  test("preserves host control churn without rejecting the prepared payload", async () => {
    const fixture = createDirectoryFixture();
    mkdirSync(join(fixture.targetPath, ".git", "objects"), { recursive: true });
    writeFileSync(join(fixture.targetPath, ".git", "config"), "[core]\n\tbare = false\n");
    const runtime = createFaultableRuntime(fixture, (boundary) => {
      if (boundary !== "candidate_prepared") return;
      const gitRoot = join(fixture.targetPath, ".git");
      writeFileSync(join(gitRoot, "config"), "[core]\n\tbare = false\n\tignorecase = true\n");
      writeFileSync(join(gitRoot, "objects", "host-refresh"), "runtime-owned metadata\n");
    });
    const provision = await provisionWorkspace(runtime.artifacts, fixture.targetPath);
    const changed = "payload survives control churn\n";
    const applied = await runtime.operations.perform({
      request: workspaceRequest(provision.workspace.ref, fixture.targetPath, changed, "guide.md"),
      envelope: workspaceEnvelope(provision),
    });
    const promotion = promotionRequest(provision, applied.targetSnapshotRef!);
    await runtime.operations.perform({ request: promotion.request, envelope: promotion.envelope });

    expect(readFileSync(join(fixture.targetPath, "guide.md"), "utf8")).toBe(changed);
    expect(readFileSync(join(fixture.targetPath, ".git", "config"), "utf8"))
      .toContain("ignorecase = true");
  });

  test("still rejects payload drift after candidate preparation", async () => {
    const fixture = createDirectoryFixture();
    const runtime = createFaultableRuntime(fixture, (boundary) => {
      if (boundary !== "candidate_prepared") return;
      writeFileSync(
        join(programWorkspaceContentRoot(fixture.dataRoot), "unexpected.txt"),
        "outside the prepared candidate\n",
      );
    });
    const provision = await provisionWorkspace(runtime.artifacts, fixture.targetPath);

    await expect(runtime.operations.perform({
      request: workspaceRequest(
        provision.workspace.ref,
        fixture.targetPath,
        "declared change\n",
        "guide.md",
      ),
      envelope: workspaceEnvelope(provision),
    })).rejects.toThrow("Program workspace changed after its applied result");
    expect(readFileSync(join(fixture.targetPath, "guide.md"), "utf8"))
      .toBe(fixture.original);
  });
});

function programWorkspaceContentRoot(dataRoot: string): string {
  const workspacesRoot = join(dataRoot, "runtime", "btcc-artifacts", "workspaces");
  const [workspaceRoot] = readdirSync(workspacesRoot);
  return join(workspacesRoot, workspaceRoot, "content");
}
