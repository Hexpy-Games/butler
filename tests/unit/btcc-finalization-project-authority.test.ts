import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { ProjectWorkLedgerPublicationAdapter } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { discoverContinuationCandidates } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/continuation-candidate-discovery.ts";
import { SqliteRuntimeOwnerRegistry } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/runtime-owner/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { SqliteTurnStateRepository } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/turn-state-repository.ts";
import { stableJson } from
  "../../packages/butler-agent/src/agent/btcc/gateway-api.ts";
import {
  closeManagedProgramForFinalization,
  freshContinuationCommand,
  seedManagedProgramForStop,
} from "./support/btcc-stopped-work-fixture.ts";

test("project finalization resumes the authoritative Project Ledger Program", async () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const projectRef = "project:finalization-authority";
  const seeded = seedManagedProgramForStop(db, projectRef);
  const sqliteProgram = closeManagedProgramForFinalization(db, seeded.storage);
  const projectProgram = {
    ...sqliteProgram,
    manifestRevision: sqliteProgram.manifestRevision + 1,
  };
  db.query(`
    INSERT INTO btcc_project_program_projections (
      program_id, project_ref, ledger_id, manifest_revision
    ) VALUES (?, ?, ?, ?)
  `).run(
    projectProgram.programId,
    projectRef,
    projectProgram.ledgerId,
    projectProgram.manifestRevision,
  );
  db.query(`
    UPDATE btcc_turns SET semantic_state = 'consolidation', revision = 12,
      managed_state_json = ? WHERE turn_id = 'turn-user-stopped'
  `).run(stableJson({ programId: projectProgram.programId }));
  const loadedRevisions: number[] = [];
  const publications = {
    loadProgram: async () => {
      loadedRevisions.push(projectProgram.manifestRevision);
      return projectProgram;
    },
    listDeferredPrograms: async () => [],
  } as unknown as ProjectWorkLedgerPublicationAdapter;
  const runtime = {
    publications,
    resolveProjectRoot: () => "/canonical/project-ledger",
  };
  const owner = new SqliteRuntimeOwnerRegistry(db, {
    ownerId: "project-finalization-authority",
    hostId: "test-host",
    processId: 9,
    processStartedAtMs: 9,
  }, { isAlive: () => true });
  await new SqliteTurnStateRepository(db, owner, runtime).stopTurn("turn-user-stopped");
  const fresh = freshContinuationCommand();
  const [candidate] = await discoverContinuationCandidates(db, {
    ...fresh,
    context: { ...fresh.context, projectRef },
  }, runtime);
  if (candidate?.continuationKind !== "managed_finalization" ||
    candidate.context.finalization.resumeAt !== "consolidation") {
    throw new Error("Project finalization candidate expected");
  }
  expect(candidate.context.finalization.closedProgram.manifestRevision)
    .toBe(projectProgram.manifestRevision);
  expect(candidate.context.finalization.closedProgram.manifestRevision)
    .not.toBe(sqliteProgram.manifestRevision);
  expect(loadedRevisions).toEqual([
    projectProgram.manifestRevision,
    projectProgram.manifestRevision,
  ]);
  owner.close();
  db.close();
});
