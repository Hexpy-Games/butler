// Startup filesystem harness: the real observer receives private progress changes.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchStorageCorrection } from "../../packages/butler-app/client/electron/app-storage-correction.mjs";

const root = await mkdtemp(join(tmpdir(), "storage-startup-smoke-"));
let deadline = 0;
let changed = 0;
const observer = watchStorageCorrection(root, (value: number) => { deadline = value; changed++; });
try {
  const directory = join(root, "agent-runtime");
  await mkdir(directory);
  const expires = Date.now() + 180_000;
  const record = JSON.stringify({ schema: "butler.storage-correction-progress.v1", phase: "compact", deadlineAt: new Date(expires).toISOString() });
  const staging = join(directory, "progress.tmp");
  await writeFile(staging, record, { mode: 0o600 });
  await rename(staging, join(directory, "storage-correction.json"));
  const end = Date.now() + 2000;
  while (deadline === 0 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(deadline, expires + 30_000);
  assert.equal(observer.deadline(), deadline);
  observer.close();
  const before = changed;
  await rm(join(directory, "storage-correction.json"));
  await writeFile(join(directory, "storage-correction.json"), record);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(changed, before, "observer must stop when startup finishes");
  console.log("PASS: progress appearance, deadline extension and observer teardown.");
} finally { observer.close(); await rm(root, { recursive: true, force: true }); }
