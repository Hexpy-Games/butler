// Real App MCP rows backed by an isolated native registry; no model calls.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAppCopy } from "../../packages/butler-i18n/src";
import { createNativeAppServer } from "../support/native-app-server";
import { firstRunElectron } from "../support/first-run-electron";
import { nativeSmokeRuntime } from "../support/native-smoke-runtime";

const runtime = await nativeSmokeRuntime(import.meta.url);
if (runtime !== null) process.exit(runtime);
const output = process.env.BUTLER_IMPORT_EVIDENCE;
assert.ok(output, "explicit evidence directory required");
const before = process.env.BUTLER_IMPORT_BEFORE_UI;
const stage = before ? "before" : "after";
const uiRoot = resolve(before ?? "packages/butler-app/client/ui/dist");
process.env.BUTLER_APP_RENDERER_DIST = uiRoot;
mkdirSync(join(output, stage), { recursive: true });
const sourceHome = mkdtempSync(join(tmpdir(), "agent-import-source-"));
mkdirSync(join(sourceHome, ".codex"));
writeFileSync(join(sourceHome, ".codex/config.toml"), `
[mcp_servers.source-on]
command = "unused-on"
enabled = true
[mcp_servers.source-off]
command = "unused-off"
enabled = false
[mcp_servers.needs-key]
command = "unused-key"
enabled = true
env = { API_KEY = "source-value" }
[mcp_servers.filter-review]
command = "unused-filter"
enabled = true
disabled_tools = ["write"]
`);
const server = await createNativeAppServer({ uiRoot, env: { BUTLER_AGENT_IMPORT_HOME: sourceHome } });
let app: Awaited<ReturnType<typeof firstRunElectron>> | undefined;
const captures: string[] = [];
try {
  const { secret } = JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8"));
  const result = await server.api<{ servers: number }>("/security/agent-import/start", {
    method: "POST", headers: { ...server.authHeaders, "x-butler-admin": secret }, body: JSON.stringify({ source: "codex" }),
  });
  assert.equal(result.servers, 4);
  app = await firstRunElectron(server, server.url, '[data-test-class="mac-window"]');
  const page = app.page;
  for (const theme of ["light", "dark"] as const) for (const width of [390, 1440]) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({
      language: "ko", appearance_theme: theme,
    }) });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("app://butler/?settings=mcp");
    const section = page.locator('[data-settings-section-id="mcp-servers"]');
    await section.getByText("filter-review", { exact: true }).waitFor();
    const copy = getAppCopy("ko-KR").settings;
    for (const id of ["source-on", "needs-key"]) {
      const label = `${id}: ${copy.actions.disableMcpServer}`;
      assert.equal(await section.getByRole("switch", { name: label, exact: true }).getAttribute("aria-checked"), "true");
    }
    for (const id of ["source-off", "filter-review"]) {
      const label = `${id}: ${copy.actions.enableMcpServer}`;
      assert.equal(await section.getByRole("switch", { name: label, exact: true }).getAttribute("aria-checked"), "false");
    }
    if (!before) {
      await section.getByText(copy.mcpNeedsSecret, { exact: true }).waitFor();
      await section.getByText(copy.mcpToolFilterReview, { exact: true }).waitFor();
    }
    await section.scrollIntoViewIfNeeded();
    await page.evaluate(async () => { await document.fonts.ready; });
    const name = `mcp-${theme}-${width}.png`;
    await page.screenshot({ path: join(output, stage, name) });
    captures.push(name);
  }
  writeFileSync(join(output, stage, "mcp-manifest.json"), JSON.stringify({ captures, rows: 4, modelCalls: 0 }));
  console.log(JSON.stringify({ ok: true, stage, rows: 4, screenshots: captures.length, modelCalls: 0 }));
} finally {
  await app?.stop();
  await server.stop();
  rmSync(sourceHome, { recursive: true, force: true });
}
