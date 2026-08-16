import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppTransportProjectionOwner } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/transport-projection-owner.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("explicit full projection drains finite batches", async () => {
  const root = createRoot();
  let batches = 0;
  const owner = new AppTransportProjectionOwner({
    butlerData: root,
    syncNextBatch: () => ++batches < 3,
    reopenCompletedLiveLanes: () => undefined,
    recordFailure: () => undefined,
  });

  owner.start();
  expect(batches).toBe(0);
  void owner.syncAndWait();
  await waitUntil(() => batches === 3);
  await Bun.sleep(50);
  expect(batches).toBe(3);
  owner.close();
});

test("one failed pass receives one cooperative recovery pass", async () => {
  const root = createRoot();
  let calls = 0;
  const failures: unknown[] = [];
  const owner = new AppTransportProjectionOwner({
    butlerData: root,
    syncNextBatch: () => {
      calls += 1;
      if (calls === 1) throw new Error("projection failed");
      return false;
    },
    reopenCompletedLiveLanes: () => undefined,
    recordFailure: (error) => {
      failures.push(error);
    },
  });

  owner.start();
  void owner.syncAndWait();
  await waitUntil(() => failures.length === 1);
  await waitUntil(() => calls === 2);
  expect((failures[0] as Error).message).toBe("projection failed");
  owner.close();
});

test("startup avoids historical transcript scans and follows changed files", async () => {
  const root = createRoot();
  let historicalScans = 0;
  let terminalPasses = 0;
  const changedFiles: string[] = [];
  const owner = new AppTransportProjectionOwner({
    butlerData: root,
    syncNextBatch: () => {
      historicalScans += 1;
      return false;
    },
    syncChangedTranscript: (fileName) => {
      changedFiles.push(fileName);
      return false;
    },
    syncTerminalQueue: () => {
      terminalPasses += 1;
      return false;
    },
    reopenCompletedLiveLanes: () => undefined,
    recordFailure: () => undefined,
  });

  owner.start();
  await waitUntil(() => terminalPasses === 1);
  expect(historicalScans).toBe(0);
  writeFileSync(join(root, "transcripts", "butler_app-live.jsonl"), "{}\n");
  await waitUntil(() => changedFiles.length === 1);
  expect(changedFiles).toEqual(["butler_app-live.jsonl"]);
  expect(historicalScans).toBe(0);
  owner.close();
});

test("startup catches up only transcripts belonging to open turns", async () => {
  const root = createRoot();
  const changedFiles: string[] = [];
  const owner = new AppTransportProjectionOwner({
    butlerData: root,
    syncNextBatch: () => false,
    openTurnTranscriptFiles: () => ["butler_app-open.jsonl"],
    syncChangedTranscript: (fileName) => {
      changedFiles.push(fileName);
      return false;
    },
    syncTerminalQueue: () => false,
    reopenCompletedLiveLanes: () => undefined,
    recordFailure: () => undefined,
  });

  owner.start();
  await waitUntil(() => changedFiles.length === 1);
  expect(changedFiles).toEqual(["butler_app-open.jsonl"]);
  owner.close();
});


function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "butler-transport-owner-"));
  roots.push(root);
  return root;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
