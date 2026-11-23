import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Locator, Page } from "playwright";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy";
import { installMemoryDesktopBridge } from "../support/memory-desktop-bridge";
import { createNativeAppServer, type NativeAppServerHandle } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";

const html = "<!doctype html><title>Smoke page</title>";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const sha = hash(html);
const output = hash("smoke-output");
const capturedAt = "2026-11-22T00:00:00Z";
const item = { id: `output-${output}`, kind: "output", output, title: "Smoke page", url: `/outputs/${output}/view`, capturedAt };
const pageId = "k7m2q9xd4b3hn";
const pageUrl = `https://pages.test/p/${pageId}/`;
const entry = { id: pageId, url: pageUrl, title: item.title, status: "live", size_bytes: html.length,
  file_count: 1, updated_at: capturedAt, source_key: `dev_fake:${item.id}` };
const widths = [320, 375, 390, 430, 768, 1440];

async function startFakeCloud() {
  const account = { id: "acc_fake", email: "user@example.com", created_at: capturedAt };
  const device = { id: "dev_fake", name: "Butler", platform: "macos" };
  const state = { limit: 3 };
  const pages = new Map([
    ["other", { ...entry, id: "other", url: "https://other.butler.page/", title: "Itinerary", source_key: "dev_other:itinerary" }],
    ["taken-down", { ...entry, id: "taken-down", url: "https://taken-down.butler.page/", title: "Budget dashboard",
      source_key: "dev_other:budget", status: "taken_down" }],
  ]);
  const blobs = new Set<string>();
  let version = 0;
  const cloud = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const key = `${request.method} ${request.url}`;
    const json = (data: unknown) => response.end(JSON.stringify(data));
    response.setHeader("content-type", "application/json");
    if (key === "POST /v1/auth/email/start") return response.writeHead(202).end();
    if (key === "POST /v1/auth/email/verify") {
      if (JSON.parse(Buffer.concat(chunks).toString()).code === "123456") return json({ device_token: "bct_fake", account, device });
      return response.writeHead(400).end(JSON.stringify({ error: { code: "code_invalid" } }));
    }
    if (request.headers.authorization !== "Bearer bct_fake") return response.writeHead(401).end();
    if (key === "GET /v1/me") return json({ account, device, entitlements: { plan: "free", status: "active", renews_at: null, features: {} } });
    if (key === "GET /v1/devices") return json({ devices: [{ ...device, created_at: capturedAt, last_seen_at: null, current: true }] });
    if (key === "GET /v1/pages") {
      const listed = Array.from(pages.values());
      return json({ pages: listed, used: listed.filter((row) => row.status === "live").length,
        limit: state.limit, badge: true, page_bytes: 10000000, page_files: 200 });
    }
    if (key === "POST /v1/pages") {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const missing = body.files.map((file: { sha256: string }) => file.sha256).filter((digest: string) => !blobs.has(digest));
      return json({ id: pageId, url: pageUrl, version: ++version, missing });
    }
    if (key === `PUT /v1/pages/${pageId}/blobs/${sha}`) {
      blobs.add(sha);
      return response.writeHead(204).end();
    }
    if (key === `POST /v1/pages/${pageId}/publish`) {
      pages.set(pageId, entry);
      return json({ id: pageId, url: pageUrl, version });
    }
    if (request.method === "DELETE" && request.url?.startsWith("/v1/pages/")) {
      pages.delete(decodeURIComponent(request.url.slice("/v1/pages/".length)));
      return response.writeHead(204).end();
    }
    return response.writeHead(404).end();
  });
  await new Promise<void>((done) => cloud.listen(0, "127.0.0.1", done));
  const address = cloud.address();
  assert(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, state, stop: () => new Promise<void>((done) => cloud.close(() => done())) };
}

type FakeCloud = Awaited<ReturnType<typeof startFakeCloud>>;

function seedOutput(data: string) {
  const manifest = join(data, "outputs/manifests");
  const blobs = join(data, "outputs/blobs", sha.slice(0, 2));
  mkdirSync(manifest, { recursive: true });
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(blobs, sha), html);
  writeFileSync(join(manifest, `${output}.json`), JSON.stringify({ kind: "site", output_id: output, title: item.title,
    session_id: "general", message_id: "smoke", turn_id: "smoke", revisions: [
      { revision: 1, entry: "index.html", files: { "index.html": sha }, size_bytes: html.length, created_at: capturedAt },
    ] }));
}

// The public Library save route accepts scraps and bookmarks. Outputs are written by the agent.
function saveLibraryItem(data: string, published?: { page_id: string; url: string }) {
  const db = new Database(join(data, "app-server/butler-client.sqlite"));
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.run(`INSERT INTO browser_library(id,kind,title,url,payload,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
      [item.id, item.kind, item.title, item.url, JSON.stringify({ ...item, published }), item.capturedAt]);
  } finally { db.close(); }
}

const language = process.env.BUTLER_SMOKE_LANGUAGE ?? "en";
setAppCopyLanguage(language);
const copy = appCopy.publishing;
const account = appCopy.butlerAccount;
const shots = process.env.BUTLER_SMOKE_SHOTS;
const viewport = (width: number) => ({ width, height: 900 });

async function installGatewayRoutes(page: Page, server: NativeAppServerHandle, secret: string, cloud: FakeCloud) {
  const admin = { "x-butler-admin": secret };
  const local = { file_count: 1, size_bytes: html.length };
  const itemPath = `/library/${item.id}/publish`;
  const cloudRequest = (path: string, method = "GET", body?: BodyInit) => fetch(cloud.url + path, {
    method, body, headers: { authorization: "Bearer bct_fake" },
  });
  let releaseUpload: (() => void) | undefined;
  const uploadCapture = shots ? new Promise<void>((done) => { releaseUpload = done; }) : undefined;
  await page.route(`${server.url}**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname !== itemPath && pathname !== "/publishing" && pathname !== "/publishing/pages" && !pathname.startsWith("/publishing/pages/")) {
      const privileged = pathname.startsWith("/setup/butler-account") || pathname.startsWith("/security") || pathname === "/settings";
      await route.continue({ headers: { ...route.request().headers(), ...server.authHeaders, ...(privileged ? admin : {}) } });
      return;
    }
    const respond = (data: unknown) => route.fulfill({ json: { protocol_version: "butler.app.v1", data } });
    const status = await server.api<{ signed_in: boolean }>("/setup/butler-account", { headers: admin });
    if (pathname === "/publishing") return respond({ signed_in: status.signed_in });
    if (!status.signed_in) return route.fulfill({ status: 401, json: { error: { code: "butler_account_signed_out" } } });
    if (pathname === "/publishing/pages") {
      const data = await (await cloudRequest("/v1/pages")).json();
      return respond({ ...data, pages: data.pages.map((row: typeof entry) => ({
        ...row, item_id: row.source_key.startsWith("dev_fake:") ? row.source_key.slice("dev_fake:".length) : null,
      })) });
    }
    if (method === "GET") return respond({ signed_in: true, ...local });
    if (method === "DELETE") {
      const id = pathname === itemPath ? pageId : pathname.slice("/publishing/pages/".length);
      assert.equal((await cloudRequest(`/v1/pages/${id}`, "DELETE")).status, 204);
      if (pathname === itemPath) saveLibraryItem(server.butlerData);
      return respond({ unpublished: true });
    }
    assert.equal(method, "POST");
    const drafted = await (await cloudRequest("/v1/pages", "POST", JSON.stringify({
      source_key: entry.source_key, title: item.title, entry: "index.html", files: [{ path: "index.html", sha256: sha, size: html.length }],
    }))).json();
    for (const digest of drafted.missing) assert.equal((await cloudRequest(`/v1/pages/${drafted.id}/blobs/${digest}`, "PUT", html)).status, 204);
    await uploadCapture;
    const published = await (await cloudRequest(`/v1/pages/${drafted.id}/publish`, "POST", JSON.stringify({ version: drafted.version }))).json();
    saveLibraryItem(server.butlerData, { page_id: published.id, url: published.url });
    return respond({ page_id: published.id, url: published.url, version: published.version, ...local });
  });
  return () => releaseUpload?.();
}

async function capture(page: Page, state: string, section?: Locator) {
  if (!shots) return;
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 1280]) {
      await page.setViewportSize(viewport(width));
      await section?.scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(shots, `publish-${state}-${language}-${colorScheme}-${width}.png`), animations: "disabled" });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(viewport(1440));
}

async function verifyDialog(page: Page, dialog: Locator) {
  for (const width of [390, 1440]) {
    await page.setViewportSize(viewport(width));
    const facts = await dialog.evaluate((node) => {
      const footer = node.querySelector('[data-slot="dialog-footer"] > [data-slot="button-container"]')!;
      const buttons = Array.from(footer.querySelectorAll("button"));
      const rects = buttons.map((button) => button.getBoundingClientRect());
      const right = footer.getBoundingClientRect().right;
      const lastOnRows = rects.filter((rect, index) => !rects[index + 1] || Math.abs(rects[index + 1]!.top - rect.top) > 1);
      const bounds = node.getBoundingClientRect();
      return { fits: node.scrollWidth <= node.clientWidth + 1 && bounds.left >= -1 && bounds.right <= window.innerWidth + 1,
        primary: buttons.at(-1)?.textContent?.trim(), offsets: lastOnRows.map((rect) => Math.abs(right - rect.right)) };
    });
    assert.equal(facts.fits, true, `Dialog fits ${width}px`);
    assert.equal(facts.primary, copy.update, `Primary button is last at ${width}px`);
    assert(facts.offsets.length && facts.offsets.every((offset) => offset <= 1), `Rows align at ${width}px: ${facts.offsets}`);
    console.log(JSON.stringify({ width, footerRightOffsets: facts.offsets }));
  }
}

async function signIn(page: Page) {
  await page.getByRole("dialog", { name: copy.title }).getByRole("button", { name: account.signIn, exact: true }).click();
  const signIn = page.getByRole("dialog", { name: account.dialogTitle });
  await signIn.getByLabel(account.email, { exact: true }).fill("user@example.com");
  await signIn.getByRole("button", { name: account.sendCode, exact: true }).click();
  await signIn.getByLabel(account.code, { exact: true }).fill("123456");
  await signIn.getByRole("button", { name: account.signIn, exact: true }).click();
}

async function libraryFlow(page: Page, cloud: FakeCloud, releaseUpload: () => void) {
  await page.locator('[data-test-class="library-entry"]').click();
  await page.getByRole("radio", { name: appCopy.library.kinds.output, exact: true }).click();
  const card = page.locator(`[data-library-item="${item.id}"]`);
  const more = card.getByRole("button", { name: appCopy.browser.more, exact: true });
  const publishMenu = page.getByRole("menuitem", { name: copy.menuPublish, exact: true });
  const dialog = page.getByRole("dialog", { name: copy.title });
  await more.click();
  await publishMenu.waitFor();
  await capture(page, "menu");
  await publishMenu.click();
  await dialog.getByText(copy.signInNeeded, { exact: true }).waitFor();
  await capture(page, "signedOut");
  await signIn(page);

  const blocked = dialog.getByRole("radio", { name: copy.privateOption });
  await blocked.waitFor();
  assert.equal(await blocked.getAttribute("aria-disabled"), "true");
  await capture(page, "choose");
  await dialog.getByRole("button", { name: copy.publish, exact: true }).click();
  if (shots) {
    await dialog.getByRole("button", { name: copy.uploading, exact: true }).waitFor();
    await capture(page, "uploading");
    releaseUpload();
  }
  const link = dialog.getByRole("textbox", { name: copy.link });
  await link.waitFor();
  assert.equal(await link.inputValue(), pageUrl);
  await verifyDialog(page, dialog);
  await capture(page, "published");

  await dialog.getByRole("button", { name: appCopy.common.close, exact: true }).click();
  await card.getByText(new RegExp(`^${copy.metaPublished}`, "u")).waitFor();
  await more.click();
  await page.getByRole("menuitem", { name: copy.menuPublished, exact: true }).click();
  await dialog.getByRole("button", { name: copy.stop, exact: true }).click();
  const stop = page.getByRole("dialog", { name: copy.stopConfirm });
  await stop.waitFor();
  await capture(page, "stop");
  await stop.getByRole("button", { name: copy.stop, exact: true }).click();
  await page.getByText(copy.stopped, { exact: true }).waitFor();
  await more.click();
  await publishMenu.waitFor();
  if (shots) {
    cloud.state.limit = 1;
    await publishMenu.click();
    await dialog.getByText(copy.limitReached(1), { exact: true }).waitFor();
    await capture(page, "limit");
    await dialog.getByRole("button", { name: account.cancel, exact: true }).click();
    cloud.state.limit = 3;
  } else await page.keyboard.press("Escape");
}

async function settingsFlow(page: Page) {
  await page.getByRole("button", { name: appCopy.sidebar.settings, exact: true }).click();
  await page.getByRole("button", { name: appCopy.settings.sections.account, exact: true }).click();
  const section = page.locator('[data-settings-section-id="butler-pages"]');
  await section.getByText(copy.takenDown, { exact: true }).waitFor();
  const menus = section.getByRole("button", { name: copy.more, exact: true });
  assert.equal(await menus.count(), 2);
  for (const width of widths) {
    await page.setViewportSize(viewport(width));
    const overflow = await section.evaluate((node) => node.scrollWidth - node.clientWidth);
    assert(await section.isVisible() && overflow <= 1, `Published pages fit ${width}px: ${overflow}`);
  }
  await capture(page, "settings", section);
  await menus.first().click();
  await page.getByRole("menuitem", { name: copy.copyLink, exact: true }).waitFor();
  await capture(page, "settings-menu", section);
}

const data = mkdtempSync(join(tmpdir(), "butler-publish-smoke-"));
let server: NativeAppServerHandle | undefined;
let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
let cloud: FakeCloud | undefined;
let releaseUpload: (() => void) | undefined;
let secret = "";
try {
  if (shots) mkdirSync(shots, { recursive: true });
  cloud = await startFakeCloud();
  seedOutput(data);
  mkdirSync(join(data, "gateways"));
  writeFileSync(join(data, "gateways/app.json"), JSON.stringify({ config: { butlerAccountEnabled: true } }));
  server = await createNativeAppServer({ butlerData: data, uiRoot: resolve("packages/butler-app/client/ui/dist"),
    config: { user: { name: "Smoke", language } }, env: { BUTLER_CLOUD_API_URL: cloud.url } });
  secret = JSON.parse(readFileSync(join(data, "app/runtime/auth/local-admin.json"), "utf8")).secret;
  saveLibraryItem(data);
  browser = await launchSmokeBrowser();
  const page = await browser.newPage({ viewport: viewport(1440), colorScheme: "light" });
  releaseUpload = await installGatewayRoutes(page, server, secret, cloud);
  await page.goto(server.url);
  await installMemoryDesktopBridge(page, server);
  await libraryFlow(page, cloud, releaseUpload);
  await settingsFlow(page);
  assert.equal(server.stubModelCalls.length, 0);
  console.log(JSON.stringify({ ok: true, language, settingsWidths: widths }));
} catch (error) {
  let message = String(error);
  for (const value of [secret, server?.token, "bct_fake"]) if (value) message = message.replaceAll(value, "[redacted]");
  console.error(message);
  process.exitCode = 1;
} finally {
  releaseUpload?.();
  await browser?.close();
  await server?.stop();
  await cloud?.stop();
  rmSync(data, { recursive: true, force: true });
}
