import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAgentBtccStorage, activateAgentBtccStorage } from
  "../../packages/butler-agent/src/agent/adapters/index.ts";
import { createProductionBtccComposition } from
  "../../packages/butler-agent/src/agent/composition/index.ts";
import { AppServerStore } from
  "../../packages/butler-agent/src/gateways/app/application/store/app-server-store.ts";
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
  const app = new AppServerStore({ dbPath: appDbPath, butlerData });
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
  const appPath = join(root, "app.sqlite");
  const agentPath = join(root, "agent.sqlite");
  const app = new Database(appPath, { create: true });
  const agent = new Database(agentPath, { create: true });
  app.exec("CREATE TABLE projection (id TEXT PRIMARY KEY)");
  agent.exec("CREATE TABLE checkpoint (id TEXT PRIMARY KEY)");
  try {
    app.exec("BEGIN IMMEDIATE");
    agent.query("INSERT INTO checkpoint (id) VALUES (?)").run("route-checkpoint");
    app.exec("ROLLBACK");

    agent.exec("BEGIN IMMEDIATE");
    app.query("INSERT INTO projection (id) VALUES (?)").run("app-projection");
    agent.exec("ROLLBACK");
    expect(app.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM projection").get()?.count)
      .toBe(1);
  } finally {
    agent.close();
    app.close();
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
