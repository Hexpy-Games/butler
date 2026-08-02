import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLegacyProjectWorkReader,
  createProjectLedgerLegacyWorkSource,
} from "../../packages/butler-agent/src/agent/adapters/index.ts";
import { SqliteGuidedWorkStore } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { createDurableWorkService } from
  "../../packages/butler-agent/src/agent/btcc/durable-work/index.ts";
import {
  clearProjectFixtures,
  projectFixture,
} from "./support/btcc-r3-project-ledger-fixture.ts";
import {
  insertTurn,
  publishBoundProgram,
  publishReviewedProgram,
  rowCount,
  seedProjectLocator,
  seedStaleLocalProjectProgram,
} from "./support/btcc-r3-project-legacy-import-fixture.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  clearProjectFixtures();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("imports only the stable canonical Project Program into one concise R3 Work", async () => {
  const fixture = await projectFixture();
  const program = await publishReviewedProgram(fixture.core, fixture.ledgerRoot);
  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    seedProjectLocator(db, program.programId, "session-project", "message-project");
    seedStaleLocalProjectProgram(db, program.programId, program.goalContractRef.id);
    insertTurn(db, {
      turnId: "turn-r3-import",
      sessionId: "session-project",
      messageId: "message-r3-import",
      message: "이전 프로젝트 작업을 이어서 진행해 주세요.",
    });
    const source = createProjectLedgerLegacyWorkSource({
      butlerData: join(fixture.root, "data"),
      appMessageDbPath: join(fixture.root, "missing.sqlite"),
    });
    const service = createDurableWorkService(new SqliteGuidedWorkStore(db, source));
    const scope = {
      turnId: "turn-r3-import",
      sessionId: "session-project",
      projectRef: "project:fixture-project",
    };

    const imported = await service.importOpenLegacyWork(scope);

    expect(imported).toMatchObject({
      sourceProgramId: program.programId,
      imported: true,
      work: {
        scope: { kind: "project", projectRef: "project:fixture-project" },
        objective: "Produce the fixture result",
        currentPlan: {
          actions: [{
            actionKey: "produce-result",
            description: "결과 생성 및 검증: Produce and verify the requested result.",
            dependencyKeys: [],
          }],
          checks: [
            "The requested result satisfies the original intent.",
            "The canonical Spec and result are satisfied",
          ],
        },
        latestCheckpoint: {
          stage: "execution",
          publicSummary:
            "Imported prior progress: 0 of 1 planned actions have recorded accepted results.",
        },
        actionProgress: [{ actionKey: "produce-result", status: "pending" }],
      },
    });
    expect(imported?.work.currentPlan?.actions.every((action) => !action.effect))
      .toBe(true);
    expect(imported?.work.latestPlanReview).toBeUndefined();
    expect(imported?.work.latestResultReview).toBeUndefined();
    expect((await service.loadContext(scope))?.originalRequest.content)
      .toBe("Produce the fixture result from the canonical request.");
    expect(db.query<{
      source_authority: string;
      source_revision: string;
    }, []>(`
      SELECT source_authority, source_revision
      FROM btcc_guided_work_legacy_imports
    `).get()).toMatchObject({
      source_authority: "project_ledger",
      source_revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await service.importOpenLegacyWork(scope)).toMatchObject({
      imported: false,
      work: { workId: imported?.work.workId },
    });
  } finally {
    db.close();
  }
});

test("refuses local fallback when the canonical Program manifest is missing", async () => {
  const fixture = await projectFixture();
  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    seedProjectLocator(db, "program-local-only", "session-project", "message-project");
    seedStaleLocalProjectProgram(db, "program-local-only", "goal-local-only");
    insertTurn(db, {
      turnId: "turn-r3-import",
      sessionId: "session-project",
      messageId: "message-r3-import",
      message: "이어 주세요.",
    });
    const source = createProjectLedgerLegacyWorkSource({
      butlerData: join(fixture.root, "data"),
      appMessageDbPath: join(fixture.root, "missing.sqlite"),
    });
    const service = createDurableWorkService(new SqliteGuidedWorkStore(db, source));

    expect(await service.importOpenLegacyWork({
      turnId: "turn-r3-import",
      sessionId: "session-project",
      projectRef: "project:fixture-project",
    })).toBeNull();
    expect(rowCount(db, "btcc_guided_works")).toBe(0);
  } finally {
    db.close();
  }
});

test("does not initialize a missing Project Ledger during optional import", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-r3-project-import-missing-"));
  temporaryRoots.push(root);
  const butlerData = join(root, "data");
  let reads = 0;
  const source = createProjectLedgerLegacyWorkSource({
    butlerData,
    appMessageDbPath: join(root, "missing.sqlite"),
    reader: {
      async observeCanonicalHead() {
        reads += 1;
        throw new Error("uninitialized Project Ledger must not be read");
      },
      async loadProgram() {
        reads += 1;
        throw new Error("uninitialized Project Ledger must not be read");
      },
    },
  });

  expect(await source.loadOpenWork({
    projectRef: "project:not-created",
    programIds: ["program-missing"],
  })).toBeNull();
  expect(reads).toBe(0);
  expect(existsSync(join(
    butlerData,
    "project-ledger",
    "projects",
    "not-created",
  ))).toBe(false);
});

test("rejects multiple open Programs and a repeatedly drifting canonical head", async () => {
  const fixture = await projectFixture();
  await publishBoundProgram(fixture.core, fixture.ledgerRoot, "program-first", "turn-first");
  await publishBoundProgram(fixture.core, fixture.ledgerRoot, "program-second", "turn-second");
  const source = createProjectLedgerLegacyWorkSource({
    butlerData: join(fixture.root, "data"),
    appMessageDbPath: join(fixture.root, "missing.sqlite"),
  });
  const db = new Database(":memory:");
  try {
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    seedProjectLocator(db, "program-first", "session-project", "message-first");
    seedProjectLocator(db, "program-second", "session-project", "message-second");
    insertTurn(db, {
      turnId: "turn-r3-import",
      sessionId: "session-project",
      messageId: "message-r3-import",
      message: "이어 주세요.",
    });
    const service = createDurableWorkService(new SqliteGuidedWorkStore(db, source));
    await expect(service.importOpenLegacyWork({
      turnId: "turn-r3-import",
      sessionId: "session-project",
      projectRef: "project:fixture-project",
    })).rejects.toThrow("multiple open R2 Programs");
    expect(rowCount(db, "btcc_guided_works")).toBe(0);
  } finally {
    db.close();
  }

  let drift = 0;
  const reader = createLegacyProjectWorkReader();
  const drifting = createProjectLedgerLegacyWorkSource({
    butlerData: join(fixture.root, "data"),
    appMessageDbPath: join(fixture.root, "missing.sqlite"),
    reader: {
      observeCanonicalHead: (root) => reader.observeCanonicalHead(root),
      async loadProgram(root, programId) {
        const program = await reader.loadProgram(root, programId);
        fixture.core.createRecord(root, {
          kind: "reference",
          id: `R3-IMPORT-DRIFT-${drift}`,
          title: `R3 import drift ${drift}`,
          status: "active",
          body: `drift-${drift++}`,
        });
        return program;
      },
    },
  });
  await expect(drifting.loadOpenWork({
    projectRef: "project:fixture-project",
    programIds: ["program-first"],
  })).rejects.toThrow("changed while importing");
});
