import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { OutboundAction } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";
import { DeliveryGuard } from "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";

let tempDir = "";
let originalButlerData: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-delivery-guard-"));
  originalButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = tempDir;
});

afterEach(() => {
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  rmSync(tempDir, { recursive: true, force: true });
});

const action: OutboundAction = {
  actionId: "report-1",
  transport: "mock",
  accountId: "default",
  peer: { kind: "dm", id: "user-1" },
  message: { text: "final report" },
};

test("delivery guard converts adapter exceptions into retryable delivery failures", async () => {
  let calls = 0;
  const guard = new DeliveryGuard({
    maxAttempts: 2,
    adapters: [{
      id: "mock",
      capabilities: {
        supportsThreads: false,
        supportsMessageEdit: false,
        supportsReactions: false,
        supportsAttachments: false,
        supportsStreamingEdits: false,
        supportsPresence: false,
      },
      async start() {},
      async send() {
        calls += 1;
        throw new Error("Remote Bad Request: message is too long");
      },
    }],
  });

  const result = await guard.deliver("butler/main", action, { notificationId: "planned-report-1" });

  expect(calls).toBe(2);
  expect(result).toMatchObject({
    actionId: "report-1",
    ok: false,
    error: "Remote Bad Request: message is too long",
  });
});

test("delivery guard deduplicates successful deliveries by session and action", async () => {
  let calls = 0;
  const guard = new DeliveryGuard({
    adapters: [{
      id: "mock",
      capabilities: {
        supportsThreads: false,
        supportsMessageEdit: false,
        supportsReactions: false,
        supportsAttachments: false,
        supportsStreamingEdits: false,
        supportsPresence: false,
      },
      async start() {},
      async send() {
        calls += 1;
        return { ok: true, transportMessageId: String(calls) };
      },
    }],
  });

  const first = await guard.deliver("butler/main", action);
  const second = await guard.deliver("butler/main", action);

  expect(first).toMatchObject({ ok: true, transportMessageId: "1" });
  expect(second).toMatchObject({ ok: true, duplicate: true });
  expect(calls).toBe(1);
});

test("duplicate non-App and unclaimed App deliveries keep the historical transcript cardinality", async () => {
  const guard = new DeliveryGuard({
    butlerData: tempDir,
    adapters: [{
      id: "mock",
      capabilities: {
        supportsThreads: false,
        supportsMessageEdit: false,
        supportsReactions: false,
        supportsAttachments: false,
        supportsStreamingEdits: false,
        supportsPresence: false,
      },
      async start() {},
      async send() {
        return { ok: true };
      },
    }, {
      id: "app",
      capabilities: {
        supportsThreads: false,
        supportsMessageEdit: false,
        supportsReactions: false,
        supportsAttachments: false,
        supportsStreamingEdits: false,
        supportsPresence: false,
      },
      async start() {},
      async send() {
        return { ok: true };
      },
    }],
  });
  const nonAppAction = { ...action, actionId: "generic-duplicate" };
  await guard.deliver("butler/main", nonAppAction);
  const transcriptPath = join(tempDir, "transcripts", "butler_main.jsonl");
  const afterNonApp = readFileSync(transcriptPath, "utf8").trim().split("\n").length;
  const duplicateNonApp = await guard.deliver("butler/main", nonAppAction);
  const afterNonAppDuplicate = readFileSync(transcriptPath, "utf8").trim().split("\n").length;

  const unclaimedAppAction: OutboundAction = {
    ...action,
    actionId: "unclaimed-app-duplicate",
    transport: "app",
  };
  await guard.deliver("butler/main", unclaimedAppAction);
  const afterUnclaimedApp = readFileSync(transcriptPath, "utf8").trim().split("\n").length;
  const duplicateUnclaimedApp = await guard.deliver("butler/main", unclaimedAppAction);
  const afterUnclaimedAppDuplicate = readFileSync(transcriptPath, "utf8").trim().split("\n").length;

  expect(duplicateNonApp).toMatchObject({ ok: true, duplicate: true });
  expect(duplicateUnclaimedApp).toMatchObject({ ok: true, duplicate: true });
  expect(afterNonAppDuplicate).toBe(afterNonApp);
  expect(afterUnclaimedAppDuplicate).toBe(afterUnclaimedApp);
});

test("duplicate claimed App delivery records the replay claim for projection", async () => {
  const guard = new DeliveryGuard({
    butlerData: tempDir,
    adapters: [{
      id: "app",
      capabilities: {
        supportsThreads: false,
        supportsMessageEdit: false,
        supportsReactions: false,
        supportsAttachments: false,
        supportsStreamingEdits: false,
        supportsPresence: false,
      },
      async start() {},
      async send() {
        return { ok: true };
      },
    }],
  });
  const claimedAppAction: OutboundAction = {
    ...action,
    actionId: "claimed-app-replay",
    transport: "app",
    metadata: {
      kind: "final_result",
      appQueueClaimId: "app-session-queue:123:claimed-replay",
      appQueueClaimProvenance: "matching_app_target",
    },
  };
  const first = await guard.deliver("butler/main", claimedAppAction);
  const transcriptPath = join(tempDir, "transcripts", "butler_main.jsonl");
  const afterFirst = readFileSync(transcriptPath, "utf8").trim().split("\n").length;
  const second = await guard.deliver("butler/main", claimedAppAction);
  const afterSecond = readFileSync(transcriptPath, "utf8").trim().split("\n").length;

  expect(first).toMatchObject({ ok: true });
  expect(first.duplicate).toBeUndefined();
  expect(second).toMatchObject({ ok: true, duplicate: true });
  expect(afterSecond).toBe(afterFirst + 2);
});

test("forged App claim metadata keeps historical duplicate transcript cardinality", async () => {
  const guard = new DeliveryGuard({
    butlerData: tempDir,
    adapters: [{
      id: "app",
      capabilities: {
        supportsThreads: false,
        supportsMessageEdit: false,
        supportsReactions: false,
        supportsAttachments: false,
        supportsStreamingEdits: false,
        supportsPresence: false,
      },
      async start() {},
      async send() {
        return { ok: true };
      },
    }],
  });
  const forged: OutboundAction = {
    ...action,
    actionId: "forged-app-claim",
    transport: "app",
    metadata: {
      kind: "final_result",
      appQueueClaimId: "app-session-queue:123:forged",
    },
  };
  const first = await guard.deliver("butler/main", forged);
  const transcriptPath = join(tempDir, "transcripts", "butler_main.jsonl");
  const afterFirst = readFileSync(transcriptPath, "utf8").trim().split("\n").length;
  const second = await guard.deliver("butler/main", forged);
  const afterSecond = readFileSync(transcriptPath, "utf8").trim().split("\n").length;

  expect(first).toMatchObject({ ok: true });
  expect(second).toMatchObject({ ok: true, duplicate: true });
  expect(afterSecond).toBe(afterFirst);
});

test("delivery guard writes transcripts to its explicit Butler data owner", async () => {
  const ownedData = join(tempDir, "owned-runtime");
  const guard = new DeliveryGuard({
    butlerData: ownedData,
    adapters: [{
      id: "mock",
      capabilities: {
        supportsThreads: false,
        supportsMessageEdit: false,
        supportsReactions: false,
        supportsAttachments: false,
        supportsStreamingEdits: false,
        supportsPresence: false,
      },
      async start() {},
      async send() {
        return { ok: true };
      },
    }],
  });

  await guard.deliver("butler/main", action);

  const transcript = join(ownedData, "transcripts", "butler_main.jsonl");
  expect(existsSync(transcript)).toBe(true);
  expect(readFileSync(transcript, "utf8")).toContain('"kind":"outbound"');
});

test("delivery guard skips metadata-only activity for plain transports", async () => {
  let calls = 0;
  const guard = new DeliveryGuard({
    adapters: [{
      id: "mock",
      capabilities: {
        supportsThreads: false,
        supportsMessageEdit: false,
        supportsReactions: false,
        supportsAttachments: false,
        supportsStreamingEdits: false,
        supportsPresence: false,
      },
      async start() {},
      async send() {
        calls += 1;
        return { ok: true, transportMessageId: String(calls) };
      },
    }],
  });

  const result = await guard.deliver("butler/main", {
    actionId: "progress-1",
    transport: "mock",
    accountId: "default",
    peer: { kind: "dm", id: "user-1" },
    message: { text: "" },
    metadata: {
      kind: "tool_progress",
      toolName: "Bash",
      safeLabel: "Bash: bun test",
    },
  });

  expect(result).toMatchObject({ actionId: "progress-1", ok: true });
  expect(calls).toBe(0);
});

test("delivery guard skips metadata-only turn events for aggregate fallback transports", async () => {
  let calls = 0;
  const guard = new DeliveryGuard({
    adapters: [{
      id: "mock",
      capabilities: {
        supportsThreads: false,
        supportsMessageEdit: false,
        supportsReactions: false,
        supportsAttachments: false,
        supportsStreamingEdits: false,
        supportsPresence: false,
        supportsFinalAggregateOnly: true,
      },
      async start() {},
      async send() {
        calls += 1;
        return { ok: true, transportMessageId: String(calls) };
      },
    }],
  });

  const result = await guard.deliver("butler/main", {
    actionId: "turn-event-1",
    transport: "mock",
    accountId: "default",
    peer: { kind: "dm", id: "user-1" },
    message: { text: "" },
    metadata: {
      kind: "turn_event",
      eventKind: "guard.completed",
    },
  });

  expect(result).toMatchObject({ actionId: "turn-event-1", ok: true });
  expect(calls).toBe(0);
});
