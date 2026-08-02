import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { InboundEnvelope } from
  "../../packages/butler-agent/src/gateways/core/contracts.ts";
import { NativeInboundQueue } from
  "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import {
  BtccInboundDispatcher,
  createBtccQueueEntryDecider,
} from "../../packages/butler-agent/src/interfaces/gateway/btcc/index.ts";
import { admitGatewayCommand } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/admit-gateway-command.ts";
import { DeliveryGuard } from
  "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { SessionBindingStore } from
  "../../packages/butler-agent/src/test-support/harness/session-store.ts";

test("an executor death after claim but before admission re-enters the original Turn once", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-btcc-pre-admission-death-"));
  const dbPath = join(butlerData, "app-server", "butler-client.sqlite");
  const turnId = "turn-claimed-before-admission";
  const sessionId = "butler/app-general";
  const db = createStateDb(dbPath, turnId);
  const queue = new NativeInboundQueue(butlerData);
  const store = createSessionStore(butlerData, sessionId);
  try {
    const queued = queue.enqueue(appEnvelope({ sessionId, turnId }));
    await claimInExitedExecutor(butlerData);

    const processingPath = join(
      butlerData,
      "runtime",
      "inbound-events",
      "processing",
      `${queued.queueId}.json`,
    );
    expect(existsSync(processingPath)).toBe(true);
    expect(readFileSync(processingPath, "utf8")).not.toContain("btccResume");

    let releaseDispatch = () => {};
    const dispatchHeld = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    let handled = 0;
    let receivedResumeMarker = false;
    let admittedKind = "";
    const delivered: string[] = [];
    const server = {
      async handleInbound(envelope: InboundEnvelope) {
        handled += 1;
        receivedResumeMarker =
          (envelope.raw as Record<string, unknown> | undefined)?.btccResume === true;
        admittedKind = admitGatewayCommand({
          binding: store.getBySessionId(sessionId)!,
          envelope,
          turnId,
          context: {
            userRef: "app-user",
            profileRefs: [],
            recentFeedbackRefs: [],
            mandatoryHotCacheRefs: [],
            optionalHotCacheRefs: [],
            baselineObservationScopeRefs: [],
          },
        }).kind;
        await dispatchHeld;
        return {
          status: "handled" as const,
          route: {
            sessionId,
            role: "butler" as const,
            reason: "session-hint" as const,
            workspacePath: butlerData,
          },
          handlerResult: {
            ok: true,
            handledBy: "btcc-turn-runtime",
            metadata: { text: "recovered final answer" },
          },
        };
      },
    };
    const decideEntry = createBtccQueueEntryDecider(dbPath);
    const first = new BtccInboundDispatcher();
    const second = new BtccInboundDispatcher();
    const firstSummary = first.poll({
      queue,
      server,
      store,
      deliveryGuard: new DeliveryGuard({ adapters: [] }),
      deliverAction: async (_activeSessionId, action) => {
        delivered.push(action.message.text ?? "");
        return { ok: true };
      },
      decideEntry,
    });
    const competingSummary = second.poll({
      queue,
      server,
      store,
      deliveryGuard: new DeliveryGuard({ adapters: [] }),
      decideEntry,
    });
    releaseDispatch();
    await Promise.all([first.waitForIdle(), second.waitForIdle()]);

    expect(firstSummary).toEqual({
      claimed: 1,
      handled: 1,
      delivered: 1,
      failed: 0,
      interrupted: 0,
    });
    expect(competingSummary.claimed).toBe(0);
    expect(handled).toBe(1);
    expect(receivedResumeMarker).toBe(false);
    expect(admittedKind).toBe("run");
    expect(delivered).toEqual(["recovered final answer"]);
    const processed = readFileSync(join(
      butlerData,
      "runtime",
      "inbound-events",
      "processed",
      `${queued.queueId}.json`,
    ), "utf8");
    expect(processed).toContain('"recoveryReason": "processing_owner_dead"');
    expect(processed).toContain('"dispatchStatus": "handled"');
    expect(processed).not.toContain("skipped-terminal-turn");
  } finally {
    db.close();
    store.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("an unreadable Turn store leaves the queue pending until entry can be decided", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-btcc-entry-read-retry-"));
  const dbPath = join(butlerData, "app-server", "butler-client.sqlite");
  const turnId = "turn-state-read-retry";
  const sessionId = "butler/app-general";
  mkdirSync(join(butlerData, "app-server"), { recursive: true });
  writeFileSync(dbPath, "not a sqlite database", "utf8");
  const queue = new NativeInboundQueue(butlerData);
  const queued = queue.enqueue(appEnvelope({ sessionId, turnId }));
  const store = createSessionStore(butlerData, sessionId);
  const dispatcher = new BtccInboundDispatcher();
  let handled = 0;
  const server = {
    async handleInbound() {
      handled += 1;
      return {
        status: "handled" as const,
        route: {
          sessionId,
          role: "butler" as const,
          reason: "session-hint" as const,
          workspacePath: butlerData,
        },
        handlerResult: { ok: true, handledBy: "btcc-turn-runtime" },
      };
    },
  };
  const decideEntry = createBtccQueueEntryDecider(dbPath);
  try {
    const unavailable = dispatcher.poll({
      queue,
      server,
      store,
      deliveryGuard: new DeliveryGuard({ adapters: [] }),
      decideEntry,
    });
    await dispatcher.waitForIdle();

    expect(unavailable.claimed).toBe(0);
    expect(handled).toBe(0);
    const pendingPath = join(
      butlerData,
      "runtime",
      "inbound-events",
      "pending",
      `${queued.queueId}.json`,
    );
    expect(existsSync(pendingPath)).toBe(true);
    expect(existsSync(join(
      butlerData,
      "runtime",
      "inbound-events",
      "processed",
      `${queued.queueId}.json`,
    ))).toBe(false);

    rmSync(dbPath);
    const repairedDb = createStateDb(dbPath, turnId);
    repairedDb.close();
    const retried = dispatcher.poll({
      queue,
      server,
      store,
      deliveryGuard: new DeliveryGuard({ adapters: [] }),
      decideEntry,
    });
    await dispatcher.waitForIdle();

    expect(retried.handled).toBe(1);
    expect(handled).toBe(1);
    expect(existsSync(pendingPath)).toBe(false);
  } finally {
    store.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("an App Turn already cancelling is never re-entered as fresh work", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-btcc-cancelling-entry-"));
  const dbPath = join(butlerData, "app-server", "butler-client.sqlite");
  const turnId = "turn-being-cancelled";
  const db = createStateDb(dbPath, turnId);
  const queue = new NativeInboundQueue(butlerData);
  try {
    db.query("UPDATE turns SET state = 'cancelling' WHERE id = ?").run(turnId);
    const item = queue.enqueue(appEnvelope({
      sessionId: "butler/app-general",
      turnId,
    }));
    expect(createBtccQueueEntryDecider(dbPath)(item)).toEqual({ kind: "terminal" });
  } finally {
    db.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("a stale claimed terminal Turn is settled instead of leaking in processing", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-btcc-terminal-processing-"));
  const dbPath = join(butlerData, "app-server", "butler-client.sqlite");
  const turnId = "turn-terminal-in-processing";
  const sessionId = "butler/app-general";
  const db = createStateDb(dbPath, turnId);
  const queue = new NativeInboundQueue(butlerData);
  const store = createSessionStore(butlerData, sessionId);
  const claimedAt = new Date("2026-07-31T00:00:00.000Z");
  try {
    const queued = queue.enqueue(appEnvelope({ sessionId, turnId }), {}, claimedAt);
    expect(queue.claimEligible(1, () => true, claimedAt, 1)).toHaveLength(1);
    db.query("UPDATE turns SET state = 'delivered' WHERE id = ?").run(turnId);
    const dispatcher = new BtccInboundDispatcher();
    const summary = dispatcher.poll({
      queue,
      server: {
        async handleInbound() {
          throw new Error("terminal Turn must not enter BTCC");
        },
      },
      store,
      deliveryGuard: new DeliveryGuard({ adapters: [] }),
      decideEntry: createBtccQueueEntryDecider(dbPath),
      processingLeaseMs: 1,
      now: () => new Date(claimedAt.getTime() + 2),
    });
    await dispatcher.waitForIdle();

    expect(summary).toEqual({
      claimed: 1,
      handled: 0,
      delivered: 0,
      failed: 0,
      interrupted: 0,
    });
    expect(existsSync(join(
      butlerData,
      "runtime",
      "inbound-events",
      "processed",
      `${queued.queueId}.json`,
    ))).toBe(true);
    expect(existsSync(join(
      butlerData,
      "runtime",
      "inbound-events",
      "processing",
      `${queued.queueId}.json`,
    ))).toBe(false);
  } finally {
    db.close();
    store.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
});

function createStateDb(dbPath: string, turnId: string): Database {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE turns (id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE btcc_turns (turn_id TEXT PRIMARY KEY, semantic_state TEXT NOT NULL);
  `);
  db.query("INSERT INTO turns (id, state) VALUES (?, 'thinking')").run(turnId);
  return db;
}

function createSessionStore(
  butlerData: string,
  sessionId: string,
): SessionBindingStore {
  const store = new SessionBindingStore(
    join(butlerData, "runtime", "sessions.sqlite"),
    "ephemeral",
  );
  store.upsert({
    sessionId,
    role: "butler",
    workspacePath: butlerData,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    transportBindings: [{
      transport: "app",
      accountId: "local",
      peerId: "general",
    }],
  });
  return store;
}

function appEnvelope(input: {
  sessionId: string;
  turnId: string;
}) {
  return {
    eventId: `app:${input.turnId}`,
    transport: "app" as const,
    accountId: "local",
    peer: { kind: "dm" as const, id: "general" },
    sender: { id: "app-user" },
    message: {
      id: `message-${input.turnId}`,
      text: "finish this request",
      timestamp: "2026-07-31T00:00:00.000Z",
    },
    routingHints: {
      sessionId: input.sessionId,
      turnId: input.turnId,
    },
  };
}

async function claimInExitedExecutor(butlerData: string): Promise<void> {
  const moduleUrl = pathToFileURL(join(
    process.cwd(),
    "packages",
    "butler-agent",
    "src",
    "gateways",
    "core",
    "inbound-queue.ts",
  )).href;
  const child = Bun.spawn([
    process.execPath,
    "-e",
    `
      const { NativeInboundQueue } = await import(${JSON.stringify(moduleUrl)});
      const queue = new NativeInboundQueue(${JSON.stringify(butlerData)});
      if (queue.claim(1).length !== 1) process.exit(2);
    `,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
}
