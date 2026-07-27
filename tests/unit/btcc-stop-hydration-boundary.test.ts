import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { ProjectWorkLedgerPublicationAdapter } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { SqliteRuntimeOwnerRegistry } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/runtime-owner/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import {
  ManagedStopRevisionChangedError,
  SqliteStopController,
} from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/sqlite-stop-controller.ts";
import { SqliteTurnStateRepository } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/turn-state-repository.ts";
import { seedManagedProgramForStop } from
  "./support/btcc-stopped-work-fixture.ts";

test("terminal project Stop does not depend on the Program loader", async () => {
  const { db } = projectTurn("project:terminal-loader");
  db.query("UPDATE btcc_turns SET semantic_state = 'delivery_committed' WHERE turn_id = ?")
    .run("turn-user-stopped");
  let loads = 0;
  const { owner, turns } = projectRepository(db, async () => {
    loads += 1;
    throw new Error("Project loader unavailable");
  });

  expect(await turns.stopTurn("turn-user-stopped")).toEqual({
    kind: "already_finalizing",
    turnId: "turn-user-stopped",
  });
  expect(loads).toBe(0);
  owner.close();
  db.close();
});

test("project Stop returns terminal outcome when revision becomes finalizing during hydration", async () => {
  const { db, program } = projectTurn("project:terminal-race");
  let loads = 0;
  const { owner, turns } = projectRepository(db, async () => {
    loads += 1;
    if (loads > 1) throw new Error("Project loader unavailable after revision race");
    db.query(`
      UPDATE btcc_turns SET semantic_state = 'delivery_committed', revision = revision + 1
      WHERE turn_id = ?
    `).run("turn-user-stopped");
    return program;
  });

  expect(await turns.stopTurn("turn-user-stopped")).toEqual({
    kind: "already_finalizing",
    turnId: "turn-user-stopped",
  });
  expect(loads).toBe(1);
  owner.close();
  db.close();
});

test("managed Stop rejects a session Program hydrated at a stale Turn revision", () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const { program } = seedManagedProgramForStop(db);
  db.query("UPDATE btcc_turns SET revision = 8 WHERE turn_id = ?")
    .run("turn-user-stopped");

  expect(() => new SqliteStopController(db).stop("turn-user-stopped", {
    program,
    expectedRevision: 7,
    expectedSemanticState: "task_execution",
  })).toThrow(ManagedStopRevisionChangedError);
  expect(db.query<{ semantic_state: string }, []>(`
    SELECT semantic_state FROM btcc_turns WHERE turn_id = 'turn-user-stopped'
  `).get()?.semantic_state).toBe("task_execution");
  expect(db.query("SELECT 1 FROM btcc_stopped_program_continuations").get())
    .toBeNull();
  db.close();
});

test("managed Stop before Planning cancels without a Program", () => {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  seedManagedProgramForStop(db);
  const row = db.query<{ managed_state_json: string }, []>(`
    SELECT managed_state_json FROM btcc_turns
    WHERE turn_id = 'turn-user-stopped'
  `).get()!;
  const managed = JSON.parse(row.managed_state_json) as Record<string, unknown>;
  delete managed.programId;
  db.query(`
    UPDATE btcc_turns
    SET semantic_state = 'contract_review', managed_state_json = ?
    WHERE turn_id = 'turn-user-stopped'
  `).run(JSON.stringify(managed));
  const stops = new SqliteStopController(db);

  expect(stops.managedHydrationRequired("turn-user-stopped")).toBe(false);
  expect(stops.stop("turn-user-stopped")).toEqual({
    kind: "cancelled",
    turnId: "turn-user-stopped",
  });
  expect(db.query<{ semantic_state: string }, []>(`
    SELECT semantic_state FROM btcc_turns WHERE turn_id = 'turn-user-stopped'
  `).get()?.semantic_state).toBe("cancelled");
  db.close();
});

function projectTurn(projectRef: string) {
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  const { program } = seedManagedProgramForStop(db, projectRef);
  db.query(`
    INSERT INTO btcc_project_program_projections (
      program_id, project_ref, ledger_id, manifest_revision
    ) VALUES (?, ?, ?, ?)
  `).run(program.programId, projectRef, program.ledgerId, program.manifestRevision);
  return { db, program };
}

function projectRepository(
  db: Database,
  loadProgram: ProjectWorkLedgerPublicationAdapter["loadProgram"],
) {
  const owner = new SqliteRuntimeOwnerRegistry(db, {
    ownerId: "terminal-stop-owner", hostId: "test-host",
    processId: 3, processStartedAtMs: 3,
  }, { isAlive: () => true });
  const turns = new SqliteTurnStateRepository(db, owner, {
    publications: { loadProgram } as unknown as ProjectWorkLedgerPublicationAdapter,
    resolveProjectRoot: () => "/canonical/project",
  });
  return { owner, turns };
}
