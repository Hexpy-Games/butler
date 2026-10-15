/** Stub tool → exact approval → Vite → content proxy → native Browser and mobile Artifacts. */
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import type { Page } from "playwright";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub, bridgeBrowser } from "../support/browser-agent-stub";
import { freePort } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const stub = browserStub();
const browser = await launchSmokeBrowser();
const app = await browserAgentApp(evidence, stub.handler).catch(async (error) => { await browser.close(); throw error; });
const port = await freePort();
const vite = pathToFileURL(Bun.resolveSync("vite", resolve("packages/butler-app/client/ui"))).href;
const runner = `import {createServer} from ${JSON.stringify(vite)};
const server=await createServer({root:process.cwd(),configFile:false,server:{host:"127.0.0.1",port:${port},strictPort:true},optimizeDeps:{noDiscovery:true}});
await server.listen();`;
type Approval = { request_ref: string; approval: { operation: { tool: string; command: string; targets: string[] } } };
let session = "";
let mobilePage: Page | undefined;
async function send(text: string) {
  await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: session, text, client_message_id: crypto.randomUUID() }) });
}
const delivered = () => waitBrowser(async () => (await app.gateway.api<{ latest_turn?: { state: string } }>(`/session-view?session_id=${session}`)).latest_turn?.state === "delivered", "preview turn delivered");
async function reviewed(name: string, args: Record<string, unknown>, target: string) {
  stub.set([
    () => ({ name: "tool_describe", arguments: { ids: [`native:${name}`] } }),
    () => bridgeBrowser(name, args),
  ]);
  await send(`${name} fixture`);
  const requests = () => app.gateway.api<{ requests: Approval[] }>(`/authority-requests?session_id=${session}`);
  await waitBrowser(async () => (await requests()).requests.length === 1, `${name} approval`);
  const approval = (await requests()).requests[0]!;
  assert.equal(approval.approval.operation.tool, name);
  assert.deepEqual(approval.approval.operation.targets, [target]);
  if (name === "preview_start") assert.equal(approval.approval.operation.command, args.command);
  await app.gateway.api(`/authority-requests/${approval.request_ref}/allow?session_id=${session}`, { method: "POST", body: JSON.stringify({ scope: "once" }) });
  await delivered();
}
function toolResult() {
  const db = new Database(join(app.gateway.butlerData, "agent-runtime/btcc.sqlite"), { readonly: true });
  try {
    const rows = db.query("SELECT result_json FROM btcc_guided_tool_calls WHERE result_json LIKE '%preview_id%' ORDER BY rowid DESC").all() as Array<{ result_json: string }>;
    for (const row of rows) {
      const result = JSON.parse(row.result_json);
      if (result.status === "ok" && result.preview_id) return result as { preview_id: string; pid: number; url: string; browser: { tab: string } };
    }
    throw new Error("Preview tool returned no successful receipt");
  } finally { db.close(); }
}
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: "light", access_mode: "full_access" }) });
  const created = await app.gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Preview task" }) });
  session = created.session.id;
  await app.page.reload();
  await app.page.waitForFunction(() => [...document.querySelectorAll('[data-test-class="app-sidebar"] button,[data-test-class="app-sidebar"] [role="button"]')].some(node => node.textContent?.includes("Preview task")));
  await app.page.clickText("Preview task", '[data-test-class="app-sidebar"] button,[data-test-class="app-sidebar"] [role="button"]');
  await app.call("open");
  await app.click("브라우저");
  await app.shot("browser-before");
  await app.page.clickText("Preview task", '[data-test-class="app-sidebar"] button,[data-test-class="app-sidebar"] [role="button"]');
  stub.set([
    ...[["index.html", readFileSync(resolve("tests/fixtures/browser/preview/index.html"), "utf8")],
      ["main.js", readFileSync(resolve("tests/fixtures/browser/preview/main.js"), "utf8")], ["serve.mjs", runner]].map(([file, content]) =>
      () => ({ name: "write_file", arguments: { path: `preview-fixture/${file}`, content, create_parents: true } })),
    () => ({ name: "tool_describe", arguments: { ids: ["native:preview_start", "native:preview_stop"] } }),
    () => bridgeBrowser("preview_start", { command: "bun serve.mjs", cwd: "preview-fixture", port }),
  ]);
  await send("Start the fixture preview");
  const requests = () => app.gateway.api<{ requests: Approval[] }>(`/authority-requests?session_id=${session}`);
  await waitBrowser(async () => (await requests()).requests.length === 1, "exact preview approval");
  const approval = (await requests()).requests[0]!;
  assert.equal(approval.approval.operation.command, "bun serve.mjs");
  const cwd = approval.approval.operation.targets[0]!;
  assert.ok(cwd.endsWith("/preview-fixture") && cwd.startsWith("/"));
  assert.equal(await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false), false, "no process before approval");
  await app.shot("approval-command-cwd");
  await app.gateway.api(`/authority-requests/${approval.request_ref}/allow?session_id=${session}`, { method: "POST", body: JSON.stringify({ scope: "once" }) });
  await delivered();
  const result = toolResult();
  const tab = result.browser.tab;
  assert.ok(tab);
  await app.click("브라우저"); await app.call("activate", { id: tab });
  const contents = `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).view.webContents`;
  await waitBrowser(() => app.main(`${contents}.executeJavaScript("document.querySelector('#status')?.textContent==='Initial'")`), "native Vite ready");
  await app.page.waitForFunction(() => [...document.querySelectorAll('[data-test-class="browser-preview-tag"]')].some(node => node.textContent === "미리보기"));
  const nativeDocument = await app.main(`${contents}.executeJavaScript("window.previewDocument")`);
  await app.shot("browser-light-initial");
  const page = mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await app.gateway.signIn(page); await page.goto(app.gateway.url);
  await page.getByRole("button", { name: "사이드바 보기", exact: true }).click();
  await page.locator('[data-test-class="app-sidebar"]').getByText("Preview task", { exact: true }).click();
  await page.getByRole("button", { name: "오른쪽 패널 보기", exact: true }).click();
  await page.getByRole("button", { name: "아티팩트", exact: true }).click();
  await page.getByRole("button", { name: "열기: 미리보기", exact: true }).click();
  const frame = page.frameLocator('[data-test-class="artifact-viewer"] iframe');
  await frame.locator("#status").filter({ hasText: "Initial" }).waitFor();
  const child = page.frames().find(item => item.url() === `http://127.0.0.1:${app.gateway.port + 1}/`)!;
  assert.ok(child);
  const mobileDocument = await child.evaluate(() => (window as unknown as { previewDocument: string }).previewDocument);
  await page.screenshot({ path: join(evidence, "artifacts-mobile-initial.png") });
  const source = readFileSync(join(cwd, "main.js"), "utf8").replace("Initial", "Updated");
  writeFileSync(join(cwd, "main.js"), source);
  await waitBrowser(() => app.main(`${contents}.executeJavaScript("document.querySelector('#status')?.textContent==='Updated'")`), "native HMR update");
  await frame.locator("#status").filter({ hasText: "Updated" }).waitFor();
  assert.equal(await app.main(`${contents}.executeJavaScript("window.previewDocument")`), nativeDocument, "native HMR preserves document");
  assert.equal(await child.evaluate(() => (window as unknown as { previewDocument: string }).previewDocument), mobileDocument, "mobile HMR preserves document");
  for (const width of [320, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.locator('[data-test-class="artifact-viewer"] iframe').evaluate(node => node.getBoundingClientRect().right <= innerWidth), "preview fits mobile width");
    await page.screenshot({ path: join(evidence, `artifacts-mobile-${width}-hmr.png`) });
  }
  await app.shot("browser-light-hmr");
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: "dark" }) });
  await app.shot("browser-dark-hmr");
  await page.screenshot({ path: join(evidence, "artifacts-mobile-dark-hmr.png") });
  await reviewed("preview_stop", { preview_id: result.preview_id }, result.preview_id);
  await waitBrowser(() => app.main(`!globalThis.browserAgentSubject.tabs.has(${JSON.stringify(tab)})`), "stop closes preview tab");
  assert.equal(await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false), false, "stop terminates Vite");
  await reviewed("preview_start", { command: "bun serve.mjs", cwd: "preview-fixture", port }, cwd);
  const restarted = toolResult();
  assert.notEqual(restarted.preview_id, result.preview_id);
  const archiveTab = restarted.browser.tab;
  assert.ok(archiveTab);
  await app.gateway.api(`/sessions/${session}/archive`, { method: "POST", body: "{}" });
  await waitBrowser(() => app.main(`!globalThis.browserAgentSubject.tabs.has(${JSON.stringify(archiveTab)})`), "archive closes preview tab");
  assert.equal(await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false), false, "archive terminates Vite");
  writeFileSync(join(evidence, "acceptance.json"), JSON.stringify({ nativeHmr: true, mobileHmr: true, mobileWidths: [320, 375, 390, 430], stop: true, archive: true, command: approval.approval.operation.command, cwd, previewId: result.preview_id }, null, 2));
} catch (error) {
  await app.shot("failure").catch(() => {});
  await mobilePage?.screenshot({ path: join(evidence, "failure-mobile.png") }).catch(() => {});
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), dom: await app.page.expression("document.body.innerText").catch(() => null), mobile: await mobilePage?.locator("body").innerText().catch(() => null) }));
  throw error;
} finally { await browser.close(); await app.stop(); }
