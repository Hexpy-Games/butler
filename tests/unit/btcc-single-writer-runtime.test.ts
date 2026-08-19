import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAgentBtccStorage, activateAgentBtccStorage } from
  "../../packages/butler-agent/src/agent/adapters/index.ts";
import { createProductionBtccComposition } from
  "../../packages/butler-agent/src/agent/composition/index.ts";
import { AppServerStore } from
  "../../packages/butler-agent/src/gateways/app/application/store/app-server-store.ts";
import { EMPTY_STEWARD_OBSERVER } from "./support/steward-observer.ts";
import {
  appManagedRuntimePointerPath,
  resolveAppManagedNativeSupervisorPaths,
} from "../../packages/butler-agent/src/operations/service/native-service-supervisor.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test("live App and Agent compositions hold distinct writable SQLite inodes", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-single-writer-"));
  roots.push(butlerData);
  const appDbPath = join(butlerData, "app-server", "butler-client.sqlite");
  mkdirSync(join(butlerData, "app-server"), { recursive: true });
  const app = new AppServerStore({
    dbPath: appDbPath,
    butlerData,
    stewardObserver: EMPTY_STEWARD_OBSERVER,
  });
  await prepareAgentBtccStorage({
    butlerData,
    quiesceLegacyWriter: async () => ({
      fenceId: "test-pre-readiness-fence",
      reconciledClaims: 0,
      parkedClaims: 0,
    }),
  });
  activateAgentBtccStorage({ butlerData, runtimeVersion: "test-split-v1" });
  const agentDbPath = join(butlerData, "agent-runtime", "btcc.sqlite");
  const agent = createProductionBtccComposition({
    butlerHome: process.cwd(),
    butlerData,
    ownerId: `single-writer-test:${process.pid}`,
  });
  await agent.ready;
  try {
    const appIdentity = statSync(appDbPath);
    const agentIdentity = statSync(agentDbPath);
    expect(`${appIdentity.dev}:${appIdentity.ino}`).not.toBe(
      `${agentIdentity.dev}:${agentIdentity.ino}`,
    );
    const writablePaths = [
      appDbPath,
      agentDbPath,
      join(butlerData, "runtime", "conversation-store.sqlite"),
      join(butlerData, "runtime", "session-store.sqlite"),
    ].filter(existsSync);
    const identities = writablePaths.map((path) => {
      const identity = statSync(path);
      return `${identity.dev}:${identity.ino}`;
    });
    expect(new Set(identities).size).toBe(identities.length);
    expect(tableNames(app.db)).not.toContain("btcc_turns");
    const agentDb = new Database(agentDbPath, { readonly: true });
    try {
      expect(tableNames(agentDb)).toContain("btcc_turns");
      expect(tableNames(agentDb)).not.toContain("chats");
    } finally {
      agentDb.close();
    }
  } finally {
    await agent.host.close();
    app.close();
  }
});

test("App and Agent writes are reciprocally independent under BEGIN IMMEDIATE", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-reciprocal-lock-"));
  roots.push(root);
  const appPath = join(root, "app-server", "butler-client.sqlite");
  mkdirSync(join(root, "app-server"), { recursive: true });
  const appStore = new AppServerStore({
    dbPath: appPath,
    butlerData: root,
    stewardObserver: EMPTY_STEWARD_OBSERVER,
  });
  await prepareAgentBtccStorage({
    butlerData: root,
    quiesceLegacyWriter: async () => ({
      fenceId: "test-reciprocal-fence",
      reconciledClaims: 0,
      parkedClaims: 0,
    }),
  });
  activateAgentBtccStorage({ butlerData: root, runtimeVersion: "test-split-v1" });
  const agentPath = join(root, "agent-runtime", "btcc.sqlite");
  const agent = new Database(agentPath);
  try {
    appStore.db.exec("BEGIN IMMEDIATE");
    agent.query(`
      INSERT INTO btcc_context_documents (
        context_ref, content_sha256, scope_kind, scope_id, projection_class,
        source_id, source_revision, content, created_at
      ) VALUES ('lock-agent', 'sha', 'session', 's', 'turn', 'src', '1', 'x', 'now')
    `).run();
    appStore.db.exec("ROLLBACK");

    agent.exec("BEGIN IMMEDIATE");
    appStore.db.query(`
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES ('lock-app', '{}', 'now')
    `).run();
    agent.exec("ROLLBACK");
    expect(appStore.db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM app_settings WHERE key = 'lock-app'",
    ).get()?.count)
      .toBe(1);
  } finally {
    agent.close();
    appStore.close();
  }
});

test("activation rejects automatic selection of a split-unaware App-managed runtime", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-split-runtime-"));
  roots.push(butlerData);
  await prepareAgentBtccStorage({
    butlerData,
    quiesceLegacyWriter: async () => ({
      fenceId: "test-pre-readiness-fence",
      reconciledClaims: 0,
      parkedClaims: 0,
    }),
  });
  activateAgentBtccStorage({ butlerData, runtimeVersion: "test-split-v1" });

  const runtimeLabel = join("app", "runtime", "agent", "versions", "1.2.3");
  const runtimeHome = join(butlerData, runtimeLabel);
  const localAuthFile = join(butlerData, "app", "runtime", "auth", "local-agent-auth.json");
  mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
  mkdirSync(join(butlerData, "app", "runtime", "auth"), { recursive: true });
  writeFileSync(appManagedRuntimePointerPath(butlerData), `${JSON.stringify({
    schema: "butler.app-managed-agent-runtime-pointer.v1",
    product: "butler-app",
    gateway_profile: "electron",
    runtime_home: runtimeLabel,
    version: "1.2.3",
  })}\n`);
  writeFileSync(localAuthFile, `${JSON.stringify({
    schema: "butler.app-local-agent-auth.v1",
    token: "abcdefghijklmnopqrstuvwxyz123456",
  })}\n`);

  expect(() => resolveAppManagedNativeSupervisorPaths({ butlerData, localAuthFile }))
    .toThrow("restore the pre-cutover snapshot");

  const contractDir = join(runtimeHome, "packages", "butler-agent", "resources", "runtime");
  mkdirSync(contractDir, { recursive: true });
  writeFileSync(join(contractDir, "storage-contract"), "split-v1\n");
  expect(resolveAppManagedNativeSupervisorPaths({ butlerData, localAuthFile }).butlerHome)
    .toBe(runtimeHome);
});

test("automatic runtime selection fails closed when activation state is unreadable", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-unreadable-activation-"));
  roots.push(butlerData);
  const agentRuntime = join(butlerData, "agent-runtime");
  mkdirSync(agentRuntime, { recursive: true });
  writeFileSync(join(agentRuntime, "btcc.sqlite"), "not-a-sqlite-database");
  const runtimeLabel = join("app", "runtime", "agent", "versions", "1.2.3");
  const localAuthFile = join(butlerData, "app", "runtime", "auth", "local-agent-auth.json");
  mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
  mkdirSync(join(butlerData, "app", "runtime", "auth"), { recursive: true });
  writeFileSync(appManagedRuntimePointerPath(butlerData), `${JSON.stringify({
    schema: "butler.app-managed-agent-runtime-pointer.v1",
    product: "butler-app",
    gateway_profile: "electron",
    runtime_home: runtimeLabel,
  })}\n`);
  writeFileSync(localAuthFile, `${JSON.stringify({
    schema: "butler.app-local-agent-auth.v1",
    token: "abcdefghijklmnopqrstuvwxyz123456",
  })}\n`);

  expect(() => resolveAppManagedNativeSupervisorPaths({ butlerData, localAuthFile }))
    .toThrow("agent_btcc_storage_activation_state_unreadable");
});

function tableNames(db: Database): string[] {
  return db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all().map((row) => row.name);
}
