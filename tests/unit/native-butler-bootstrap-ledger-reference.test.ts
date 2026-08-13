import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runNativeButlerMain } from "../../packages/butler-agent/src/application/native-butler.ts";
import { prepareAgentStorageForNativeServiceLaunch } from
  "../../packages/butler-agent/src/operations/service/native-service-storage-preparation.ts";
import type { ModelProviderAdapter } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const provider: ModelProviderAdapter = {
  id: "test-provider",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: false,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: false,
  },
  async invoke() {
    return { text: "unused" };
  },
};

test("service lifecycle migration precedes Native Butler readiness and opens only Agent storage", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-bootstrap-ledger-"));
  roots.push(butlerData);
  mkdirSync(join(butlerData, "app-server"), { recursive: true });
  await prepareAgentStorageForNativeServiceLaunch({
    butlerData,
    runtimeVersion: "test-split-v1",
    quiesceLegacyWriter: async () => {},
  });
  const result = await runNativeButlerMain({
    butlerHome: process.cwd(),
    butlerData,
    provider,
    enableTelegramPolling: false,
    waitForShutdown: false,
  });

  expect(result.shutdownReason).toBe("bootstrap-only");
  const db = new Database(join(butlerData, "agent-runtime", "btcc.sqlite"), {
    readonly: true,
  });
  try {
    expect(db.query<{ name: string }, []>(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'btcc_turns'
    `).get()?.name).toBe("btcc_turns");
  } finally {
    db.close();
  }
  const appDbPath = join(butlerData, "app-server", "butler-client.sqlite");
  if (!existsSync(appDbPath)) return;
  const appDb = new Database(appDbPath, { readonly: true });
  try {
    expect(appDb.query<{ name: string }, []>(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'btcc_turns'
    `).get()).toBeNull();
  } finally {
    appDb.close();
  }
});
