import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  admitProjectLedgerEffectOccurrence,
  decodeProjectLedgerEffectOccurrence,
  ProjectLedgerEffectConflictError,
  ProjectLedgerEffectEvidenceUnsupportedError,
  type ProjectLedgerLogicalOperationKind,
} from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/external-effect-occurrence.ts";

const roots: string[] = [];
const moduleWorker = resolve("tests/fixtures/btcc-project-ledger-occurrence-admission-worker.ts");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("standalone admission replays the same logical content and types different content as conflict", () => {
  const fixture = admissionFixture("a");
  const first = admitProjectLedgerEffectOccurrence(fixture);
  const replay = admitProjectLedgerEffectOccurrence(fixture);
  expect(replay).toEqual(first);
  expect(first).not.toHaveProperty("requestSha256");
  expect(first).not.toHaveProperty("publicationId");
  expect(first.attempts).toHaveLength(1);
  expect(first.attempts[0]).toMatchObject({
    number: 1,
    status: "admitted",
    requestSha256: fixture.requestSha256,
  });

  expect(() => admitProjectLedgerEffectOccurrence({ ...fixture, requestSha256: hash("b") }))
    .toThrow(ProjectLedgerEffectConflictError);
  const files = readdirSync(join(fixture.butlerData, "runtime", "btcc-project-ledger-effects-v2", "occurrences"));
  expect(files).toHaveLength(1);
});

test("all governed logical operation kinds admit while unknown kinds fail closed", () => {
  const kinds: ProjectLedgerLogicalOperationKind[] = [
    "mutation_call",
    "binding_revision",
    "closeout_diagnostic",
    "abandonment",
    "legacy_import",
  ];
  for (const kind of kinds) {
    const fixture = admissionFixture(kind);
    const occurrence = admitProjectLedgerEffectOccurrence({
      ...fixture,
      operationIdentity: { kind, id: `operation-${kind}` },
    });
    expect(occurrence.operationIdentity.kind).toBe(kind);
    expect(decodeProjectLedgerEffectOccurrence(occurrence, {
      ...expectation(fixture),
      operationIdentity: occurrence.operationIdentity,
    })).toEqual(occurrence);
  }

  const fixture = admissionFixture("unknown-kind");
  expect(() => admitProjectLedgerEffectOccurrence({
    ...fixture,
    operationIdentity: { kind: "unknown", id: "operation-unknown" } as never,
  })).toThrow("project_ledger_occurrence_invalid");
});

test("occurrence codec rejects scope, identity, attempt, head, precondition, and receipt tampering", () => {
  const fixture = admissionFixture("strict");
  const occurrence = admitProjectLedgerEffectOccurrence(fixture);
  const expected = expectation(fixture);
  const tampered: unknown[] = [
    { ...occurrence, ledgerProjectId: "other" },
    { ...occurrence, ledgerRoot: join(fixture.ledgerRoot, "other") },
    { ...occurrence, operationIdentity: { ...occurrence.operationIdentity, id: "other" } },
    { ...occurrence, operationIdentity: { kind: "unknown", id: "mutation-1" } },
    { ...occurrence, attempts: [{ ...occurrence.attempts[0], requestSha256: hash("other") }] },
    { ...occurrence, attempts: [{ ...occurrence.attempts[0], publicationId: hash("publication-tamper") }] },
    { ...occurrence, attempts: [{ ...occurrence.attempts[0], number: 2 }] },
    { ...occurrence, attempts: [occurrence.attempts[0], occurrence.attempts[0]] },
    { ...occurrence, attempts: [{ ...occurrence.attempts[0], expectedBase: { ...occurrence.attempts[0]!.expectedBase, storageSha256: "bad" } }] },
    { ...occurrence, attempts: [{ ...occurrence.attempts[0], targetPreconditions: [fixture.targetPreconditions[0], fixture.targetPreconditions[0]] }] },
    { ...occurrence, attempts: [{ ...occurrence.attempts[0], targetPreconditions: [{ ...fixture.targetPreconditions[0], path: "../escape.md" }] }] },
    { ...occurrence, extra: true },
  ];
  for (const value of tampered) {
    expect(() => decodeProjectLedgerEffectOccurrence(value, expected)).toThrow();
  }
});

test("admission codec rejects observed and v1 evidence with typed fail-closed errors", () => {
  const fixture = admissionFixture("legacy");
  const v2 = admitProjectLedgerEffectOccurrence(fixture);
  const v1 = {
    schema: "butler.btcc-project-ledger-effect-occurrence.v1",
  };
  expect(() => decodeProjectLedgerEffectOccurrence(v1, expectation(fixture)))
    .toThrow(ProjectLedgerEffectEvidenceUnsupportedError);
  expect(() => decodeProjectLedgerEffectOccurrence({ ...v2, status: "observed" }, expectation(fixture)))
    .toThrow(ProjectLedgerEffectEvidenceUnsupportedError);
  expect(() => decodeProjectLedgerEffectOccurrence({
    ...v2,
    attempts: [{ ...v2.attempts[0], status: "observed" }],
  }, expectation(fixture))).toThrow(ProjectLedgerEffectEvidenceUnsupportedError);
});

test("admission load path types stored v1 and observed evidence before reading attempts", () => {
  const fixture = admissionFixture("stored-evidence");
  const admitted = admitProjectLedgerEffectOccurrence(fixture);
  const path = occurrenceFile(fixture.butlerData);

  writeFileSync(path, JSON.stringify({
    schema: "butler.btcc-project-ledger-effect-occurrence.v1",
    status: "pending",
  }));
  expect(() => admitProjectLedgerEffectOccurrence(fixture))
    .toThrow(ProjectLedgerEffectEvidenceUnsupportedError);

  writeFileSync(path, JSON.stringify({ ...admitted, status: "observed", attempts: undefined }));
  expect(() => admitProjectLedgerEffectOccurrence(fixture))
    .toThrow(ProjectLedgerEffectEvidenceUnsupportedError);
});

test("publication identity binds the numbered attempt request, base, and target preconditions", () => {
  const fixture = admissionFixture("binding");
  const occurrence = admitProjectLedgerEffectOccurrence(fixture);
  const attempt = occurrence.attempts[0]!;
  const changes = [
    { ...attempt, number: 2 },
    { ...attempt, requestSha256: hash("changed-request") },
    { ...attempt, expectedBase: head(fixture.ledgerRoot, "changed-base") },
    { ...attempt, targetPreconditions: [{ ...fixture.targetPreconditions[0], parentId: "W-2" }] },
  ];
  for (const changed of changes) {
    expect(() => decodeProjectLedgerEffectOccurrence({ ...occurrence, attempts: [changed] }, expectation(fixture)))
      .toThrow("project_ledger_occurrence_invalid");
  }
});

test("ledger scope is canonical real identity and rejects a symlink root", () => {
  const fixture = admissionFixture("scope");
  const occurrence = admitProjectLedgerEffectOccurrence(fixture);
  expect(occurrence.ledgerRoot).toBe(realpathSync(fixture.ledgerRoot));

  const linkedRoot = `${fixture.ledgerRoot}-link`;
  roots.push(linkedRoot);
  symlinkSync(fixture.ledgerRoot, linkedRoot, "dir");
  expect(() => admitProjectLedgerEffectOccurrence({ ...fixture, ledgerRoot: linkedRoot }))
    .toThrow("project_ledger_occurrence_invalid");
});

test("one logical key under a different canonical root has one file and a typed scope conflict", () => {
  const fixture = admissionFixture("root-conflict");
  admitProjectLedgerEffectOccurrence(fixture);
  const otherRoot = join(fixture.butlerData, "alternate", "ledger-project");
  createLedgerRoot(otherRoot);

  expect(() => admitProjectLedgerEffectOccurrence({
    ...fixture,
    ledgerRoot: otherRoot,
    expectedBase: head(otherRoot, "other-base"),
  })).toThrow(ProjectLedgerEffectConflictError);
  expect(readdirSync(join(
    fixture.butlerData,
    "runtime",
    "btcc-project-ledger-effects-v2",
    "occurrences",
  ))).toHaveLength(1);
});

test("barrier-coordinated Bun processes admit one content winner and one typed conflict", async () => {
  const fixture = admissionFixture("process-a");
  const root = fixture.butlerData;
  const start = join(root, "start");
  const inputs = [fixture, { ...fixture, requestSha256: hash("process-b") }];
  const children = inputs.map((input, index) => {
    const inputPath = join(root, `input-${index}.json`);
    const readyPath = join(root, `ready-${index}`);
    writeFileSync(inputPath, JSON.stringify(input));
    return Bun.spawn([process.execPath, "run", moduleWorker, inputPath, readyPath, start], { stdout: "pipe", stderr: "pipe" });
  });
  await waitUntil(() => inputs.every((_item, index) => existsSync(join(root, `ready-${index}`))));
  writeFileSync(start, "go\n");
  const outcomes = await Promise.all(children.map(async (child) => {
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toBe("");
    return JSON.parse(stdout.trim()) as { status: string; publicationId?: string };
  }));
  expect(outcomes.map(({ status }) => status).sort()).toEqual(["admitted", "conflict"]);
  const occurrences = readdirSync(join(root, "runtime", "btcc-project-ledger-effects-v2", "occurrences"));
  expect(occurrences).toHaveLength(1);
  const winner = outcomes.find(({ status }) => status === "admitted");
  expect(winner?.publicationId).toMatch(/^[a-f0-9]{64}$/);
});

function admissionFixture(content: string) {
  const butlerData = mkdtempSync(join(tmpdir(), "btcc-occurrence-"));
  roots.push(butlerData);
  const ledgerRoot = join(butlerData, "project-ledger", "projects", "ledger-project");
  createLedgerRoot(ledgerRoot);
  return {
    butlerData,
    ledgerProjectId: "ledger-project",
    ledgerRoot,
    operationIdentity: { kind: "mutation_call" as const, id: "mutation-1" },
    requestSha256: hash(content),
    expectedBase: head(ledgerRoot, "base"),
    targetPreconditions: [{
      id: "REF-1",
      kind: "reference",
      path: "project-ledger/projects/ledger-project/references/ref-1.md",
      parentId: "W-1",
      state: "absent" as const,
    }],
  };
}

function createLedgerRoot(ledgerRoot: string): void {
  mkdirSync(ledgerRoot, { recursive: true });
  writeFileSync(join(ledgerRoot, "project.json"), `${JSON.stringify({ id: "ledger-project" }, null, 2)}\n`);
}

function occurrenceFile(butlerData: string): string {
  const root = join(butlerData, "runtime", "btcc-project-ledger-effects-v2", "occurrences");
  const [name] = readdirSync(root);
  if (!name) throw new Error("occurrence fixture missing");
  return join(root, name);
}

function expectation(input: ReturnType<typeof admissionFixture>) {
  return {
    ledgerProjectId: input.ledgerProjectId,
    ledgerRoot: input.ledgerRoot,
    operationIdentity: input.operationIdentity,
    requestSha256: input.requestSha256,
  };
}

function head(projectRoot: string, seed: string) {
  return {
    schema: "butler.btcc-project-ledger-head.v1" as const,
    projectRoot,
    sourceSha256: hash(`${seed}:source`),
    sourceFileCount: 2,
    storageSha256: hash(`${seed}:storage`),
    storageEntryCount: 1,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("worker barrier timeout");
    await Bun.sleep(10);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
