import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  agentBtccStoragePaths,
  validateAgentBtccStorageForReadiness,
} from "../../packages/butler-agent/src/agent/adapters/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { migrateBtccSchema } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/migrate-schema.ts";
import {
  prepareAgentStorageForNativeServiceLaunch,
  restartNativeServicesAfterStoragePreparation,
} from
  "../../packages/butler-agent/src/operations/service/native-service-storage-preparation.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "btcc-storage-lifecycle-"));
  roots.push(value);
  return value;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("fresh service launch prepares split storage without quiescing App Gateway", async () => {
  const butlerData = root();
  let quiesceCalls = 0;

  await prepareAgentStorageForNativeServiceLaunch({
    butlerData,
    runtimeVersion: "test-split-v1",
    quiesceLegacyWriter: async () => {
      quiesceCalls += 1;
    },
  });

  expect(quiesceCalls).toBe(0);
  expect(validateAgentBtccStorageForReadiness({ butlerData }).storageContract)
    .toBe("split-v1");
  expect(existsSync(join(butlerData, "locks", "app-gateway-migration-fence")))
    .toBeFalse();
});

test("existing valid split storage starts without quiescing App Gateway", async () => {
  const butlerData = root();
  const prepare = () => prepareAgentStorageForNativeServiceLaunch({
    butlerData,
    runtimeVersion: "test-split-v1",
    quiesceLegacyWriter: async () => {
      throw new Error("existing split storage must not quiesce App Gateway");
    },
  });

  await prepare();
  await prepare();
  expect(validateAgentBtccStorageForReadiness({ butlerData }).storageContract)
    .toBe("split-v1");
});

test("service lifecycle fences the actual legacy writer and parks claims before publish", async () => {
  const butlerData = root();
  const paths = agentBtccStoragePaths(butlerData);
  mkdirSync(join(butlerData, "app-server"), { recursive: true });
  const source = new Database(paths.legacyAppDbPath, { create: true });
  source.exec(BTCC_SUCCESSOR_SCHEMA);
  migrateBtccSchema(source);
  source.query(`INSERT INTO btcc_inbound_inbox
    (inbox_id, session_id, trigger_key, turn_id, admission_input_hash, command_json, status)
    VALUES ('inbox-active', 'session', 'trigger', 'turn', 'hash', '{}', 'pending')`).run();
  source.query(`INSERT INTO btcc_runtime_owners
    (owner_id, host_id, process_id, process_started_at_ms, owner_generation,
      status, registered_at)
    VALUES ('owner-active', 'host', 1, 1, 1, 'active', 'now')`).run();
  source.query(`INSERT INTO btcc_admission_claims
    (claim_id, inbox_id, owner_id, owner_generation, lease_generation, status)
    VALUES ('claim-active', 'inbox-active', 'owner-active', 1, 1, 'active')`).run();
  source.close();
  const sourceBefore = sha256(paths.legacyAppDbPath);
  let quiesced = false;

  await prepareAgentStorageForNativeServiceLaunch({
    butlerData,
    runtimeVersion: "test-split-v1",
    quiesceLegacyWriter: async () => {
      expect(existsSync(join(butlerData, "locks", "app-gateway-migration-fence")))
        .toBeTrue();
      quiesced = true;
    },
  });

  expect(quiesced).toBeTrue();
  expect(sha256(paths.legacyAppDbPath)).toBe(sourceBefore);
  const target = new Database(paths.agentBtccDbPath, { readonly: true });
  try {
    expect(target.query("SELECT status FROM btcc_admission_claims WHERE claim_id = 'claim-active'").get())
      .toEqual({ status: "relinquished" });
  } finally {
    target.close();
  }
});

test("standalone restart preserves writer state until bounded storage preparation", async () => {
  const calls: string[] = [];
  const result = await restartNativeServicesAfterStoragePreparation({
    prepareStorage: async () => { calls.push("prepare"); },
    stopServices: () => { calls.push("stop"); },
    startServices: () => {
      calls.push("start");
      return "started";
    },
  });

  expect(calls).toEqual(["prepare", "stop", "start"]);
  expect(result).toBe("started");
});
