/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";
import { openBtccSqliteStores } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/open-btcc-sqlite-stores.ts";
import { SqlitePrincipalAuthorityRepository } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/authority-repository.ts";
import { BTCC_AUTHORITY_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/authority-schema.ts";
import {
  AuthorityRequestError,
  createPrincipalAuthority,
} from "../../packages/butler-agent/src/agent/btcc/authority/index.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("real App session archive operationally closes only that self-session's open authority requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-close-archive-"));
  roots.push(root);
  const btccDbPath = join(root, "agent-runtime", "btcc.sqlite");
  const appDbPath = join(root, "app.sqlite");
  prepareAuthorityStore(btccDbPath);
  const generalOwner = "butler/app-general";
  const otherOwner = "butler/app-other";
  const privateCommand =
    "printf 'close-private-value' --close-private-flag > closed-private-target.txt";
  insertOpenWork(btccDbPath, {
    workId: "work-close-general",
    sessionId: generalOwner,
  });
  insertAuthorityRequest(btccDbPath, {
    requestRef: "authority-ref-close-general",
    ownerSessionId: generalOwner,
    sourceWorkId: "work-close-general",
    privateCommand,
    clientMessageId: "client-close-general-0000000000000000000000",
  });
  insertAuthorityRequest(btccDbPath, {
    requestRef: "authority-ref-close-other",
    ownerSessionId: otherOwner,
    sourceWorkId: "work-close-other",
    privateCommand: "printf unrelated-other-value",
    clientMessageId: "client-close-other-00000000000000000000000",
  });
  insertDecidedAppliedRequest(btccDbPath, {
    requestRef: "authority-ref-close-done",
    ownerSessionId: generalOwner,
    sourceWorkId: "work-done-general",
    clientMessageId: "client-close-done-00000000000000000000000",
  });
  const server = createAppServer({
    dbPath: appDbPath,
    butlerHome: root,
    butlerData: root,
    port: 0,
  });
  try {
    const beforeResponse = await fetch(
      `${server.url}authority-requests?session_id=general`,
    );
    expect(beforeResponse.status).toBe(200);
    const beforeBody = await beforeResponse.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(beforeBody.data.requests).toHaveLength(1);
    expect(beforeBody.data.requests[0]).toMatchObject({
      request_ref: "authority-ref-close-general",
      category: "command",
    });
    const publicProjection = JSON.stringify(beforeBody.data.requests[0]);
    expect(publicProjection).not.toContain("close-private-value");
    expect(publicProjection).not.toContain("closed-private-target.txt");

    const archive = await fetch(`${server.url}sessions/general/archive`, {
      method: "POST",
    });
    expect(archive.status).toBe(200);
    expect(await archive.json()).toEqual({
      protocol_version: "butler.app.v1",
      data: {
        session: expect.objectContaining({
          id: "general",
          archived: true,
        }),
      },
    });

    const afterResponse = await fetch(
      `${server.url}authority-requests?session_id=general`,
    );
    expect(afterResponse.status).toBe(200);
    const afterBody = await afterResponse.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(afterBody.data.requests).toEqual([]);

    const untouchedResponse = await fetch(
      `${server.url}authority-requests?session_id=other`,
    );
    expect(untouchedResponse.status).toBe(200);
    const untouchedBody = await untouchedResponse.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(untouchedBody.data.requests).toHaveLength(1);
    expect(untouchedBody.data.requests[0]).toMatchObject({
      request_ref: "authority-ref-close-other",
    });

    const closedRow = readAuthorityRow(btccDbPath, "authority-ref-close-general");
    expect(closedRow).toMatchObject({
      decision: "pending",
      outcome: "pending",
      close_reason: "session_archived",
      close_scope: "self_session",
    });
    expect(closedRow?.closed_at).toBeTruthy();
    expect(Number.isNaN(Date.parse(closedRow?.closed_at ?? ""))).toBe(false);
    expect(closedRow?.schedule_client_message_id).toBe(
      "client-close-general-0000000000000000000000",
    );
    expect(closedRow?.outcome_receipt_json).toBeNull();

    const terminalRow = readAuthorityRow(btccDbPath, "authority-ref-close-done");
    expect(terminalRow).toMatchObject({
      decision: "allowed",
      outcome: "applied",
      close_reason: null,
      close_scope: null,
      closed_at: null,
    });
    const otherRow = readAuthorityRow(btccDbPath, "authority-ref-close-other");
    expect(otherRow).toMatchObject({
      decision: "pending",
      close_reason: null,
      closed_at: null,
    });

    const laterDeny = await fetch(
      `${server.url}authority-requests/${encodeURIComponent("authority-ref-close-general")}/deny?session_id=general`,
      { method: "POST" },
    );
    expect(laterDeny.status).toBe(409);
    expect(await laterDeny.json()).toMatchObject({
      error: { code: "authority_decision_conflict" },
    });
    expect(readAuthorityRow(btccDbPath, "authority-ref-close-general")).toMatchObject({
      decision: "pending",
      close_reason: "session_archived",
    });
    expect(readQueueRows(appDbPath, "client-close-general-0000000000000000000000"))
      .toEqual([]);

    const eventsResponse = await fetch(`${server.url}events?limit=200`);
    expect(eventsResponse.status).toBe(200);
    const serializedEvents = JSON.stringify(await eventsResponse.json());
    expect(serializedEvents).not.toContain("close-private-value");
    expect(serializedEvents).not.toContain("--close-private-flag");
    expect(serializedEvents).not.toContain("closed-private-target.txt");
  } finally {
    server.stop();
  }

  const reopened = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "af02f-operational-close-reload",
  });
  try {
    expect(reopened.authority.list({ ownerSessionId: generalOwner })).toEqual([]);
    const persistedRow = readAuthorityRow(btccDbPath, "authority-ref-close-general");
    expect(persistedRow).toMatchObject({
      decision: "pending",
      outcome: "pending",
      close_reason: "session_archived",
      close_scope: "self_session",
    });
  } finally {
    reopened.close();
  }
});

test("real App permanent delete shares the same operational close workflow with typed audit", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-close-delete-"));
  roots.push(root);
  const btccDbPath = join(root, "agent-runtime", "btcc.sqlite");
  const appDbPath = join(root, "app.sqlite");
  prepareAuthorityStore(btccDbPath);
  const deleteOwner = "butler/app-del";
  insertOpenWork(btccDbPath, {
    workId: "work-close-del",
    sessionId: deleteOwner,
  });
  insertAuthorityRequest(btccDbPath, {
    requestRef: "authority-ref-close-del",
    ownerSessionId: deleteOwner,
    sourceWorkId: "work-close-del",
    privateCommand: "printf 'delete-private-value' > deleted-private-target.txt",
    clientMessageId: "client-close-del-000000000000000000000000",
  });
  const server = createAppServer({
    dbPath: appDbPath,
    butlerHome: root,
    butlerData: root,
    port: 0,
  });
  try {
    const created = await fetch(`${server.url}sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "chat",
        title: "Doomed chat",
        session_hint: "del",
      }),
    });
    expect(created.status).toBe(201);

    const removed = await fetch(`${server.url}sessions/del?permanent=true`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      protocol_version: "butler.app.v1",
      data: {
        session: expect.objectContaining({ id: "del" }),
      },
    });

    const chats = await fetch(`${server.url}chats`);
    expect(chats.status).toBe(200);
    const chatsBody = await chats.json() as {
      data: Array<{ id: string }>;
    };
    expect(chatsBody.data.map((chat) => chat.id)).not.toContain("del");

    const cards = await fetch(`${server.url}authority-requests?session_id=del`);
    expect(cards.status).toBe(200);
    const cardsBody = await cards.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(cardsBody.data.requests).toEqual([]);
  } finally {
    server.stop();
  }

  expect(readAuthorityRow(btccDbPath, "authority-ref-close-del")).toMatchObject({
    decision: "pending",
    outcome: "pending",
    close_reason: "session_permanently_deleted",
    close_scope: "self_session",
  });
});

test("operational close and principal decision are mutually exclusive durable winners", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-close-race-"));
  roots.push(root);
  const btccDbPath = join(root, "agent-runtime", "btcc.sqlite");
  const opened = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "af02f-operational-close-cas",
  });
  opened.close();
  const casOwner = "butler/app-cas";
  const casDecisionOwner = "butler/app-cas-two";
  insertOpenWork(btccDbPath, {
    workId: "work-close-cas",
    sessionId: casOwner,
  });
  insertOpenWork(btccDbPath, {
    workId: "work-close-cas-2",
    sessionId: casDecisionOwner,
  });
  const closedWinner = {
    requestRef: "authority-ref-close-winner",
    ownerSessionId: casOwner,
    sourceWorkId: "work-close-cas",
    privateCommand: "printf 'race-private-value'",
    clientMessageId: "client-close-winner-000000000000000000000",
  };
  const decidedWinner = {
    requestRef: "authority-ref-decision-winner",
    ownerSessionId: casDecisionOwner,
    sourceWorkId: "work-close-cas-2",
    privateCommand: "printf 'race-decision-value'",
    clientMessageId: "client-decision-winner-00000000000000000000",
  };
  insertAuthorityRequest(btccDbPath, closedWinner);
  insertAuthorityRequest(btccDbPath, decidedWinner);
  const abandonOwner = "butler/app-cas-three";
  const workDecisionOwner = "butler/app-cas-four";
  const abandonedWinner = {
    requestRef: "authority-ref-abandon-winner",
    ownerSessionId: abandonOwner,
    sourceWorkId: "work-abandon-winner",
    privateCommand: "printf 'race-abandon-value'",
    clientMessageId: "client-abandon-winner-0000000000000000000000",
  };
  const workDecisionWinner = {
    requestRef: "authority-ref-work-decision-winner",
    ownerSessionId: workDecisionOwner,
    sourceWorkId: "work-decision-first",
    privateCommand: "printf 'race-work-decision-value'",
    clientMessageId: "client-work-decision-winner-00000000000000000",
  };
  insertOpenWork(btccDbPath, {
    workId: abandonedWinner.sourceWorkId,
    sessionId: abandonOwner,
  });
  insertOpenWork(btccDbPath, {
    workId: workDecisionWinner.sourceWorkId,
    sessionId: workDecisionOwner,
  });
  insertAuthorityRequest(btccDbPath, abandonedWinner);
  insertAuthorityRequest(btccDbPath, workDecisionWinner);

  const db = new Database(btccDbPath);
  const repository = new SqlitePrincipalAuthorityRepository(db);
  const authority = createPrincipalAuthority(repository);
  try {
    expect(authority.list({ ownerSessionId: casOwner })).toHaveLength(1);

    const closedCount = repository.closePendingSelfSessionRequests({
      selfSessionId: casOwner,
      reason: "session_archived",
      scope: "self_session",
      now: "2026-08-23T10:00:00.000Z",
    });
    expect(closedCount).toBe(1);
    expect(authority.list({ ownerSessionId: casOwner })).toEqual([]);
    expect(authority.list({ ownerSessionId: casDecisionOwner })).toHaveLength(1);

    let conflict: AuthorityRequestError | undefined;
    try {
      authority.decide({
        ownerSessionId: casOwner,
        requestRef: closedWinner.requestRef,
        sourceSessionId: casOwner,
        action: "deny",
      });
    } catch (error) {
      if (error instanceof AuthorityRequestError) conflict = error;
    }
    expect(conflict?.code).toBe("authority_decision_conflict");

    let executionError: AuthorityRequestError | undefined;
    try {
      authority.execution({
        ownerSessionId: casOwner,
        requestRef: closedWinner.requestRef,
        sourceSessionId: casOwner,
        clientMessageId: closedWinner.clientMessageId,
        turnId: "turn-after-close",
      });
    } catch (error) {
      if (error instanceof AuthorityRequestError) executionError = error;
    }
    expect(executionError?.code).toBe("authority_request_not_allowed");

    let replayError: AuthorityRequestError | undefined;
    try {
      authority.admit({
        ownerSessionId: casOwner,
        sourceSessionId: casOwner,
        sourceTurnId: `turn-${closedWinner.requestRef}`,
        sourceWorkId: closedWinner.sourceWorkId,
        workspacePath: seededWorkspacePath(),
        planRevisionId: `plan-${closedWinner.sourceWorkId}`,
        actionKey: "run-seeded-command",
        authorityGeneration: 1,
        capability: "run_command",
        target: "workspace-command:.",
        normalizedInput: {
          command: closedWinner.privateCommand,
          cwd: ".",
          state_effect: "mutation",
        },
        modelRef: "openai/gpt-5.5",
        reasoningEffort: "low",
      });
    } catch (error) {
      if (error instanceof AuthorityRequestError) replayError = error;
    }
    expect(replayError?.code).toBe("authority_request_operationally_closed");

    const secondClose = repository.closePendingSelfSessionRequests({
      selfSessionId: casOwner,
      reason: "session_permanently_deleted",
      scope: "self_session",
      now: "2026-08-23T10:01:00.000Z",
    });
    expect(secondClose).toBe(0);

    const allowed = authority.decide({
      ownerSessionId: casDecisionOwner,
      requestRef: decidedWinner.requestRef,
      sourceSessionId: casDecisionOwner,
      action: "allow",
    });
    expect(allowed.decision).toBe("allowed");

    const closeAfterDecision = repository.closePendingSelfSessionRequests({
      selfSessionId: casDecisionOwner,
      reason: "session_archived",
      scope: "self_session",
      now: "2026-08-23T10:02:00.000Z",
    });
    expect(closeAfterDecision).toBe(0);

    expect(repository.closePendingSourceWorkRequests({
      sourceWorkId: abandonedWinner.sourceWorkId,
      reason: "work_abandoned",
      scope: "work",
      now: "2026-08-23T10:03:00.000Z",
    })).toBe(1);
    let abandonConflict: AuthorityRequestError | undefined;
    try {
      authority.decide({
        ownerSessionId: abandonOwner,
        requestRef: abandonedWinner.requestRef,
        sourceSessionId: abandonOwner,
        action: "allow",
      });
    } catch (error) {
      if (error instanceof AuthorityRequestError) abandonConflict = error;
    }
    expect(abandonConflict?.code).toBe("authority_decision_conflict");
    let workReplayError: AuthorityRequestError | undefined;
    try {
      authority.admit({
        ownerSessionId: abandonOwner,
        sourceSessionId: abandonOwner,
        sourceTurnId: `turn-${abandonedWinner.requestRef}`,
        sourceWorkId: abandonedWinner.sourceWorkId,
        workspacePath: seededWorkspacePath(),
        planRevisionId: `plan-${abandonedWinner.sourceWorkId}`,
        actionKey: "run-seeded-command",
        authorityGeneration: 1,
        capability: "run_command",
        target: "workspace-command:.",
        normalizedInput: {
          command: abandonedWinner.privateCommand,
          cwd: ".",
          state_effect: "mutation",
        },
        modelRef: "openai/gpt-5.5",
        reasoningEffort: "low",
      });
    } catch (error) {
      if (error instanceof AuthorityRequestError) workReplayError = error;
    }
    expect(workReplayError?.code).toBe("authority_request_operationally_closed");
    expect(repository.closePendingSourceWorkRequests({
      sourceWorkId: abandonedWinner.sourceWorkId,
      reason: "work_abandoned",
      scope: "work",
      now: "2026-08-23T10:04:00.000Z",
    })).toBe(0);
    expect(readAuthorityRow(btccDbPath, abandonedWinner.requestRef)).toMatchObject({
      decision: "pending",
      outcome: "pending",
      close_reason: "work_abandoned",
      close_scope: "work",
      closed_at: "2026-08-23T10:03:00.000Z",
    });

    const workAllowed = authority.decide({
      ownerSessionId: workDecisionOwner,
      requestRef: workDecisionWinner.requestRef,
      sourceSessionId: workDecisionOwner,
      action: "allow",
    });
    expect(workAllowed.decision).toBe("allowed");
    expect(repository.closePendingSourceWorkRequests({
      sourceWorkId: workDecisionWinner.sourceWorkId,
      reason: "work_abandoned",
      scope: "work",
      now: "2026-08-23T10:05:00.000Z",
    })).toBe(0);

    expect(readAuthorityRow(btccDbPath, decidedWinner.requestRef)).toMatchObject({
      decision: "allowed",
      close_reason: null,
      close_scope: null,
      closed_at: null,
    });
    expect(readAuthorityRow(btccDbPath, workDecisionWinner.requestRef))
      .toMatchObject({
        decision: "allowed",
        outcome: "pending",
        close_reason: null,
        close_scope: null,
        closed_at: null,
      });
    expect(authority.listDecided().map((row) => row.requestRef).sort()).toEqual([
      decidedWinner.requestRef,
      workDecisionWinner.requestRef,
    ].sort());
  } finally {
    db.close();
  }
});

function prepareAuthorityStore(dbPath: string): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const prepared = openBtccSqliteStores({
    dbPath,
    ownerId: "af02f-operational-close-setup",
  });
  prepared.close();
}

test("self-session operational close never closes a child-source row owned by a parent session", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-close-descendant-"));
  roots.push(root);
  const btccDbPath = join(root, "agent-runtime", "btcc.sqlite");
  prepareAuthorityStore(btccDbPath);
  const parentOwner = "butler/app-desc-parent";
  const childSource = "butler/app-desc-child";
  insertOpenWork(btccDbPath, {
    workId: "work-close-desc",
    sessionId: childSource,
  });
  insertAuthorityRequest(btccDbPath, {
    requestRef: "authority-ref-close-desc",
    ownerSessionId: parentOwner,
    sourceSessionId: childSource,
    sourceWorkId: "work-close-desc",
    privateCommand: "printf 'descendant-private-value'",
    clientMessageId: "client-close-desc-00000000000000000000000",
  });

  const db = new Database(btccDbPath);
  const repository = new SqlitePrincipalAuthorityRepository(db);
  const authority = createPrincipalAuthority(repository);
  try {
    expect(
      authority.closeSelfSession({
        selfSessionId: childSource,
        reason: "session_archived",
      }).closedCount,
    ).toBe(0);
    expect(readAuthorityRow(btccDbPath, "authority-ref-close-desc"))
      .toMatchObject({
        decision: "pending",
        outcome: "pending",
        close_reason: null,
        close_scope: null,
        closed_at: null,
      });

    expect(
      authority.closeSelfSession({
        selfSessionId: parentOwner,
        reason: "session_permanently_deleted",
      }).closedCount,
    ).toBe(0);
    expect(readAuthorityRow(btccDbPath, "authority-ref-close-desc"))
      .toMatchObject({
        decision: "pending",
        close_reason: null,
        closed_at: null,
      });
  } finally {
    db.close();
  }
});

test("nonexistent session archive and permanent delete return the existing 404 without closing a same-hint authority row", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-close-404-"));
  roots.push(root);
  const btccDbPath = join(root, "agent-runtime", "btcc.sqlite");
  const appDbPath = join(root, "app.sqlite");
  prepareAuthorityStore(btccDbPath);
  const ghostOwner = "butler/app-ghost";
  insertOpenWork(btccDbPath, {
    workId: "work-close-ghost",
    sessionId: ghostOwner,
  });
  insertAuthorityRequest(btccDbPath, {
    requestRef: "authority-ref-close-ghost",
    ownerSessionId: ghostOwner,
    sourceWorkId: "work-close-ghost",
    privateCommand: "printf 'ghost-private-value'",
    clientMessageId: "client-close-ghost-0000000000000000000000",
  });
  const server = createAppServer({
    dbPath: appDbPath,
    butlerHome: root,
    butlerData: root,
    port: 0,
  });
  try {
    const archive = await fetch(`${server.url}sessions/ghost/archive`, {
      method: "POST",
    });
    expect(archive.status).toBe(404);
    expect(await archive.json()).toMatchObject({
      error: { code: "session_not_found" },
    });

    const removed = await fetch(
      `${server.url}sessions/ghost?permanent=true`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(404);
    expect(await removed.json()).toMatchObject({
      error: { code: "session_not_found" },
    });

    const cardsResponse = await fetch(
      `${server.url}authority-requests?session_id=ghost`,
    );
    expect(cardsResponse.status).toBe(200);
    const cardsBody = await cardsResponse.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(cardsBody.data.requests).toHaveLength(1);
    expect(cardsBody.data.requests[0]).toMatchObject({
      request_ref: "authority-ref-close-ghost",
    });
  } finally {
    server.stop();
  }

  expect(readAuthorityRow(btccDbPath, "authority-ref-close-ghost"))
    .toMatchObject({
      decision: "pending",
      outcome: "pending",
      close_reason: null,
      close_scope: null,
      closed_at: null,
    });
});

test("prior accepted authority schema is rewritten with all three nullable close audit columns and preserves decision, outcome, and receipt data", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-close-migration-"));
  roots.push(root);
  const btccDbPath = join(root, "agent-runtime", "btcc.sqlite");
  mkdirSync(join(btccDbPath, ".."), { recursive: true });
  const priorSchema = BTCC_AUTHORITY_SCHEMA
    .replace(`
  close_reason TEXT CHECK (
    close_reason IS NULL OR
    close_reason IN (
      'session_archived', 'session_permanently_deleted', 'session_cancelled',
      'work_abandoned'
    )
  ),
  close_scope TEXT CHECK (
    close_scope IS NULL OR close_scope IN ('self_session', 'work')
  ),
  closed_at TEXT,
`, "\n")
    .replace(`,
  CHECK (
    (close_reason IS NULL AND close_scope IS NULL AND closed_at IS NULL) OR
    (
      close_reason IS NOT NULL AND close_scope IS NOT NULL AND closed_at IS NOT NULL
      AND decision = 'pending' AND outcome = 'pending'
    )
  )
);`, "\n);");
  if (
    !priorSchema.includes("decision IN ('pending', 'allowed', 'denied', 'modified')") ||
    !priorSchema.includes("outcome IN ('pending', 'applied', 'failed', 'uncertain')") ||
    priorSchema.includes("close_reason") ||
    priorSchema.includes("close_scope") ||
    priorSchema.includes("closed_at")
  ) {
    throw new Error("AF-02E prior accepted authority schema was not constructed exactly");
  }
  const decidedRow = {
    request_ref: "authority-ref-migration-applied",
    decision: "allowed",
    outcome: "applied",
    receipt_json: JSON.stringify({
      schema: "butler.authority-outcome-receipt.v1",
      outcome: "applied",
      evidenceRef: `authority-evidence-${"3".repeat(64)}`,
      journalEffectId: `guided-effect-${"4".repeat(64)}`,
      dispatchAttempt: 1,
    }),
  };
  const deniedRow = {
    request_ref: "authority-ref-migration-denied",
    decision: "denied",
    outcome: "pending",
    receipt_json: null,
  };
  const seed = new Database(btccDbPath);
  try {
    seed.exec(priorSchema);
    for (const [index, row] of [decidedRow, deniedRow].entries()) {
      seed.query(`
        INSERT INTO btcc_authority_requests (
          request_id, request_ref, identity_sha256, owner_session_id,
          source_session_id, source_turn_id, source_work_id, workspace_path,
          plan_revision_id, action_key, authority_generation, capability,
          normalized_target, normalized_input_json, model_ref, reasoning_effort,
          category, reason, executable, command_count, decision,
          schedule_client_message_id, schedule_input_text, outcome,
          outcome_receipt_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?)
      `).run(
        `request-${row.request_ref}`,
        row.request_ref,
        `migration-identity-${index}`,
        "butler/app-migrated",
        "butler/app-migrated",
        `turn-${row.request_ref}`,
        `work-migration-${index}`,
        "workspace-command-seeded",
        `plan-migration-${index}`,
        "run-seeded-command",
        1,
        "run_command",
        "workspace-command:.",
        JSON.stringify({
          command: "printf 'migration-private-value'",
          cwd: ".",
          state_effect: "mutation",
        }),
        "openai/gpt-5.5",
        "low",
        "command",
        "Run one reviewed seeded command",
        "printf",
        1,
        row.decision,
        `client-migration-${index}-0000000000000000000000000`,
        "Continue the approved operation exactly once.",
        row.outcome,
        row.receipt_json,
        "2026-08-22T09:00:00.000Z",
        "2026-08-22T09:00:00.000Z",
      );
    }
  } finally {
    seed.close();
  }

  const migrated = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "af02f-operational-close-migration",
  });
  migrated.close();

  const readColumns = (path: string) => {
    const db = new Database(path, { readonly: true });
    try {
      return db.query<{ name: string; notnull: number }, []>(
        "PRAGMA table_info(btcc_authority_requests)",
      ).all();
    } finally {
      db.close();
    }
  };
  for (const column of ["close_reason", "close_scope", "closed_at"]) {
    expect(readColumns(btccDbPath)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: column, notnull: 0 }),
      ]),
    );
  }
  const definitionAfterMigration = (() => {
    const db = new Database(btccDbPath, { readonly: true });
    try {
      return db.query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'btcc_authority_requests'",
      ).get()?.sql ?? "";
    } finally {
      db.close();
    }
  })();
  expect(definitionAfterMigration).toContain(
    "close_reason IS NOT NULL AND close_scope IS NOT NULL AND closed_at IS NOT NULL\n      AND decision = 'pending' AND outcome = 'pending'",
  );
  const preservedRows = (() => {
    const db = new Database(btccDbPath, { readonly: true });
    try {
      return db.query<{
        request_ref: string;
        decision: string;
        outcome: string;
        outcome_receipt_json: string | null;
        close_reason: string | null;
        close_scope: string | null;
        closed_at: string | null;
      }, []>(
        "SELECT request_ref, decision, outcome, outcome_receipt_json, close_reason, close_scope, closed_at FROM btcc_authority_requests ORDER BY rowid ASC",
      ).all();
    } finally {
      db.close();
    }
  })();
  expect(preservedRows).toEqual([
    {
      request_ref: decidedRow.request_ref,
      decision: decidedRow.decision,
      outcome: decidedRow.outcome,
      outcome_receipt_json: decidedRow.receipt_json,
      close_reason: null,
      close_scope: null,
      closed_at: null,
    },
    {
      request_ref: deniedRow.request_ref,
      decision: deniedRow.decision,
      outcome: deniedRow.outcome,
      outcome_receipt_json: null,
      close_reason: null,
      close_scope: null,
      closed_at: null,
    },
  ]);

  const migratedColumns = () =>
    readColumns(btccDbPath).map((column) => column.name);
  const columnsAfterMigration = migratedColumns();
  expect(columnsAfterMigration).toContain("close_reason");
  expect(columnsAfterMigration).toContain("close_scope");
  expect(columnsAfterMigration).toContain("closed_at");

  const reopened = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "af02f-operational-close-migration-idempotent",
  });
  reopened.close();
  expect(migratedColumns()).toEqual(columnsAfterMigration);

  const corruption = new Database(btccDbPath);
  try {
    let constraintError: unknown;
    try {
      corruption.query(`
        UPDATE btcc_authority_requests
        SET close_reason = 'session_archived', close_scope = 'self_session',
          closed_at = '2026-08-23T11:00:00.000Z'
        WHERE request_ref = ?
      `).run(decidedRow.request_ref);
    } catch (error) {
      constraintError = error;
    }
    expect(constraintError).toBeInstanceOf(Error);
    expect(String(constraintError)).toContain("CHECK");
  } finally {
    corruption.close();
  }
  const rowAfterRejectedCorruption = (() => {
    const db = new Database(btccDbPath, { readonly: true });
    try {
      return db.query<{
        close_reason: string | null;
        close_scope: string | null;
        closed_at: string | null;
      }, [string]>(
        "SELECT close_reason, close_scope, closed_at FROM btcc_authority_requests WHERE request_ref = ?",
      ).get(decidedRow.request_ref);
    } finally {
      db.close();
    }
  })();
  expect(rowAfterRejectedCorruption).toEqual({
    close_reason: null,
    close_scope: null,
    closed_at: null,
  });
});

test("real App project archive operationally closes every project session's open requests and isolates unrelated sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-close-project-archive-"));
  roots.push(root);
  const btccDbPath = join(root, "agent-runtime", "btcc.sqlite");
  const appDbPath = join(root, "app.sqlite");
  prepareAuthorityStore(btccDbPath);
  const server = createAppServer({
    dbPath: appDbPath,
    butlerHome: root,
    butlerData: root,
    port: 0,
  });
  let projectId: string | undefined;
  try {
    const createdProject = await fetch(`${server.url}projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "scratch",
        display_name: "Close Cascade",
      }),
    });
    expect(createdProject.status).toBe(201);
    projectId = ((await createdProject.json()) as {
      data: { project: { id: string } };
    }).data.project.id;

    for (const hint of ["cascade-a", "cascade-b"]) {
      const created = await fetch(`${server.url}sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "project",
          title: `Cascade ${hint}`,
          project_id: projectId,
          session_hint: hint,
        }),
      });
      expect(created.status).toBe(201);
    }
    const unrelated = await fetch(`${server.url}sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "chat",
        title: "Island chat",
        session_hint: "island",
      }),
    });
    expect(unrelated.status).toBe(201);

    const seededOwners: Array<[string, string]> = [
      ["cascade-a", "work-cascade-a"],
      ["cascade-b", "work-cascade-b"],
      ["island", "work-island"],
    ];
    for (const [hint, workId] of seededOwners) {
      insertOpenWork(btccDbPath, {
        workId,
        sessionId: `butler/app-${hint}`,
      });
      insertAuthorityRequest(btccDbPath, {
        requestRef: `authority-ref-project-${hint}`,
        ownerSessionId: `butler/app-${hint}`,
        sourceWorkId: workId,
        privateCommand: `printf '${hint}-private-value'`,
        clientMessageId: `client-${hint}-0000000000000000000000000000`,
      });
    }

    const archived = await fetch(
      `${server.url}projects/${encodeURIComponent(projectId)}/archive`,
      { method: "POST" },
    );
    expect(archived.status).toBe(200);

    for (const hint of ["cascade-a", "cascade-b"]) {
      const cards = await fetch(
        `${server.url}authority-requests?session_id=${hint}`,
      );
      expect(cards.status).toBe(200);
      const body = await cards.json() as {
        data: { requests: Array<Record<string, unknown>> };
      };
      expect(body.data.requests).toEqual([]);
      expect(readAuthorityRow(btccDbPath, `authority-ref-project-${hint}`))
        .toMatchObject({
          decision: "pending",
          outcome: "pending",
          close_reason: "session_archived",
          close_scope: "self_session",
        });
    }
    const islandCards = await fetch(
      `${server.url}authority-requests?session_id=island`,
    );
    expect(islandCards.status).toBe(200);
    const islandBody = await islandCards.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(islandBody.data.requests).toHaveLength(1);
    expect(readAuthorityRow(btccDbPath, "authority-ref-project-island"))
      .toMatchObject({
        decision: "pending",
        close_reason: null,
        closed_at: null,
      });

    const absentArchive = await fetch(
      `${server.url}projects/project-absent/archive`,
      { method: "POST" },
    );
    expect(absentArchive.status).toBe(404);
    expect(await absentArchive.json()).toMatchObject({
      error: { code: "project_not_found" },
    });
  } finally {
    server.stop();
  }

  const reopened = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "af02f-operational-close-project-reload",
  });
  try {
    expect(reopened.authority.list({ ownerSessionId: "butler/app-cascade-a" }))
      .toEqual([]);
    expect(reopened.authority.list({ ownerSessionId: "butler/app-cascade-b" }))
      .toEqual([]);
    expect(reopened.authority.list({ ownerSessionId: "butler/app-island" }))
      .toHaveLength(1);
    const persisted = readAuthorityRow(
      btccDbPath,
      "authority-ref-project-cascade-a",
    );
    expect(persisted).toMatchObject({
      decision: "pending",
      outcome: "pending",
      close_reason: "session_archived",
      close_scope: "self_session",
    });
    expect(persisted?.closed_at).toBeTruthy();
  } finally {
    reopened.close();
  }
});

test("real App project permanent delete closes active and already archived project sessions without touching unrelated sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-close-project-delete-"));
  roots.push(root);
  const btccDbPath = join(root, "agent-runtime", "btcc.sqlite");
  const appDbPath = join(root, "app.sqlite");
  prepareAuthorityStore(btccDbPath);
  const server = createAppServer({
    dbPath: appDbPath,
    butlerHome: root,
    butlerData: root,
    port: 0,
  });
  let projectId: string | undefined;
  try {
    const createdProject = await fetch(`${server.url}projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "scratch",
        display_name: "Purge Project",
      }),
    });
    expect(createdProject.status).toBe(201);
    projectId = ((await createdProject.json()) as {
      data: { project: { id: string } };
    }).data.project.id;

    for (const hint of ["purge-active", "purge-old"]) {
      const created = await fetch(`${server.url}sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "project",
          title: `Purge ${hint}`,
          project_id: projectId,
          session_hint: hint,
        }),
      });
      expect(created.status).toBe(201);
    }
    const preArchived = await fetch(`${server.url}sessions/purge-old/archive`, {
      method: "POST",
    });
    expect(preArchived.status).toBe(200);
    const island = await fetch(`${server.url}sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "chat",
        title: "Island chat",
        session_hint: "island",
      }),
    });
    expect(island.status).toBe(201);

    const seededOwners: Array<[string, string]> = [
      ["purge-active", "work-purge-active"],
      ["purge-old", "work-purge-old"],
      ["island", "work-island"],
    ];
    for (const [hint, workId] of seededOwners) {
      insertOpenWork(btccDbPath, {
        workId,
        sessionId: `butler/app-${hint}`,
      });
      insertAuthorityRequest(btccDbPath, {
        requestRef: `authority-ref-purge-${hint}`,
        ownerSessionId: `butler/app-${hint}`,
        sourceWorkId: workId,
        privateCommand: `printf '${hint}-private-value'`,
        clientMessageId: `client-${hint}-0000000000000000000000000000`,
      });
    }

    const removed = await fetch(
      `${server.url}projects/${encodeURIComponent(projectId!)}?permanent=true`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);

    const projects = await fetch(`${server.url}projects`);
    expect(projects.status).toBe(200);
    const projectsBody = await projects.json() as {
      data: { projects: Array<{ id: string }> };
    };
    expect(projectsBody.data.projects.map((project) => project.id))
      .not.toContain(projectId);

    const chats = await fetch(`${server.url}chats`);
    expect(chats.status).toBe(200);
    const chatsBody = await chats.json() as {
      data: Array<{ id: string }>;
    };
    const chatIds = chatsBody.data.map((chat) => chat.id);
    expect(chatIds).toContain("island");
    for (const hint of ["purge-active", "purge-old"]) {
      expect(chatIds).not.toContain(hint);
    }

    for (const hint of ["purge-active", "purge-old"]) {
      const cards = await fetch(
        `${server.url}authority-requests?session_id=${hint}`,
      );
      expect(cards.status).toBe(200);
      const body = await cards.json() as {
        data: { requests: Array<Record<string, unknown>> };
      };
      expect(body.data.requests).toEqual([]);
      expect(readAuthorityRow(btccDbPath, `authority-ref-purge-${hint}`))
        .toMatchObject({
          decision: "pending",
          outcome: "pending",
          close_reason: "session_permanently_deleted",
          close_scope: "self_session",
        });
      expect(readAuthorityRow(btccDbPath, `authority-ref-purge-${hint}`)?.closed_at)
        .toBeTruthy();
    }
    expect(readAuthorityRow(btccDbPath, "authority-ref-purge-island"))
      .toMatchObject({
        decision: "pending",
        close_reason: null,
        closed_at: null,
      });
  } finally {
    server.stop();
  }

  const reopened = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "af02f-operational-close-project-delete-reload",
  });
  try {
    expect(reopened.authority.list({ ownerSessionId: "butler/app-purge-active" }))
      .toEqual([]);
    expect(reopened.authority.list({ ownerSessionId: "butler/app-purge-old" }))
      .toEqual([]);
    expect(reopened.authority.list({ ownerSessionId: "butler/app-island" }))
      .toHaveLength(1);
  } finally {
    reopened.close();
  }
});

test("public PATCH /sessions/:id with archived:true routes through operational close and retains a simultaneous title update", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-close-patch-session-"));
  roots.push(root);
  const btccDbPath = join(root, "agent-runtime", "btcc.sqlite");
  const appDbPath = join(root, "app.sqlite");
  prepareAuthorityStore(btccDbPath);
  const patchOwner = "butler/app-patch-sess";
  insertOpenWork(btccDbPath, {
    workId: "work-patch-sess",
    sessionId: patchOwner,
  });
  insertAuthorityRequest(btccDbPath, {
    requestRef: "authority-ref-patch-sess",
    ownerSessionId: patchOwner,
    sourceWorkId: "work-patch-sess",
    privateCommand: "printf 'patch-private-value' > patched-private-target.txt",
    clientMessageId: "client-patch-sess-000000000000000000000000",
  });
  insertOpenWork(btccDbPath, {
    workId: "work-patch-island",
    sessionId: "butler/app-patch-island",
  });
  insertAuthorityRequest(btccDbPath, {
    requestRef: "authority-ref-patch-island",
    ownerSessionId: "butler/app-patch-island",
    sourceWorkId: "work-patch-island",
    privateCommand: "printf 'patch-island-private-value'",
    clientMessageId: "client-patch-island-00000000000000000000000",
  });
  const server = createAppServer({
    dbPath: appDbPath,
    butlerHome: root,
    butlerData: root,
    port: 0,
  });
  try {
    const created = await fetch(`${server.url}sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "chat",
        title: "Patch Before",
        session_hint: "patch-sess",
      }),
    });
    expect(created.status).toBe(201);

    const beforeCards = await fetch(
      `${server.url}authority-requests?session_id=patch-sess`,
    );
    expect(beforeCards.status).toBe(200);
    const beforeBody = await beforeCards.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(beforeBody.data.requests).toHaveLength(1);

    const patched = await fetch(`${server.url}sessions/patch-sess`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true, title: "Patched Title" }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({
      protocol_version: "butler.app.v1",
      data: {
        session: expect.objectContaining({
          id: "patch-sess",
          title: "Patched Title",
          archived: true,
        }),
      },
    });

    expect(readChatRow(appDbPath, "patch-sess")).toEqual({
      title: "Patched Title",
      archived: 1,
    });

    const afterCards = await fetch(
      `${server.url}authority-requests?session_id=patch-sess`,
    );
    expect(afterCards.status).toBe(200);
    const afterBody = await afterCards.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(afterBody.data.requests).toEqual([]);

    const islandCards = await fetch(
      `${server.url}authority-requests?session_id=patch-island`,
    );
    expect(islandCards.status).toBe(200);
    const islandBody = await islandCards.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(islandBody.data.requests).toHaveLength(1);
    expect(islandBody.data.requests[0]).toMatchObject({
      request_ref: "authority-ref-patch-island",
    });

    expect(readAuthorityRow(btccDbPath, "authority-ref-patch-sess"))
      .toMatchObject({
        decision: "pending",
        outcome: "pending",
        close_reason: "session_archived",
        close_scope: "self_session",
        schedule_client_message_id:
          "client-patch-sess-000000000000000000000000",
        outcome_receipt_json: null,
      });
    expect(readAuthorityRow(btccDbPath, "authority-ref-patch-sess")?.closed_at)
      .toBeTruthy();
    expect(readAuthorityRow(btccDbPath, "authority-ref-patch-island"))
      .toMatchObject({ decision: "pending", close_reason: null, closed_at: null });

    const laterDeny = await fetch(
      `${server.url}authority-requests/${encodeURIComponent("authority-ref-patch-sess")}/deny?session_id=patch-sess`,
      { method: "POST" },
    );
    expect(laterDeny.status).toBe(409);
    expect(await laterDeny.json()).toMatchObject({
      error: { code: "authority_decision_conflict" },
    });
    expect(readQueueRows(appDbPath, "client-patch-sess-000000000000000000000000"))
      .toEqual([]);

    const eventsResponse = await fetch(`${server.url}events?limit=200`);
    expect(eventsResponse.status).toBe(200);
    const serializedEvents = JSON.stringify(await eventsResponse.json());
    expect(serializedEvents).not.toContain("patch-private-value");
    expect(serializedEvents).not.toContain("--close-private-flag");
  } finally {
    server.stop();
  }

  const reopened = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "af02f-operational-close-patch-reload",
  });
  try {
    expect(reopened.authority.list({ ownerSessionId: patchOwner })).toEqual([]);
    expect(readAuthorityRow(btccDbPath, "authority-ref-patch-sess"))
      .toMatchObject({
        decision: "pending",
        outcome: "pending",
        close_reason: "session_archived",
        close_scope: "self_session",
      });
  } finally {
    reopened.close();
  }
});

test("public PATCH /projects/:id with archived:true closes every factual project session and carries simultaneous metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-close-patch-project-"));
  roots.push(root);
  const btccDbPath = join(root, "agent-runtime", "btcc.sqlite");
  const appDbPath = join(root, "app.sqlite");
  prepareAuthorityStore(btccDbPath);
  const server = createAppServer({
    dbPath: appDbPath,
    butlerHome: root,
    butlerData: root,
    port: 0,
  });
  let projectId: string | undefined;
  try {
    const createdProject = await fetch(`${server.url}projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "scratch",
        display_name: "Patch Cascade",
      }),
    });
    expect(createdProject.status).toBe(201);
    projectId = ((await createdProject.json()) as {
      data: { project: { id: string } };
    }).data.project.id;

    for (const hint of ["pc-active", "pc-old"]) {
      const created = await fetch(`${server.url}sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "project",
          title: `PC ${hint}`,
          project_id: projectId,
          session_hint: hint,
        }),
      });
      expect(created.status).toBe(201);
    }
    const preArchived = await fetch(`${server.url}sessions/pc-old/archive`, {
      method: "POST",
    });
    expect(preArchived.status).toBe(200);

    for (const [hint, workId] of [
      ["pc-active", "work-pc-active"],
      ["pc-old", "work-pc-old"],
      ["pc-island", "work-pc-island"],
    ] as Array<[string, string]>) {
      insertOpenWork(btccDbPath, {
        workId,
        sessionId: `butler/app-${hint}`,
      });
      insertAuthorityRequest(btccDbPath, {
        requestRef: `authority-ref-${hint}`,
        ownerSessionId: `butler/app-${hint}`,
        sourceWorkId: workId,
        privateCommand: `printf '${hint}-private-value'`,
        clientMessageId: `client-${hint}-0000000000000000000000000000`,
      });
    }

    const patched = await fetch(
      `${server.url}projects/${encodeURIComponent(projectId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          archived: true,
          display_name: "Renamed Cascade",
          pinned: true,
        }),
      },
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({
      protocol_version: "butler.app.v1",
      data: {
        project: expect.objectContaining({
          id: projectId,
          display_name: "Renamed Cascade",
          pinned: true,
          archived: true,
          status: "archived",
        }),
      },
    });

    expect(readProjectRow(appDbPath, projectId!)).toMatchObject({
      display_name: "Renamed Cascade",
      pinned: 1,
      archived: 1,
      status: "archived",
    });
    expect(readChatRow(appDbPath, "pc-active")).toMatchObject({ archived: 1 });
    expect(readChatRow(appDbPath, "pc-old")).toMatchObject({ archived: 1 });

    for (const hint of ["pc-active", "pc-old"]) {
      expect(readAuthorityRow(btccDbPath, `authority-ref-${hint}`))
        .toMatchObject({
          decision: "pending",
          outcome: "pending",
          close_reason: "session_archived",
          close_scope: "self_session",
        });
      expect(
        readAuthorityRow(btccDbPath, `authority-ref-${hint}`)?.closed_at,
      ).toBeTruthy();
    }
    expect(readAuthorityRow(btccDbPath, "authority-ref-pc-island"))
      .toMatchObject({
        decision: "pending",
        close_reason: null,
        closed_at: null,
      });

    for (const hint of ["pc-active", "pc-old"]) {
      const cards = await fetch(
        `${server.url}authority-requests?session_id=${hint}`,
      );
      const body = await cards.json() as {
        data: { requests: Array<Record<string, unknown>> };
      };
      expect(body.data.requests).toEqual([]);
    }
    const islandCards = await fetch(
      `${server.url}authority-requests?session_id=pc-island`,
    );
    const islandBody = await islandCards.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(islandBody.data.requests).toHaveLength(1);
  } finally {
    server.stop();
  }

  const reopened = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "af02f-operational-close-patch-project-reload",
  });
  try {
    expect(reopened.authority.list({ ownerSessionId: "butler/app-pc-active" }))
      .toEqual([]);
    expect(reopened.authority.list({ ownerSessionId: "butler/app-pc-old" }))
      .toEqual([]);
    expect(reopened.authority.list({ ownerSessionId: "butler/app-pc-island" }))
      .toHaveLength(1);
  } finally {
    reopened.close();
  }
});

test("PATCH updates without archived:true stay ordinary updates and never close pending requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-close-patch-plain-"));
  roots.push(root);
  const btccDbPath = join(root, "agent-runtime", "btcc.sqlite");
  const appDbPath = join(root, "app.sqlite");
  prepareAuthorityStore(btccDbPath);
  insertOpenWork(btccDbPath, {
    workId: "work-stay-open",
    sessionId: "butler/app-stay-open",
  });
  insertAuthorityRequest(btccDbPath, {
    requestRef: "authority-ref-stay-open",
    ownerSessionId: "butler/app-stay-open",
    sourceWorkId: "work-stay-open",
    privateCommand: "printf 'stay-open-private-value'",
    clientMessageId: "client-stay-open-0000000000000000000000000",
  });
  insertOpenWork(btccDbPath, {
    workId: "work-pk-open",
    sessionId: "butler/app-pk-sess",
  });
  insertAuthorityRequest(btccDbPath, {
    requestRef: "authority-ref-pk-open",
    ownerSessionId: "butler/app-pk-sess",
    sourceWorkId: "work-pk-open",
    privateCommand: "printf 'pk-open-private-value'",
    clientMessageId: "client-pk-open-00000000000000000000000000",
  });
  const server = createAppServer({
    dbPath: appDbPath,
    butlerHome: root,
    butlerData: root,
    port: 0,
  });
  let projectId: string | undefined;
  try {
    const createdChat = await fetch(`${server.url}sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "chat",
        title: "Stay open",
        session_hint: "stay-open",
      }),
    });
    expect(createdChat.status).toBe(201);

    const renamed = await fetch(`${server.url}sessions/stay-open`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Rename Only" }),
    });
    expect(renamed.status).toBe(200);
    expect(readAuthorityRow(btccDbPath, "authority-ref-stay-open"))
      .toMatchObject({
        decision: "pending",
        outcome: "pending",
        close_reason: null,
        close_scope: null,
        closed_at: null,
      });

    const unarchived = await fetch(`${server.url}sessions/stay-open`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    expect(unarchived.status).toBe(200);
    expect(readAuthorityRow(btccDbPath, "authority-ref-stay-open"))
      .toMatchObject({
        decision: "pending",
        close_reason: null,
        closed_at: null,
      });

    const cards = await fetch(
      `${server.url}authority-requests?session_id=stay-open`,
    );
    const cardsBody = await cards.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(cardsBody.data.requests).toHaveLength(1);

    const createdProject = await fetch(`${server.url}projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "scratch",
        display_name: "Keep Open Project",
      }),
    });
    expect(createdProject.status).toBe(201);
    projectId = ((await createdProject.json()) as {
      data: { project: { id: string } };
    }).data.project.id;
    const createdSession = await fetch(`${server.url}sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "project",
        title: "PK session",
        project_id: projectId,
        session_hint: "pk-sess",
      }),
    });
    expect(createdSession.status).toBe(201);

    const projectRenamed = await fetch(
      `${server.url}projects/${encodeURIComponent(projectId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ display_name: "Display Only" }),
      },
    );
    expect(projectRenamed.status).toBe(200);
    expect(readAuthorityRow(btccDbPath, "authority-ref-pk-open"))
      .toMatchObject({
        decision: "pending",
        close_reason: null,
        closed_at: null,
      });

    const projectUnarchived = await fetch(
      `${server.url}projects/${encodeURIComponent(projectId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: false }),
      },
    );
    expect(projectUnarchived.status).toBe(200);
    expect(readAuthorityRow(btccDbPath, "authority-ref-pk-open"))
      .toMatchObject({
        decision: "pending",
        close_reason: null,
        closed_at: null,
      });

    const pkCards = await fetch(
      `${server.url}authority-requests?session_id=pk-sess`,
    );
    const pkCardsBody = await pkCards.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(pkCardsBody.data.requests).toHaveLength(1);
  } finally {
    server.stop();
  }
});

test("failed App lifecycle mutation after durable PATCH close leaves the authority request operationally closed and fails later decisions closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-close-failsafe-"));
  roots.push(root);
  const btccDbPath = join(root, "agent-runtime", "btcc.sqlite");
  const appDbPath = join(root, "app.sqlite");
  prepareAuthorityStore(btccDbPath);
  insertOpenWork(btccDbPath, {
    workId: "work-fs-sess",
    sessionId: "butler/app-fs-sess",
  });
  insertAuthorityRequest(btccDbPath, {
    requestRef: "authority-ref-fs-sess",
    ownerSessionId: "butler/app-fs-sess",
    sourceWorkId: "work-fs-sess",
    privateCommand: "printf 'failsafe-private-value'",
    clientMessageId: "client-fs-sess-000000000000000000000000000",
  });
  const server = createAppServer({
    dbPath: appDbPath,
    butlerHome: root,
    butlerData: root,
    port: 0,
  });
  let closedAtAfterFailure: string | null | undefined;
  try {
    const created = await fetch(`${server.url}sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "chat",
        title: "FS chat",
        session_hint: "fs-sess",
      }),
    });
    expect(created.status).toBe(201);

    blockTableUpdates(appDbPath, "chats", "block_chat_updates_fs");
    const failed = await fetch(`${server.url}sessions/fs-sess`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true, title: "Must Not Apply" }),
    });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({
      error: { code: "internal_error" },
    });
    unblockTableUpdates(appDbPath, "block_chat_updates_fs");

    expect(readChatRow(appDbPath, "fs-sess")).toEqual({
      title: "FS chat",
      archived: 0,
    });

    const failedCloseRow = readAuthorityRow(btccDbPath, "authority-ref-fs-sess");
    expect(failedCloseRow).toMatchObject({
      decision: "pending",
      outcome: "pending",
      close_reason: "session_archived",
      close_scope: "self_session",
      outcome_receipt_json: null,
    });
    expect(failedCloseRow?.closed_at).toBeTruthy();
    closedAtAfterFailure = failedCloseRow?.closed_at ?? null;

    const cards = await fetch(
      `${server.url}authority-requests?session_id=fs-sess`,
    );
    const cardsBody = await cards.json() as {
      data: { requests: Array<Record<string, unknown>> };
    };
    expect(cardsBody.data.requests).toEqual([]);

    const laterDeny = await fetch(
      `${server.url}authority-requests/${encodeURIComponent("authority-ref-fs-sess")}/deny?session_id=fs-sess`,
      { method: "POST" },
    );
    expect(laterDeny.status).toBe(409);
    expect(await laterDeny.json()).toMatchObject({
      error: { code: "authority_decision_conflict" },
    });

    expect(readQueueRows(appDbPath, "client-fs-sess-000000000000000000000000000"))
      .toEqual([]);

    const retried = await fetch(`${server.url}sessions/fs-sess`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true, title: "Retried Title" }),
    });
    expect(retried.status).toBe(200);
    expect(readChatRow(appDbPath, "fs-sess")).toEqual({
      title: "Retried Title",
      archived: 1,
    });
  } finally {
    unblockTableUpdates(appDbPath, "block_chat_updates_fs");
    server.stop();
  }

  expect(readAuthorityRow(btccDbPath, "authority-ref-fs-sess")).toMatchObject({
    decision: "pending",
    outcome: "pending",
    close_reason: "session_archived",
    close_scope: "self_session",
  });
  expect(readAuthorityRow(btccDbPath, "authority-ref-fs-sess")?.closed_at)
    .toBe(closedAtAfterFailure);
  expect(readQueueRows(appDbPath, "client-fs-sess-000000000000000000000000000"))
    .toEqual([]);

  const reopened = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "af02f-operational-close-failsafe-reload",
  });
  try {
    expect(reopened.authority.list({ ownerSessionId: "butler/app-fs-sess" }))
      .toEqual([]);
  } finally {
    reopened.close();
  }
});

test("failed App project lifecycle mutation still leaves every cascade-closed project session operationally closed without rollback", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-self-close-failsafe-proj-"));
  roots.push(root);
  const btccDbPath = join(root, "agent-runtime", "btcc.sqlite");
  const appDbPath = join(root, "app.sqlite");
  prepareAuthorityStore(btccDbPath);
  const server = createAppServer({
    dbPath: appDbPath,
    butlerHome: root,
    butlerData: root,
    port: 0,
  });
  const closedAtByHint = new Map<string, string>();
  let projectId: string | undefined;
  try {
    const createdProject = await fetch(`${server.url}projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "scratch",
        display_name: "Failsafe Cascade",
      }),
    });
    expect(createdProject.status).toBe(201);
    projectId = ((await createdProject.json()) as {
      data: { project: { id: string } };
    }).data.project.id;

    for (const hint of ["fp-active", "fp-old"]) {
      const created = await fetch(`${server.url}sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "project",
          title: `FP ${hint}`,
          project_id: projectId,
          session_hint: hint,
        }),
      });
      expect(created.status).toBe(201);
    }
    const preArchived = await fetch(`${server.url}sessions/fp-old/archive`, {
      method: "POST",
    });
    expect(preArchived.status).toBe(200);

    for (const [hint, workId] of [
      ["fp-active", "work-fp-active"],
      ["fp-old", "work-fp-old"],
    ] as Array<[string, string]>) {
      insertOpenWork(btccDbPath, {
        workId,
        sessionId: `butler/app-${hint}`,
      });
      insertAuthorityRequest(btccDbPath, {
        requestRef: `authority-ref-${hint}`,
        ownerSessionId: `butler/app-${hint}`,
        sourceWorkId: workId,
        privateCommand: `printf '${hint}-private-value'`,
        clientMessageId: `client-${hint}-fail-000000000000000000000000`,
      });
    }

    blockTableUpdates(appDbPath, "projects", "block_project_updates_fp");
    const failed = await fetch(
      `${server.url}projects/${encodeURIComponent(projectId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      },
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({
      error: { code: "internal_error" },
    });
    unblockTableUpdates(appDbPath, "block_project_updates_fp");

    expect(readProjectRow(appDbPath, projectId!)).toMatchObject({
      archived: 0,
      status: "active",
    });
    expect(readChatRow(appDbPath, "fp-active")).toMatchObject({ archived: 0 });
    expect(readChatRow(appDbPath, "fp-old")).toMatchObject({ archived: 1 });

    for (const hint of ["fp-active", "fp-old"]) {
      const row = readAuthorityRow(btccDbPath, `authority-ref-${hint}`);
      expect(row).toMatchObject({
        decision: "pending",
        outcome: "pending",
        close_reason: "session_archived",
        close_scope: "self_session",
      });
      expect(row?.closed_at).toBeTruthy();
      closedAtByHint.set(hint, row?.closed_at ?? "");

      const cards = await fetch(
        `${server.url}authority-requests?session_id=${hint}`,
      );
      const body = await cards.json() as {
        data: { requests: Array<Record<string, unknown>> };
      };
      expect(body.data.requests).toEqual([]);
    }

    const laterDeny = await fetch(
      `${server.url}authority-requests/${encodeURIComponent("authority-ref-fp-active")}/deny?session_id=fp-active`,
      { method: "POST" },
    );
    expect(laterDeny.status).toBe(409);
    expect(await laterDeny.json()).toMatchObject({
      error: { code: "authority_decision_conflict" },
    });
    expect(readQueueRows(appDbPath, "client-fp-active-fail-000000000000000000000000"))
      .toEqual([]);

    const retried = await fetch(
      `${server.url}projects/${encodeURIComponent(projectId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      },
    );
    expect(retried.status).toBe(200);
    expect(readProjectRow(appDbPath, projectId!)).toMatchObject({
      archived: 1,
      status: "archived",
    });
  } finally {
    unblockTableUpdates(appDbPath, "block_project_updates_fp");
    server.stop();
  }

  for (const hint of ["fp-active", "fp-old"]) {
    expect(readAuthorityRow(btccDbPath, `authority-ref-${hint}`))
      .toMatchObject({
        decision: "pending",
        outcome: "pending",
        close_reason: "session_archived",
        close_scope: "self_session",
      });
    expect(readAuthorityRow(btccDbPath, `authority-ref-${hint}`)?.closed_at)
      .toBe(closedAtByHint.get(hint));
  }

  const reopened = openBtccSqliteStores({
    dbPath: btccDbPath,
    ownerId: "af02f-operational-close-failsafe-project-reload",
  });
  try {
    expect(reopened.authority.list({ ownerSessionId: "butler/app-fp-active" }))
      .toEqual([]);
    expect(reopened.authority.list({ ownerSessionId: "butler/app-fp-old" }))
      .toEqual([]);
  } finally {
    reopened.close();
  }
});

function seededWorkspacePath(): string {
  return "workspace-command-seeded";
}

type SeededRequestConfig = {
  requestRef: string;
  ownerSessionId: string;
  sourceSessionId?: string;
  sourceWorkId: string;
  privateCommand: string;
  clientMessageId: string;
};

function insertAuthorityRequest(dbPath: string, config: SeededRequestConfig): void {
  const db = new Database(dbPath);
  const sourceSessionId = config.sourceSessionId ?? config.ownerSessionId;
  try {
    db.query(`
      INSERT INTO btcc_authority_requests (
        request_id, request_ref, identity_sha256, owner_session_id,
        source_session_id, source_turn_id, source_work_id, workspace_path,
        plan_revision_id, action_key, authority_generation, capability,
        normalized_target, normalized_input_json, model_ref, reasoning_effort,
        category, reason, executable, command_count, decision,
        schedule_client_message_id, schedule_input_text, outcome,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?
      )
    `).run(
      `request-${config.requestRef}`,
      config.requestRef,
      seededIdentitySha256(config),
      config.ownerSessionId,
      sourceSessionId,
      `turn-${config.requestRef}`,
      config.sourceWorkId,
      seededWorkspacePath(),
      `plan-${config.sourceWorkId}`,
      "run-seeded-command",
      1,
      "run_command",
      "workspace-command:.",
      JSON.stringify({
        command: config.privateCommand,
        cwd: ".",
        state_effect: "mutation",
      }),
      "openai/gpt-5.5",
      "low",
      "command",
      "Run one reviewed seeded command",
      "printf",
      1,
      "pending",
      config.clientMessageId,
      "Continue the approved operation exactly once.",
      "pending",
      "2026-08-23T09:00:00.000Z",
      "2026-08-23T09:00:00.000Z",
    );
  } finally {
    db.close();
  }
}

function insertDecidedAppliedRequest(
  dbPath: string,
  config: Omit<SeededRequestConfig, "privateCommand">,
): void {
  insertAuthorityRequest(dbPath, {
    ...config,
    privateCommand: "printf completed-private-value",
  });
  const db = new Database(dbPath);
  try {
    db.query(`
      UPDATE btcc_authority_requests
      SET decision = 'allowed', outcome = 'applied'
      WHERE request_ref = ?
    `).run(config.requestRef);
  } finally {
    db.close();
  }
}

function insertOpenWork(
  dbPath: string,
  input: { workId: string; sessionId: string },
): void {
  const db = new Database(dbPath);
  try {
    db.query(`
      INSERT INTO btcc_guided_works (
        work_id, session_id, scope_kind, scope_ref, origin_turn_id,
        origin_message_id, objective, status, created_at, updated_at
      ) VALUES (?, ?, 'session', 'seeded', 'seeded-origin-turn',
        'seeded-origin-message', 'Seeded close Work', 'open',
        '2026-08-23T08:00:00.000Z', '2026-08-23T08:00:00.000Z')
    `).run(input.workId, input.sessionId);
  } finally {
    db.close();
  }
}

function seededIdentitySha256(config: SeededRequestConfig): string {
  const identity = {
    version: 1,
    ownerSessionId: config.ownerSessionId,
    sourceSessionId: config.sourceSessionId ?? config.ownerSessionId,
    sourceTurnId: `turn-${config.requestRef}`,
    sourceWorkId: config.sourceWorkId,
    workspacePath: seededWorkspacePath(),
    planRevisionId: `plan-${config.sourceWorkId}`,
    actionKey: "run-seeded-command",
    authorityGeneration: 1,
    capability: "run_command",
    target: "workspace-command:.",
    normalizedInput: {
      command: config.privateCommand,
      cwd: ".",
      state_effect: "mutation",
    },
  };
  return createHash("sha256").update(canonicalJson(identity)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

type AuthorityRowSnapshot = {
  decision: string;
  outcome: string;
  schedule_client_message_id: string;
  close_reason: string | null;
  close_scope: string | null;
  closed_at: string | null;
  updated_at: string;
  outcome_receipt_json: string | null;
};

function readAuthorityRow(dbPath: string, requestRef: string): AuthorityRowSnapshot | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<AuthorityRowSnapshot, [string]>(`
      SELECT decision, outcome, schedule_client_message_id,
        close_reason, close_scope, closed_at, updated_at, outcome_receipt_json
      FROM btcc_authority_requests WHERE request_ref = ?
    `).get(requestRef) ?? null;
  } finally {
    db.close();
  }
}

function readQueueRows(dbPath: string, clientMessageId: string): Array<{
  client_message_id: string;
}> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ client_message_id: string }, [string]>(`
      SELECT client_message_id FROM session_queued_messages
      WHERE client_message_id = ?
    `).all(clientMessageId);
  } finally {
    db.close();
  }
}

function readChatRow(
  dbPath: string,
  id: string,
): { title: string; archived: number } | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ title: string; archived: number }, [string]>(
      "SELECT title, archived FROM chats WHERE id = ?",
    ).get(id) ?? null;
  } finally {
    db.close();
  }
}

function readProjectRow(
  dbPath: string,
  id: string,
): {
  display_name: string;
  pinned: number;
  archived: number;
  status: string;
} | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{
      display_name: string;
      pinned: number;
      archived: number;
      status: string;
    }, [string]>(
      "SELECT display_name, pinned, archived, status FROM projects WHERE id = ?",
    ).get(id) ?? null;
  } finally {
    db.close();
  }
}

function blockTableUpdates(
  dbPath: string,
  table: string,
  triggerName: string,
): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TRIGGER ${triggerName} BEFORE UPDATE ON ${table}
      BEGIN
        SELECT RAISE(ABORT, 'forced app lifecycle failure');
      END;
    `);
  } finally {
    db.close();
  }
}

function unblockTableUpdates(dbPath: string, triggerName: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
  } finally {
    db.close();
  }
}
