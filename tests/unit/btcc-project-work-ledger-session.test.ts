import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { SqliteWorkLedgerStorage } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/work-ledger/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import type { WorkLedgerCommit } from
  "../../packages/butler-agent/src/agent/btcc/gateway-api.ts";
import { canonicalMutationId } from "./support/btcc-project-ledger-fixture.ts";
import {
  clearProjectFixtures,
  projectBindingCommit,
  projectFixture,
} from "./support/btcc-project-ledger-fixture.ts";
import { createProjectWorkLedgerPublicationAdapter } from
  "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  assertLogicalLedgerRecordBytes,
  stableJson,
} from "../../packages/butler-agent/src/agent/btcc/index.ts";

afterEach(clearProjectFixtures);

describe("BTCC Session Work Ledger selection", () => {
  test("keeps unbound managed work in the SQLite Session Ledger", () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const storage = new SqliteWorkLedgerStorage(db);
    storage.commit(sessionProgramCommit());

    const row = db.query<{
      ledger_id: string;
      scope_kind: string;
      scope_id: string;
    }, []>("SELECT ledger_id, scope_kind, scope_id FROM btcc_programs").get();
    expect(row).toEqual({
      ledger_id: "session:session-fixture",
      scope_kind: "session",
      scope_id: "session-fixture",
    });
    db.close();
  });

  test("persists identical logical bundle bytes through Project and SQLite adapters", async () => {
    const fixture = await projectFixture();
    const adapter = createProjectWorkLedgerPublicationAdapter({
      stagingRoot: join(fixture.root, "staging"),
    });
    const commit = projectBindingCommit({ governingSpecLogicalIds: [] }).commit;
    const prepared = await adapter.prepareCommit({
      projectRoot: fixture.ledgerRoot,
      expectedBase: await adapter.observeCanonicalHead(fixture.ledgerRoot),
      commit,
    });
    const projectRecord = fixture.core.resolveRecord(prepared.publication.stagedLedgerRoot, {
      kind: "reference",
      id: prepared.publication.logicalBundleRef.id,
    });
    const projectBytes = fixture.core.readRecordBody(projectRecord.filePath);

    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    new SqliteWorkLedgerStorage(db).commit(commit);
    const sqlite = db.query<{ sha256: string; content_json: string }, [string]>(`
      SELECT sha256, content_json FROM btcc_records WHERE record_id = ?
    `).get(prepared.publication.logicalBundleRef.id);

    expect(sqlite?.sha256).toBe(prepared.publication.logicalBundleRef.sha256);
    expect(sqlite?.content_json).toBe(projectBytes);
    db.close();
  });

  test("rejects a commit whose caller-supplied mutationId is not canonical", () => {
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const commit = sessionProgramCommit();
    commit.mutationId = "caller-selected-mutation-id";

    expect(() => new SqliteWorkLedgerStorage(db).commit(commit))
      .toThrow("mutationId does not match");
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM btcc_ledger_claims",
    ).get()?.count).toBe(0);
    db.close();
  });

  test("rejects the former unprefixed SHA-256 form as a logical Ledger record", () => {
    const id = "ledger-record:legacy";
    const bytes = stableJson({ ref: { id }, sourceId: "legacy", record: { value: 1 } });
    const legacySha = createHash("sha256").update(bytes).digest("hex");

    expect(() => assertLogicalLedgerRecordBytes({ id, sha256: legacySha }, bytes))
      .toThrow("logical record identity is invalid");
  });
});

function sessionProgramCommit(): WorkLedgerCommit {
  const ref = (id: string) => ({ id, sha256: `${id}-sha256` });
  const commit: WorkLedgerCommit = {
    mutationId: "",
    turnId: "turn-session",
    expectedTurnRevision: 1,
    mutation: {
      kind: "bind_program",
      sessionId: "session-fixture",
      product: {
        kind: "goal_contract_accepted",
        review: {
          ref: ref("review"),
          candidateRef: ref("candidate"),
          originalGoalContractRef: ref("goal"),
          reviewedLensIds: [],
          reviewedFieldIds: ["request", "intended_result"],
          reviewedOutcomeIds: ["required-outcome"],
          continuationBindingRef: ref("continuation"),
          verdict: "accepted",
        },
        goalContract: {
          ref: ref("goal"),
          originalMessageId: "message",
          originalMessageSha256: "message-sha256",
          request: "Research products",
          intendedResult: "A report",
          acceptanceIntent: "Ranked products",
          fields: [
            { fieldId: "request", semanticRole: "required_outcome", statement: "Research" },
            { fieldId: "intended_result", semanticRole: "required_outcome", statement: "Report" },
          ],
          requiredOutcome: {
            outcomeId: "required-outcome",
            sourceGoalFieldIds: ["request", "intended_result"],
          },
          lensAssessments: {} as never,
          personalizationRefs: [],
          governingSpecLogicalIds: [],
          nonGoals: [],
        },
        authority: {
          ref: ref("authority"),
          goalContractRef: ref("goal"),
          route: "managed",
          ledgerScope: { kind: "session", sessionId: "session-fixture" },
          managedBinding: {
            ledgerId: "session:session-fixture",
            programId: "program-session",
            expectedManifestRevision: 0,
            source: "new_program",
            continuationBinding: { kind: "new_request", inboxId: "inbox-session", ref: ref("continuation") },
          },
        },
      },
    },
  };
  commit.mutationId = canonicalMutationId(commit, null);
  return commit;
}
