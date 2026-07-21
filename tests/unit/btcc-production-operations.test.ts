import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contentRef, type OperationRequest } from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import {
  cleanupProductionOperationsFixtures,
  createDirectoryFixture,
  createFaultableRuntime,
  createFixture,
  createRuntime,
  envelope,
  promotionRequest,
  provisionWorkspace,
  reviewRequest,
  workspaceRequest,
} from "./support/btcc-production-operations-fixture.ts";

afterEach(cleanupProductionOperationsFixtures);

describe("production BTCC artifact operations", () => {
  test("keeps the original unchanged through execution and Review", async () => {
    const fixture = createFixture();
    const runtime = createRuntime(fixture);
    const provision = await provisionWorkspace(runtime.artifacts, fixture.targetPath);
    const changed = "reviewed exact bytes\n";
    const action = workspaceRequest(provision.workspace.ref, fixture.targetPath, changed);
    const applied = await runtime.operations.perform({ request: action, envelope: envelope() });

    expect(readFileSync(fixture.targetPath, "utf8")).toBe(fixture.original);
    let reviewedBytes = "";
    fixture.validate = ({ workspacePath }) => {
      reviewedBytes = readFileSync(join(workspacePath, "target"), "utf8");
      return { valid: reviewedBytes === changed };
    };
    const reviewSourceRef = contentRef("workspace-revision", {
      targetSnapshotRef: applied.targetSnapshotRef,
    });
    const review = reviewRequest(reviewSourceRef);
    const reviewEnvelope = envelope({
      resultCandidate: {
        result: {
          workspaceRevision: { ref: reviewSourceRef, targetSnapshotRef: applied.targetSnapshotRef },
        },
      },
    });
    const validation = await runtime.operations.perform({ request: review, envelope: reviewEnvelope });

    expect(validation.outcome).toBe("review_validated");
    expect(reviewedBytes).toBe(changed);
    expect(readFileSync(fixture.targetPath, "utf8")).toBe(fixture.original);
  });

  test("promotes exactly the reviewed bytes only after immutable authorization", async () => {
    const fixture = createFixture();
    const runtime = createRuntime(fixture);
    const provision = await provisionWorkspace(runtime.artifacts, fixture.targetPath);
    const changed = "authorized reviewed bytes\n";
    const applied = await runtime.operations.perform({
      request: workspaceRequest(provision.workspace.ref, fixture.targetPath, changed),
      envelope: envelope(),
    });
    const promotion = promotionRequest(provision, applied.targetSnapshotRef!);
    const promoted = await runtime.operations.perform({
      request: promotion.request,
      envelope: promotion.envelope,
    });

    expect(promoted.outcome).toBe("promoted");
    expect(readFileSync(fixture.targetPath, "utf8")).toBe(changed);
    expect(promoted.promotionRecords?.promotedSnapshot.materializableSnapshotRef)
      .toEqual(applied.targetSnapshotRef);
  });

  test("atomically exchanges a complete directory target without partial copy", async () => {
    const fixture = createDirectoryFixture();
    const runtime = createRuntime(fixture);
    const provision = await provisionWorkspace(runtime.artifacts, fixture.targetPath);
    const changed = "complete directory candidate\n";
    const applied = await runtime.operations.perform({
      request: workspaceRequest(provision.workspace.ref, fixture.targetPath, changed, "guide.md"),
      envelope: envelope(),
    });
    const promotion = promotionRequest(provision, applied.targetSnapshotRef!);
    await runtime.operations.perform({ request: promotion.request, envelope: promotion.envelope });

    expect(readFileSync(join(fixture.targetPath, "guide.md"), "utf8")).toBe(changed);
  });

  test("rehydrates workspace and idempotent operation results after restart", async () => {
    const fixture = createFixture();
    const first = createRuntime(fixture);
    const firstProvision = await provisionWorkspace(first.artifacts, fixture.targetPath);
    const request = workspaceRequest(
      firstProvision.workspace.ref,
      fixture.targetPath,
      "restart-safe bytes\n",
    );
    const firstResult = await first.operations.perform({ request, envelope: envelope() });

    const restarted = createRuntime(fixture);
    const secondProvision = await provisionWorkspace(restarted.artifacts, fixture.targetPath);
    const replayed = await restarted.operations.perform({ request, envelope: envelope() });

    expect(secondProvision).toEqual(firstProvision);
    expect(replayed).toEqual(firstResult);
    expect(readFileSync(fixture.targetPath, "utf8")).toBe(fixture.original);
  });

  test("deduplicates real tool observation by request identity", async () => {
    const fixture = createFixture();
    let calls = 0;
    fixture.observe = ({ name, args }) => {
      calls += 1;
      return { name, args };
    };
    const request: Extract<OperationRequest, { kind: "observe" }> = {
      requestId: "observe-1",
      kind: "observe",
      capabilityRef: "web_search",
      scopeRef: "public-web",
      input: JSON.stringify({ query: "structured runtime" }),
    };
    const first = createRuntime(fixture);
    const observed = await first.operations.perform({ request, envelope: envelope() });
    const replayed = await createRuntime(fixture).operations.perform({ request, envelope: envelope() });

    expect(calls).toBe(1);
    expect(observed).toEqual(replayed);
  });

  test("delegates capabilityRef and parsed JSON to the real Butler tool executor", async () => {
    const fixture = createFixture();
    let received: unknown;
    fixture.observe = (call) => {
      received = call;
      return "observed";
    };
    const request: Extract<OperationRequest, { kind: "observe" }> = {
      requestId: "observe-delegation",
      kind: "observe",
      capabilityRef: "web_read",
      scopeRef: "public-web",
      input: "{\"url\":\"https://example.com\"}",
    };
    await createRuntime(fixture).operations.perform({ request, envelope: envelope() });

    expect(received).toMatchObject({
      name: "web_read",
      args: { url: "https://example.com" },
      rawArguments: request.input,
    });
  });

  test("delegates workspace changes to a real scoped Butler tool executor", async () => {
    const fixture = createFixture();
    let received: unknown;
    fixture.workspace = (call) => {
      received = call;
      writeFileSync(join(call.workspacePath, "target"), String(call.args.content));
      return { changed: true };
    };
    const runtime = createRuntime(fixture);
    const provision = await provisionWorkspace(runtime.artifacts, fixture.targetPath);
    const request = workspaceRequest(
      provision.workspace.ref,
      fixture.targetPath,
      "delegated bytes\n",
    );
    await runtime.operations.perform({ request, envelope: envelope() });

    expect(received).toMatchObject({
      name: "write_file",
      args: { content: "delegated bytes\n" },
      rawArguments: request.input,
    });
    expect(readFileSync(fixture.targetPath, "utf8")).toBe(fixture.original);
  });

  test("rejects workspace path escape before writing", async () => {
    const fixture = createDirectoryFixture();
    const runtime = createRuntime(fixture);
    const provision = await provisionWorkspace(runtime.artifacts, fixture.targetPath);
    const request = workspaceRequest(provision.workspace.ref, fixture.targetPath, "escape", "../escape.txt");

    await expect(runtime.operations.perform({ request, envelope: envelope() })).rejects.toThrow(
      "escapes its owned workspace",
    );
    expect(readFileSync(join(fixture.targetPath, "guide.md"), "utf8")).toBe(fixture.original);
  });

  test("honors abort before any tool dispatch or artifact mutation", async () => {
    const fixture = createFixture();
    const runtime = createRuntime(fixture);
    const provision = await provisionWorkspace(runtime.artifacts, fixture.targetPath);
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    const request = workspaceRequest(provision.workspace.ref, fixture.targetPath, "must not exist");

    await expect(runtime.operations.perform({
      request,
      envelope: envelope(),
      signal: controller.signal,
    })).rejects.toThrow("stopped");
    expect(readFileSync(fixture.targetPath, "utf8")).toBe(fixture.original);
  });

  for (const boundary of [
    "tool_mutated",
    "candidate_prepared",
    "workspace_exchanged",
    "before_result_persist",
  ] as const) {
    test(`recovers ${boundary} without invoking the workspace capability twice`, async () => {
      const fixture = createFixture();
      let toolCalls = 0;
      fixture.workspace = (call) => {
        toolCalls += 1;
        writeFileSync(join(call.workspacePath, "target"), String(call.args.content));
        return { changed: true };
      };
      let faulted = false;
      const interrupted = createFaultableRuntime(fixture, (observed) => {
        if (!faulted && observed === boundary) {
          faulted = true;
          throw new Error(`fault:${boundary}`);
        }
      });
      const provision = await provisionWorkspace(interrupted.artifacts, fixture.targetPath);
      const request = workspaceRequest(
        provision.workspace.ref,
        fixture.targetPath,
        `recovered ${boundary}\n`,
      );
      await expect(interrupted.operations.perform({ request, envelope: envelope() }))
        .rejects.toThrow(`fault:${boundary}`);

      const restarted = createRuntime(fixture);
      const recovered = await restarted.operations.perform({ request, envelope: envelope() });
      const promotion = promotionRequest(provision, recovered.targetSnapshotRef!);
      await restarted.operations.perform({
        request: promotion.request,
        envelope: promotion.envelope,
      });

      expect(toolCalls).toBe(1);
      expect(readFileSync(fixture.targetPath, "utf8")).toBe(`recovered ${boundary}\n`);
    });
  }
});
