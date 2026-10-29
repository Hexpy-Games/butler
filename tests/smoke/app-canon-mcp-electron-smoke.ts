// test-category: security
// Real dev Electron, preload and authenticated native gateway; no renderer bridge replacement.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnElectron, stopElectronChild } from "../support/electron-child.ts";
import { electronPage, type ElectronPage } from "../support/electron-page-cdp.ts";
import { createNativeAppServer, freePort } from "../support/native-app-server.ts";
import { smokeElectronArgs } from "../support/smoke-browser.ts";
import type { CanonGrant } from "../../packages/butler-app/client/ui/src/app/canonTrust.ts";

const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE;
assert(executable, "Set BUTLER_SMOKE_ELECTRON_EXECUTABLE to the installed Electron executable");
const scratch = mkdtempSync(join(tmpdir(), "canon-mcp-electron-"));
const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
let child: ReturnType<typeof spawnElectron> | undefined;
let page: ElectronPage | undefined;
const headers = { "X-Butler-Delegate-Client": "Local Tool", "X-Butler-Delegate-Client-Name": "local-tool" };
try {
  const debug = await freePort();
  child = spawnElectron(executable, [`--remote-debugging-port=${debug}`, ...smokeElectronArgs(),
    resolve("packages/butler-app/client/electron")], { env: { ...process.env,
    HOME: join(scratch, "home"), BUTLER_HOME: join(scratch, "home"), BUTLER_DATA: server.butlerData,
    BUTLER_APP_ELECTRON_USER_DATA_DIR: join(scratch, "profile"), BUTLER_APP_UI_URL: "",
    BUTLER_APP_RENDERER_DIST: resolve("packages/butler-app/client/ui/dist"),
    BUTLER_APP_SERVER_URL: server.url, BUTLER_APP_SERVER_PORT: String(server.port),
    BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1",
  } });
  page = await electronPage(debug);
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class~="mac-window"]')));
  const request = () => fetch(new URL("canon/list", server.url), { headers: { ...server.authHeaders, ...headers } });
  assert.equal((await request()).status, 403);
  type Result<T> = { ok: boolean; data: T };
  const grants = async (state?: string) => {
    const result = await page!.expression<Result<{ grants: CanonGrant[] }>>(
      `window.butlerApp.getCanonGrants(${JSON.stringify({ state })})`);
    assert.equal(result.ok, true);
    return result.data.grants;
  };
  const pending = await grants("pending");
  assert.equal(pending.length, 1);
  const id = pending[0]!.id;
  for (const action of ["allow", "revoke", "deny"]) {
    if (action === "deny") assert.equal((await request()).status, 403);
    const result: Result<unknown> = await page.expression<Result<unknown>>(
      `window.butlerApp.decideCanonGrant(${JSON.stringify({ id, action })})`);
    assert.equal(result.ok, true, `Real preload POST grant ${action}`);
    const expected = action === "allow" ? "allowed" : action === "deny" ? "denied" : "revoked";
    const current = (await grants()).find(grant => grant.id === id);
    assert.equal(current?.state, expected);
    const delegated = await fetch(new URL(`canon/mcp-grants/${id}/${action}`, server.url), {
      method: "POST", headers: { ...server.authHeaders, ...headers, "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(delegated.status, 403, "Grant decisions remain app-only");
  }
  assert.equal((await fetch(new URL("canon/mcp-grants", server.url), {
    headers: { ...server.authHeaders, ...headers },
  })).status, 403);
  console.log(JSON.stringify({ result: "PASS", electron: true, preload: true,
    grantReads: ["all", "pending"], grantDecisions: ["allow", "revoke", "deny"], delegatedStatus: 403 }));
} finally {
  page?.close();
  if (child) await stopElectronChild(child);
  await server.stop();
  rmSync(scratch, { recursive: true, force: true });
}
