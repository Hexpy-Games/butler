import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  CanonicalSpecSupersessionCycleError,
  normalizeSpecBody,
  resolveCanonicalSpecCatalog,
  resolveCanonicalSpecRevisions,
} from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/canonical-spec-resolver.ts";

describe("BTCC canonical Spec resolver", () => {
  test("loads only named current authority and hashes NFC LF bytes with one terminal newline", () => {
    const core = fakeCore([
      spec("SPEC-SELECTED", "Cafe\u0301\r\n\r\n", { parentId: "SPEC-PARENT" }),
      spec("SPEC-UNRELATED", "Do not inject me\n", { parentId: "SPEC-PARENT" }),
    ]);
    const [selected] = resolveCanonicalSpecRevisions(core as never, "/ledger", ["SPEC-SELECTED"]);
    const normalized = "Café\n";

    expect(selected.body).toBe(normalized);
    expect(selected.revisionRef).toEqual({
      id: "SPEC-SELECTED",
      sha256: createHash("sha256").update(normalized).digest("hex"),
    });
    expect(normalizeSpecBody("A\rB\r\n\n")).toBe("A\nB\n");
  });

  test("roots legacy v1 Specs at the owning project and rejects ambiguous current revisions", () => {
    const [legacy] = resolveCanonicalSpecRevisions(
      fakeCore([spec("SPEC-NO-PARENT", "body", {})]) as never,
      "/ledger",
      ["SPEC-NO-PARENT"],
    );
    expect(legacy).toMatchObject({
      parentId: "fixture-project",
      concernId: "SPEC-NO-PARENT",
    });

    const ambiguous = fakeCore([
      spec("SPEC-PHYSICAL-A", "A", { logicalId: "SPEC-LOGICAL", parentId: "PARENT" }),
      spec("SPEC-PHYSICAL-B", "B", { logicalId: "SPEC-LOGICAL", parentId: "PARENT" }),
    ]);
    expect(() => resolveCanonicalSpecRevisions(
      ambiguous as never,
      "/ledger",
      ["SPEC-LOGICAL"],
    )).toThrow("exactly one current revision");
  });

  test("rejects two selected Specs claiming the same concern", () => {
    const core = fakeCore([
      spec("SPEC-A", "A", { parentId: "PARENT", concernId: "shared-concern" }),
      spec("SPEC-B", "B", { parentId: "PARENT", concernId: "shared-concern" }),
    ]);
    expect(() => resolveCanonicalSpecRevisions(
      core as never,
      "/ledger",
      ["SPEC-A", "SPEC-B"],
    )).toThrow("competing current authority");
  });

  test("isolates an unrelated malformed Spec from a valid requested authority", () => {
    const core = fakeCore([
      spec("SPEC-VALID", "valid", { parentId: "PARENT" }),
      spec("SPEC-BROKEN", null, {}),
    ]);
    expect(resolveCanonicalSpecRevisions(core as never, "/ledger", ["SPEC-VALID"]))
      .toHaveLength(1);
  });

  test("rejects missing and foreign supersession targets in the requested chain", () => {
    const missing = fakeCore([
      spec("SPEC-REV-2", "new", {
        logicalId: "SPEC-L", parentId: "PARENT", supersedesId: "SPEC-MISSING",
      }),
    ]);
    expect(() => resolveCanonicalSpecRevisions(missing as never, "/ledger", ["SPEC-L"]))
      .toThrow("supersedes missing revision");

    const foreign = fakeCore([
      spec("SPEC-A", "A", {
        logicalId: "SPEC-L", parentId: "PARENT", supersedesId: "SPEC-FOREIGN",
      }),
      spec("SPEC-FOREIGN", "B", { logicalId: "SPEC-X", parentId: "PARENT" }),
    ]);
    expect(() => resolveCanonicalSpecRevisions(foreign as never, "/ledger", ["SPEC-L"]))
      .toThrow("supersedes foreign logical authority");
  });

  test("rejects a cycle in the requested supersession graph", () => {
    const core = fakeCore([
      spec("SPEC-A", "A", {
        logicalId: "SPEC-L", parentId: "PARENT", supersedesId: "SPEC-B",
      }),
      spec("SPEC-B", "B", {
        logicalId: "SPEC-L", parentId: "PARENT", supersedesId: "SPEC-A",
      }),
    ]);
    expect(() => resolveCanonicalSpecRevisions(core as never, "/ledger", ["SPEC-L"]))
      .toThrow(CanonicalSpecSupersessionCycleError);
  });

  test("rejects revisions that are not connected by explicit supersession", () => {
    const core = fakeCore([
      { ...spec("SPEC-OLD", "old", {
        logicalId: "SPEC-L", parentId: "PARENT",
      }), status: "superseded" },
      spec("SPEC-CURRENT", "current", {
        logicalId: "SPEC-L", parentId: "PARENT",
      }),
    ]);

    expect(() => resolveCanonicalSpecRevisions(core as never, "/ledger", ["SPEC-L"]))
      .toThrow("revision lineage is disconnected");
  });

  test("rejects an unrequested active Spec competing for the requested concern", () => {
    const core = fakeCore([
      spec("SPEC-REQUESTED", "A", { parentId: "PARENT", concernId: "shared" }),
      spec("SPEC-COMPETITOR", "B", { parentId: "PARENT", concernId: "shared" }),
    ]);
    expect(() => resolveCanonicalSpecRevisions(
      core as never, "/ledger", ["SPEC-REQUESTED"],
    )).toThrow("competing current authority");
  });

  test("catalogs every current Spec authority before Planning", () => {
    const catalog = resolveCanonicalSpecCatalog(fakeCore([
      spec("SPEC-B", "B", { parentId: "PARENT" }),
      spec("SPEC-A", "A", { parentId: "PARENT" }),
    ]) as never, "/ledger");

    expect(catalog.map((item) => item.logicalId)).toEqual(["SPEC-A", "SPEC-B"]);
    expect(catalog.map((item) => item.body)).toEqual(["A\n", "B\n"]);
  });

  test("excludes inactive logical authorities from the Planning catalog", () => {
    const cancelled = {
      ...spec("SPEC-CANCELLED", null, { parentId: "PARENT" }),
      status: "cancelled",
    };
    const catalog = resolveCanonicalSpecCatalog(fakeCore([
      spec("SPEC-CURRENT", "current", { parentId: "PARENT" }),
      cancelled,
    ]) as never, "/ledger");

    expect(catalog.map((item) => item.logicalId)).toEqual(["SPEC-CURRENT"]);
    expect(() => resolveCanonicalSpecRevisions(
      fakeCore([cancelled]) as never,
      "/ledger",
      ["SPEC-CANCELLED"],
    )).toThrow("exactly one current revision");
  });
});

type FakeSpec = {
  id: string;
  title: string;
  status: string;
  body: string | null;
  data: Record<string, unknown>;
};

function spec(
  id: string,
  body: string | null,
  data: Record<string, unknown>,
): FakeSpec {
  return { id, title: id, status: "specified", body, data: { id, ...data } };
}

function fakeCore(specs: FakeSpec[]) {
  const byId = new Map(specs.map((item) => [item.id, item]));
  return {
    buildIndex: () => ({
      records: [{
        id: "fixture-project",
        kind: "project",
        title: "Fixture project",
        status: "active",
      }, ...specs.map((item) => ({
        id: item.id,
        kind: "spec",
        title: item.title,
        status: item.status,
      }))],
    }),
    resolveRecord: (_root: string, input: { id: string }) => {
      if (!byId.has(input.id)) throw new Error("missing");
      return { filePath: input.id, record: { id: input.id, kind: "spec" } };
    },
    readRecordBody: (path: string) => byId.get(path)?.body ?? null,
    readRecordData: (path: string) => byId.get(path)?.data ?? null,
  };
}
