// Office files through the real App (Electron), stub model only. A .docx the agent delivered to the drawer and a
// .docx the user attached each open in the session's inspector as "unsupported" with save and "open in app", never as
// the zip's bytes; "open in app" hands the desktop (stub shell log) a copy under BUTLER_DATA/tmp/opened-files that
// carries the downloaded mark (macOS quarantine); a type off the allowlist shows the action disabled with a tooltip.
// Cells (KO, light/dark, 1280/390) capture the drawer, the drawer item and the attachment into BUTLER_SMOKE_SCREENSHOTS.
// BUTLER_SMOKE_BASELINE=1 with BUTLER_SMOKE_UI_ROOT (the old renderer) captures the same screens and asserts nothing.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { appLocaleFromLanguage, getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { sendWithFiles, uploadFixture } from "../support/attachment-fixtures.ts";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app.ts";

const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const shots = process.env.BUTLER_SMOKE_SCREENSHOTS;
const evidence = process.env.BUTLER_SMOKE_EVIDENCE ?? join(process.env.TMPDIR ?? "/tmp", "open-in-app-evidence");
process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE ??= createRequire(resolve("packages/butler-app/client/electron/package.json"))("electron") as string;
mkdirSync(evidence, { recursive: true });
if (shots) mkdirSync(shots, { recursive: true });
const shellLog = join(evidence, "shell-open.jsonl");
writeFileSync(shellLog, "");
process.env.BUTLER_TEST_SHELL_OPEN_LOG = shellLog;
const copy = getAppCopy(appLocaleFromLanguage("ko"));
const phase = baseline ? "before" : "after";
const deliver = "서랍에 계획서를 넣어 줘";
const drawerTitle = "분기 계획";
const session = "첨부 확인";
const viewer = '[data-test-class="artifact-viewer"]';

/** A stored (uncompressed) ZIP of `entries`. */
function zip(entries: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const fileName = Buffer.from(name), data = Buffer.from(text), sum = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(sum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(sum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(fileName.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data); centrals.push(central, fileName);
    offset += 30 + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const docx = zip([
  ["[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
  ["word/document.xml", "<w:document><w:body><w:p><w:r><w:t>계획</w:t></w:r></w:p></w:body></w:document>"],
]);
const archive = zip([["notes.txt", "notes"]]);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// The agent copies the user's document into its workspace, then delivers it to the drawer.
const source = join(evidence, "source.docx");
let round = 0;
const app = await browserAgentApp(evidence, (request) => {
  if (!request.stream || !JSON.stringify(request.messages).includes(deliver)) return null;
  round++;
  if (round === 1) return { name: "run_command", arguments: { command: `cp '${source}' 계획.docx`, state_effect: "mutation", summary: "Copy the plan" } };
  if (round === 2) return { name: "deliver_files", arguments: { files: [{ path: "계획.docx", title: drawerTitle }] } };
  return null;
}, process.env.BUTLER_SMOKE_UI_ROOT);

async function capture(name: string, keepPointer = false) {
  if (!shots) return;
  if (!keepPointer) await app.page.movePointer(5, 890);
  // Panels slide in; capture what the user sees once they settle.
  // Scroll-driven and endless animations never finish; wait only for timed ones.
  await waitBrowser(() => app.page.expression(`document.getAnimations().every((animation) => animation.playState !== "running"
    || animation.timeline !== document.timeline || animation.effect?.getTiming().iterations === Infinity)`), `${name} settled`);
  await app.page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));
  writeFileSync(join(shots, `${phase}-${name}.png`), await app.page.screenshot());
}

/** Clicks once the target is hit-testable (a drawer may still be sliding in). */
async function click(selector: string) {
  await waitBrowser(() => app.page.clickSelector(selector).then(() => true, () => false), `click ${selector}`);
}

async function showSidebar() {
  // A narrow window shows an open inspector over the whole window; close it first.
  const visible = (label: string) => app.page.expression<boolean>(`[...document.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)} && b.getBoundingClientRect().width)`);
  if (await app.page.expression("innerWidth < 600") && await visible(copy.titlebar.hideRightPanel)) {
    await app.page.clickText(copy.titlebar.hideRightPanel, "button");
    await waitBrowser(async () => !await visible(copy.titlebar.hideRightPanel), "inspector closed");
  }
  await waitBrowser(async () => await visible(copy.titlebar.showLeftPanel) || await visible(copy.titlebar.hideLeftPanel), "sidebar toggle");
  if (await visible(copy.titlebar.showLeftPanel)) await app.page.clickText(copy.titlebar.showLeftPanel, "button");
}

async function openDrawerItem(name: string) {
  await showSidebar();
  await click('[data-test-class="library-entry"]');
  await waitBrowser(() => app.page.expression(`Boolean(document.querySelector('[data-library-item] [aria-label="${drawerTitle}"]'))`), "drawer card");
  await capture(`drawer-${name}`);
  await click(`[data-library-item] [aria-label="${drawerTitle}"]`);
  await waitBrowser(() => app.page.expression(`Boolean(document.querySelector('${viewer}'))`), "drawer item in the inspector");
  await assertUnsupported("drawer item");
  await capture(`drawer-item-${name}`);
}

async function openAttachment(name: string, file: string) {
  await showSidebar();
  await click(`[data-test-class="app-sidebar"] [aria-label="${session}"]`);
  const tile = `[data-test-class="message-attachment-list"] [data-slot="attachment-tile"] button[aria-label="${file}"]`;
  await waitBrowser(() => app.page.expression(`Boolean(document.querySelector('${tile}'))`), "sent attachments");
  await click(tile);
  await waitBrowser(() => app.page.expression(`document.querySelector('${viewer}')?.closest('[data-test-class]') !== null && document.querySelector('${viewer}').textContent.length > 0`), `${file} in the inspector`);
  if (name) { await assertUnsupported("attachment"); await capture(`attachment-${name}`); }
}

/** The viewer shows the unsupported state with an enabled "open in app" (its header saves), and none of the zip's bytes. */
async function assertUnsupported(label: string) {
  const read = () => app.page.expression<string>(`document.querySelector('${viewer}').textContent`);
  await waitBrowser(async () => ![copy.artifacts.loading, ""].includes(await read()), `${label} loaded`);
  const text = await read();
  if (baseline) { console.log(`${label} (before): ${text.includes("PK") ? "zip bytes as text" : "no zip text"}`); return; }
  assert.ok(text.includes(copy.artifacts.unsupported), `${label}: unsupported state; got ${text.slice(0, 80)}`);
  assert.ok(!text.includes("[Content_Types].xml"), `${label}: no zip bytes`);
  const buttons = await app.page.expression<Array<{ text: string; disabled: boolean }>>(`[...document.querySelectorAll('${viewer} button')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled }))`);
  // Saving is the file viewer header's 저장하기; the page itself offers only "open in app".
  assert.deepEqual(buttons, [{ text: copy.artifacts.openInApp, disabled: false }], label);
  assert.ok(await app.page.expression<boolean>(`Boolean(document.querySelector('[data-test-class="file-viewer-save"]'))`), `${label}: the header saves`);
}

async function assertOpensMarkedCopy() {
  await click(`${viewer} button[aria-label^="${copy.artifacts.openInApp}:"]`);
  let target = "";
  await waitBrowser(async () => {
    const line = readFileSync(shellLog, "utf8").trim().split("\n").filter(Boolean).at(-1);
    target = line ? (JSON.parse(line) as { action: string; target: string }).target : "";
    return Boolean(target);
  }, "open in app reaches the desktop");
  const opened = JSON.parse(readFileSync(shellLog, "utf8").trim().split("\n").at(-1)!) as { action: string; target: string };
  assert.equal(opened.action, "openPath");
  assert.ok(opened.target.startsWith(join(realpathSync(app.gateway.butlerData), "tmp", "opened-files")), opened.target);
  assert.ok(opened.target.endsWith("계획.docx") && existsSync(opened.target), opened.target);
  assert.deepEqual(readFileSync(opened.target), docx, "the copy holds the stored bytes");
  if (process.platform === "darwin") {
    const mark = spawnSync("xattr", ["-p", "com.apple.quarantine", opened.target], { encoding: "utf8" });
    assert.match(mark.stdout, /^0081;/u, "the copy carries the quarantine mark");
  }
  console.log(`Open in app: desktop opened ${opened.target.slice(realpathSync(app.gateway.butlerData).length)} (marked)`);
}

async function assertBlockedType() {
  await openAttachment("", "notes.zip");
  const button = `${viewer} button[aria-label^="${copy.artifacts.openInApp}."]`;
  assert.equal(await app.page.expression(`document.querySelector('${button}')?.disabled`), true, "a zip cannot open in another app");
  const box = await app.page.expression<{ x: number; y: number }>(`(() => { const b = document.querySelector('${button}').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await app.page.movePointer(box.x, box.y);
  await waitBrowser(() => app.page.expression(`document.querySelector('[data-slot="tooltip-content"]')?.textContent === ${JSON.stringify(copy.artifacts.openInAppBlocked)}`), "blocked type tooltip");
  await capture("attachment-blocked-light-1280", true);
  console.log("Blocked type: open in app disabled with tooltip: passed");
}

async function setCell(theme: "light" | "dark", width: number) {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
  await app.main(`${app.win}.setContentSize(${width}, 900)`);
  // The theme setting applies when the renderer loads.
  await app.page.reload();
  await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
  await waitBrowser(() => app.page.expression(`innerWidth === ${width}`), `${theme} ${width}`);
}

async function seed() {
  writeFileSync(source, docx);
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "full_access" }) });
  await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text: deliver, client_message_id: crypto.randomUUID() }) });
  await waitBrowser(async () => (await app.gateway.api<{ items: unknown[] }>("/library?kind=document")).items.length === 1, "delivered to the drawer");
  const sessionId = (await app.gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: session }) })).session.id;
  const files = [];
  for (const [name, mimeType, buffer] of [["계획.docx", DOCX, docx], ["notes.zip", "application/zip", archive]] as const) {
    files.push(await uploadFixture(app.gateway, sessionId, { name, mimeType, buffer }));
  }
  await sendWithFiles(app.gateway, sessionId, "이 파일들 확인해 줘", files);
}

try {
  await seed();
  await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
  for (const theme of ["light", "dark"] as const) for (const width of [1280, 390]) {
    await setCell(theme, width);
    await openDrawerItem(`${theme}-${width}`);
    await openAttachment(`${theme}-${width}`, "계획.docx");
  }
  if (!baseline) {
    await setCell("light", 1280);
    await openAttachment("", "계획.docx");
    await assertOpensMarkedCopy();
    await assertBlockedType();
  }
  console.log(baseline ? "Open-in-app baseline captured" : "Open-in-app smoke passed");
} catch (error) {
  writeFileSync(join(evidence, "failure.png"), await app.page.screenshot());
  writeFileSync(join(evidence, "model-requests.json"), JSON.stringify(app.visionRequests?.map((call) => ({ tools: (call.body.tools as Array<{ name?: string }> | undefined)?.map((tool) => tool.name), messages: call.messages.slice(-3) })), null, 1));
  throw error;
} finally { await app.stop(); }
