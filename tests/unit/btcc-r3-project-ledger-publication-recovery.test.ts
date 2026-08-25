import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyProjectLedgerRecordUpdates,
  reconcileProjectLedgerRecordUpdates,
} from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/external-effect-mutation.ts";
import { loadProjectLedgerCore } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/project-ledger-core.ts";
import { readStableExactProjectLedgerSnapshot } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/canonical-ledger-reader.ts";
import { admitProjectLedgerEffectOccurrence } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/external-effect-occurrence.ts";
import { exchangeCompleteRoots } from
  "../../packages/butler-agent/src/foundation/complete-root-commit/index.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("public publication uses the exact v2 occurrence and remains applied after a later head", async () => {
  const fixture = await createFixture();
  const input = {
    butlerData: fixture.butlerData,
    projectRoot: fixture.projectRoot,
    effectKey: "durable-promotion",
    updates: [{
      operation: "create" as const,
      kind: "report",
      id: "R-DURABLE-PROMOTION",
      title: "Durable promotion",
    }],
  };
  const applied = await applyProjectLedgerRecordUpdates(input);
  const occurrenceRoot = join(
    fixture.butlerData,
    "runtime",
    "btcc-project-ledger-effects-v2",
  );
  const occurrencePath = join(
    occurrenceRoot,
    "occurrences",
    readdirSync(join(occurrenceRoot, "occurrences"))[0]!,
  );
  expect(JSON.parse(readFileSync(occurrencePath, "utf8"))).toMatchObject({
    schema: "butler.btcc-project-ledger-effect-occurrence.v2",
    status: "pending",
    attempts: [{ number: 1, status: "admitted", publicationId: applied.publicationId }],
  });

  fixture.core.createRecord(fixture.projectRoot, {
    project: fixture.projectRoot,
    kind: "report",
    id: "R-LATER-HEAD",
    title: "Later canonical head",
  });

  const replay = await reconcileProjectLedgerRecordUpdates(input);
  expect(replay).toMatchObject({ status: "applied", result: {
    publicationId: applied.publicationId,
    baseHead: applied.baseHead,
  } });
  if (replay.status !== "applied") throw new Error("Expected applied replay");
  expect(replay.result.currentHead.sourceSha256).not.toBe(applied.currentHead.sourceSha256);
  expect(replay.result.currentHead.sourceSha256).toBe(
    fixture.core.observeProjectLedgerSourceHead(fixture.projectRoot).sourceSha256,
  );
  expect(fixture.core.buildIndex(fixture.projectRoot).records.filter(
    (record) => record.id === "R-DURABLE-PROMOTION",
  )).toHaveLength(1);
});

test("exact legacy v1 evidence blocks the v2 mutation without compatibility execution", async () => {
  const fixture = await createFixture();
  const input = effectInput(fixture, "unsupported-v1", "R-BLOCKED-BY-V1");
  const occurrenceId = sha(stableJson({
    schema: "butler.btcc-project-ledger-effect.v1",
    projectRoot: fixture.projectRoot,
    effectKey: input.effectKey,
  }));
  const path = join(
    fixture.butlerData,
    "runtime",
    "btcc-project-ledger-effects",
    "occurrences",
    `${occurrenceId}.json`,
  );
  mkdirSync(join(fixture.butlerData, "runtime", "btcc-project-ledger-effects", "occurrences"), {
    recursive: true,
  });
  writeFileSync(path, "{unsupported legacy evidence\n");

  const uncertain = {
    status: "uncertain" as const,
    message: "The Project Ledger publication state could not be verified safely.",
  };
  expect(await reconcileProjectLedgerRecordUpdates(input)).toEqual(uncertain);
  await expect(applyProjectLedgerRecordUpdates(input)).rejects.toMatchObject({
    code: "project_ledger_effect_uncertain",
    message: uncertain.message,
  });
  expect(fixture.core.buildIndex(fixture.projectRoot).records.some(
    (record) => record.id === "R-BLOCKED-BY-V1",
  )).toBe(false);
  expect(existsSync(join(
    fixture.butlerData,
    "runtime",
    "btcc-project-ledger-effects-v2",
    "occurrences",
  ))).toBe(false);
});

test("normalized-but-not-exact Ledger project identity fails closed before admission", async () => {
  const fixture = await createFixture();
  writeFileSync(join(fixture.projectRoot, "project.json"), `${JSON.stringify({
    schema: "project-ledger.project.v1",
    id: "Fixture Project",
    name: "Non-exact identity",
    status: "active",
  }, null, 2)}\n`);
  const input = effectInput(fixture, "non-exact-project-id", "R-NON-EXACT-ID");
  await expect(applyProjectLedgerRecordUpdates(input)).rejects.toMatchObject({
    code: "project_ledger_effect_uncertain",
  });
  expect(existsSync(join(
    fixture.butlerData,
    "runtime",
    "btcc-project-ledger-effects-v2",
    "occurrences",
  ))).toBe(false);
});

test("stale CAS writes nothing, cleans only its artifacts, and explicit attempt two succeeds", async () => {
  const fixture = await createFixture();
  const input = {
    butlerData: fixture.butlerData,
    projectRoot: fixture.projectRoot,
    effectKey: "explicit-second-attempt",
    updates: [{
      operation: "create" as const,
      kind: "report",
      id: "R-SECOND-ATTEMPT",
      title: "Explicit second attempt",
    }],
  };
  const target = {
    id: "R-SECOND-ATTEMPT",
    kind: "report",
    path: "project-ledger/projects/fixture-project/reports/r-second-attempt.md",
    parentId: null,
  };
  const snapshot = await readStableExactProjectLedgerSnapshot({
    projectRoot: fixture.projectRoot,
    targets: [target],
  });
  const occurrence = admitProjectLedgerEffectOccurrence({
    butlerData: fixture.butlerData,
    ledgerProjectId: "fixture-project",
    ledgerRoot: fixture.projectRoot,
    operationIdentity: { kind: "mutation_call", id: input.effectKey },
    requestSha256: sha(stableJson(input.updates)),
    expectedBase: snapshot.expectedBase,
    targetPreconditions: snapshot.targetPreconditions,
  });
  fixture.core.createRecord(fixture.projectRoot, {
    project: fixture.projectRoot,
    kind: "report",
    id: "R-CAS-WINNER",
    title: "Concurrent winner",
  });

  await expect(applyProjectLedgerRecordUpdates(input)).rejects.toMatchObject({
    code: "project_ledger_effect_not_applied",
    message: "The Project Ledger publication was not applied.",
  });
  expect(fixture.core.buildIndex(fixture.projectRoot).records.some(
    (record) => record.id === "R-SECOND-ATTEMPT",
  )).toBe(false);
  const runtimeRoot = join(fixture.butlerData, "runtime", "btcc-project-ledger-effects-v2");
  expect(existsSync(join(runtimeRoot, "candidates", occurrence.attempts[0]!.publicationId))).toBe(false);
  expect(existsSync(join(runtimeRoot, "journals", `${occurrence.attempts[0]!.publicationId}.json`))).toBe(false);
  expect(await reconcileProjectLedgerRecordUpdates(input)).toEqual({ status: "not_applied" });

  const applied = await applyProjectLedgerRecordUpdates(input);
  const stored = JSON.parse(readFileSync(
    join(runtimeRoot, "occurrences", `${occurrence.occurrenceId}.json`),
    "utf8",
  )) as { attempts: Array<{ number: number; publicationId: string }> };
  expect(stored.attempts.map(({ number }) => number)).toEqual([1, 2]);
  expect(applied.publicationId).toBe(stored.attempts[1]!.publicationId);
  expect(fixture.core.buildIndex(fixture.projectRoot).records.filter(
    (record) => record.id === "R-SECOND-ATTEMPT",
  )).toHaveLength(1);
});

test("admitted-only absence reconciles not applied without publishing and only explicit re-entry adds attempt two", async () => {
  const fixture = await createFixture();
  const input = effectInput(fixture, "admitted-only-absence", "R-ADMITTED-ONLY-ABSENCE");
  const target = {
    id: "R-ADMITTED-ONLY-ABSENCE",
    kind: "report",
    path: "project-ledger/projects/fixture-project/reports/r-admitted-only-absence.md",
    parentId: null,
  };
  const snapshot = await readStableExactProjectLedgerSnapshot({
    projectRoot: fixture.projectRoot,
    targets: [target],
  });
  const occurrence = admitProjectLedgerEffectOccurrence({
    butlerData: fixture.butlerData,
    ledgerProjectId: "fixture-project",
    ledgerRoot: fixture.projectRoot,
    operationIdentity: { kind: "mutation_call", id: input.effectKey },
    requestSha256: sha(stableJson(input.updates)),
    expectedBase: snapshot.expectedBase,
    targetPreconditions: snapshot.targetPreconditions,
  });
  const canonicalBefore = readFileSync(join(fixture.projectRoot, "ledger.jsonl"), "utf8");

  expect(await reconcileProjectLedgerRecordUpdates(input)).toEqual({ status: "not_applied" });
  expect(readFileSync(join(fixture.projectRoot, "ledger.jsonl"), "utf8")).toBe(canonicalBefore);
  expect(fixture.core.buildIndex(fixture.projectRoot).records.some(
    (record) => record.id === "R-ADMITTED-ONLY-ABSENCE",
  )).toBe(false);

  const applied = await applyProjectLedgerRecordUpdates(input);
  const runtimeRoot = join(fixture.butlerData, "runtime", "btcc-project-ledger-effects-v2");
  const stored = JSON.parse(readFileSync(
    join(runtimeRoot, "occurrences", `${occurrence.occurrenceId}.json`),
    "utf8",
  )) as { attempts: Array<{ number: number; publicationId: string }> };
  expect(stored.attempts.map(({ number }) => number)).toEqual([1, 2]);
  expect(applied.publicationId).toBe(stored.attempts[1]!.publicationId);
  expect(fixture.core.buildIndex(fixture.projectRoot).records.filter(
    (record) => record.id === "R-ADMITTED-ONLY-ABSENCE",
  )).toHaveLength(1);
});

test("prepared stale CAS removes its exact candidate, journal, and claim before caller retry", async () => {
  const fixture = await createFixture();
  const seeded = await seedPreparedPublication(fixture, "prepared-stale", "R-PREPARED-STALE");
  const journal = JSON.parse(readFileSync(seeded.journalPath, "utf8"));
  fixture.core.reconcilePublicationClaim(seeded.prepared.claimPath, journal, false);
  fixture.core.createRecord(fixture.projectRoot, {
    project: fixture.projectRoot,
    kind: "report",
    id: "R-PREPARED-CAS-WINNER",
    title: "Prepared CAS winner",
  });

  await expect(applyProjectLedgerRecordUpdates(seeded.input)).rejects.toMatchObject({
    code: "project_ledger_effect_not_applied",
  });
  expect(existsSync(seeded.prepared.candidateRoot)).toBe(false);
  expect(existsSync(seeded.journalPath)).toBe(false);
  expect(existsSync(seeded.prepared.claimPath)).toBe(false);
  expect(fixture.core.buildIndex(fixture.projectRoot).records.some(
    (record) => record.id === "R-PREPARED-STALE",
  )).toBe(false);

  const applied = await applyProjectLedgerRecordUpdates(seeded.input);
  expect(applied.publicationId).not.toBe(seeded.occurrence.attempts[0]!.publicationId);
  expect(fixture.core.buildIndex(fixture.projectRoot).records.filter(
    (record) => record.id === "R-PREPARED-STALE",
  )).toHaveLength(1);
});

test("prepared, committing, promoted, and observed crash cuts reconcile exactly once", async () => {
  for (const state of ["prepared", "committing", "promoted", "observed"] as const) {
    const fixture = await createFixture();
    const seeded = await seedPreparedPublication(fixture, `crash-${state}`, `R-CRASH-${state.toUpperCase()}`);
    if (state === "committing") setJournalStatus(seeded.journalPath, "committing");
    if (state === "promoted" || state === "observed") {
      fixture.core.promoteProjectLedgerPublication(seeded.prepared, exchangeCompleteRoots);
    }
    if (state === "observed") fixture.core.observeProjectLedgerPromotion(seeded.prepared);
    if (state === "promoted") {
      const journal = JSON.parse(readFileSync(seeded.journalPath, "utf8"));
      fixture.core.reconcilePublicationClaim(seeded.prepared.claimPath, journal, false);
      fixture.core.createRecord(fixture.projectRoot, {
        project: fixture.projectRoot,
        kind: "report",
        id: "R-LATER-PROMOTED-HEAD",
        title: "Later promoted head",
      });
    }

    const reconciled = await reconcileProjectLedgerRecordUpdates(seeded.input);
    expect(reconciled).toMatchObject({
      status: "applied",
      result: { publicationId: seeded.occurrence.attempts[0]!.publicationId },
    });
    const events = readFileSync(join(fixture.projectRoot, "ledger.jsonl"), "utf8");
    expect(await reconcileProjectLedgerRecordUpdates(seeded.input)).toEqual(reconciled);
    expect(readFileSync(join(fixture.projectRoot, "ledger.jsonl"), "utf8")).toBe(events);
  }
});

test("committing journal with candidate-active canonical head records applied without re-executing publication", async () => {
  const fixture = await createFixture();
  const seeded = await seedPreparedPublication(
    fixture,
    "exchange-immediate-crash",
    "R-EXCHANGE-IMMEDIATE-CRASH",
  );
  setJournalStatus(seeded.journalPath, "committing");
  exchangeCompleteRoots(seeded.prepared.candidateRoot, fixture.projectRoot);
  const canonicalAfterExchange = readFileSync(join(fixture.projectRoot, "ledger.jsonl"), "utf8");
  const phases: string[] = [];

  const reconciled = await reconcileProjectLedgerRecordUpdates({
    ...seeded.input,
    memoryAttribution: {
      checkpoint() {},
      projectLedgerPhase({ phase, status }) {
        phases.push(`${phase}:${status}`);
      },
      terminal() {},
      close() {},
    },
  });

  expect(reconciled).toMatchObject({
    status: "applied",
    result: { publicationId: seeded.occurrence.attempts[0]!.publicationId },
  });
  expect(phases.some((phase) => [
    "prepare:start",
    "materialize:start",
    "promote:start",
    "observe_promotion:start",
  ].includes(phase))).toBe(false);
  expect(readFileSync(join(fixture.projectRoot, "ledger.jsonl"), "utf8"))
    .toBe(canonicalAfterExchange);
  expect(existsSync(seeded.prepared.candidateRoot)).toBe(false);
  expect(existsSync(seeded.prepared.claimPath)).toBe(false);
  expect(JSON.parse(readFileSync(join(
    fixture.butlerData,
    "runtime",
    "btcc-project-ledger-effects-v2",
    "receipts",
    `${seeded.occurrence.attempts[0]!.publicationId}.json`,
  ), "utf8"))).toMatchObject({ status: "observed" });
  expect(fixture.core.buildIndex(fixture.projectRoot).records.filter(
    (record) => record.id === "R-EXCHANGE-IMMEDIATE-CRASH",
  )).toHaveLength(1);
});

test("possible-started and corrupt evidence fail closed with one safe uncertainty", async () => {
  const fixture = await createFixture();
  const seeded = await seedPreparedPublication(fixture, "uncertain-cut", "R-UNCERTAIN-CUT");
  setJournalStatus(seeded.journalPath, "committing");
  const journal = JSON.parse(readFileSync(seeded.journalPath, "utf8"));
  fixture.core.reconcilePublicationClaim(seeded.prepared.claimPath, journal, false);
  fixture.core.createRecord(fixture.projectRoot, {
    project: fixture.projectRoot,
    kind: "report",
    id: "R-UNCERTAIN-WRITER",
    title: "Writer after possible start",
  });
  const uncertain = await reconcileProjectLedgerRecordUpdates(seeded.input);
  expect(uncertain).toEqual({
    status: "uncertain",
    message: "The Project Ledger publication state could not be verified safely.",
  });
  expect(JSON.stringify(uncertain)).not.toContain(fixture.projectRoot);

  const corruptFixture = await createFixture();
  const appliedInput = effectInput(corruptFixture, "corrupt-receipt", "R-CORRUPT-RECEIPT");
  const applied = await applyProjectLedgerRecordUpdates(appliedInput);
  const receiptPath = join(
    corruptFixture.butlerData,
    "runtime",
    "btcc-project-ledger-effects-v2",
    "receipts",
    `${applied.publicationId}.json`,
  );
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, privatePath: corruptFixture.projectRoot }, null, 2)}\n`);
  const corrupt = await reconcileProjectLedgerRecordUpdates(appliedInput);
  expect(corrupt).toEqual(uncertain);
  expect(JSON.stringify(corrupt)).not.toContain(corruptFixture.projectRoot);

  for (const field of ["baseHead", "candidateHead"] as const) {
    for (const corruption of [
      { schema: "corrupt" },
      { projectRoot: `${corruptFixture.projectRoot}/private` },
      { privatePath: corruptFixture.projectRoot },
    ]) {
      writeFileSync(receiptPath, `${JSON.stringify({
        ...receipt, [field]: { ...receipt[field], ...corruption },
      }, null, 2)}\n`);
      const nested = await reconcileProjectLedgerRecordUpdates(appliedInput);
      expect(nested).toEqual(uncertain);
      expect(JSON.stringify(nested)).not.toContain(corruptFixture.projectRoot);
    }
  }

  const occurrencePath = join(
    corruptFixture.butlerData,
    "runtime",
    "btcc-project-ledger-effects-v2",
    "occurrences",
    readdirSync(join(
      corruptFixture.butlerData,
      "runtime",
      "btcc-project-ledger-effects-v2",
      "occurrences",
    ))[0]!,
  );
  const occurrence = JSON.parse(readFileSync(occurrencePath, "utf8"));
  writeFileSync(occurrencePath, `${JSON.stringify({
    ...occurrence,
    attempts: [{ ...occurrence.attempts[0], number: 2 }],
  }, null, 2)}\n`);
  expect(await reconcileProjectLedgerRecordUpdates(appliedInput)).toEqual(uncertain);

  const journalFixture = await createFixture();
  const journalSeed = await seedPreparedPublication(journalFixture, "corrupt-journal", "R-CORRUPT-JOURNAL");
  const corruptJournal = JSON.parse(readFileSync(journalSeed.journalPath, "utf8"));
  writeFileSync(journalSeed.journalPath, `${JSON.stringify({
    ...corruptJournal,
    publicationId: "0".repeat(64),
    privatePath: journalFixture.projectRoot,
  }, null, 2)}\n`);
  const journalOutcome = await reconcileProjectLedgerRecordUpdates(journalSeed.input);
  expect(journalOutcome).toEqual(uncertain);
  expect(JSON.stringify(journalOutcome)).not.toContain(journalFixture.projectRoot);

  for (const field of ["base", "candidateHead"] as const) {
    for (const corruption of [
      { schema: "corrupt" },
      { projectRoot: `${journalFixture.projectRoot}/private` },
      { privatePath: journalFixture.projectRoot },
    ]) {
      writeFileSync(journalSeed.journalPath, `${JSON.stringify({
        ...corruptJournal, [field]: { ...corruptJournal[field], ...corruption },
      }, null, 2)}\n`);
      const nested = await reconcileProjectLedgerRecordUpdates(journalSeed.input);
      expect(nested).toEqual(uncertain);
      expect(JSON.stringify(nested)).not.toContain(journalFixture.projectRoot);
    }
  }
  writeFileSync(journalSeed.journalPath, `${JSON.stringify(corruptJournal, null, 2)}\n`);
  const claim = JSON.parse(readFileSync(journalSeed.prepared.claimPath, "utf8"));
  writeFileSync(journalSeed.prepared.claimPath, `${JSON.stringify({
    ...claim, privatePath: journalFixture.projectRoot,
  }, null, 2)}\n`);
  const corruptClaim = await reconcileProjectLedgerRecordUpdates(journalSeed.input);
  expect(corruptClaim).toEqual(uncertain);
  expect(JSON.stringify(corruptClaim)).not.toContain(journalFixture.projectRoot);
});

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-publication-recovery-"));
  roots.push(root);
  const butlerData = join(root, "butler-data");
  const projectRoot = join(butlerData, "project-ledger", "projects", "fixture-project");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "project.json"), `${JSON.stringify({
    schema: "project-ledger.project.v1",
    id: "fixture-project",
    name: "Fixture project",
    status: "active",
  }, null, 2)}\n`);
  writeFileSync(join(projectRoot, "ledger.jsonl"), "");
  const core = await loadProjectLedgerCore();
  core.writeIndex(projectRoot);
  return { butlerData, projectRoot, core };
}

function effectInput(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  effectKey: string,
  recordId: string,
) {
  return {
    butlerData: fixture.butlerData,
    projectRoot: fixture.projectRoot,
    effectKey,
    updates: [{
      operation: "create" as const,
      kind: "report",
      id: recordId,
      title: `Crash cut ${recordId}`,
    }],
  };
}

async function seedPreparedPublication(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  effectKey: string,
  recordId: string,
) {
  const input = effectInput(fixture, effectKey, recordId);
  const target = {
    id: recordId,
    kind: "report",
    path: `project-ledger/projects/fixture-project/reports/${recordId.toLocaleLowerCase("en-US")}.md`,
    parentId: null,
  };
  const snapshot = await readStableExactProjectLedgerSnapshot({
    projectRoot: fixture.projectRoot,
    targets: [target],
  });
  const occurrence = admitProjectLedgerEffectOccurrence({
    butlerData: fixture.butlerData,
    ledgerProjectId: "fixture-project",
    ledgerRoot: fixture.projectRoot,
    operationIdentity: { kind: "mutation_call", id: effectKey },
    requestSha256: sha(stableJson(input.updates)),
    expectedBase: snapshot.expectedBase,
    targetPreconditions: snapshot.targetPreconditions,
  });
  const publicationId = occurrence.attempts[0]!.publicationId;
  const runtimeRoot = join(fixture.butlerData, "runtime", "btcc-project-ledger-effects-v2");
  const candidateRoot = join(runtimeRoot, "candidates", publicationId);
  const journalPath = join(runtimeRoot, "journals", `${publicationId}.json`);
  const prepared = fixture.core.prepareProjectLedgerPublication({
    publicationId,
    canonicalRoot: occurrence.ledgerRoot,
    candidateRoot,
    journalPath,
    expectedBase: occurrence.attempts[0]!.expectedBase,
    materialize(projectRoot: string) {
      fixture.core.createRecord(projectRoot, {
        project: projectRoot,
        ...input.updates[0],
      });
      for (const view of ["dashboard", "handoff", "roadmap"]) {
        fixture.core.render(projectRoot, view, { write: true });
      }
      fixture.core.writeIndex(projectRoot);
    },
  }) as {
    publicationId: string;
    canonicalRoot: string;
    candidateRoot: string;
    journalPath: string;
    claimPath: string;
    base: unknown;
    candidateHead: unknown;
  };
  return { input, occurrence, prepared, journalPath };
}

function setJournalStatus(path: string, status: string): void {
  const journal = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, `${JSON.stringify({ ...journal, status }, null, 2)}\n`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
