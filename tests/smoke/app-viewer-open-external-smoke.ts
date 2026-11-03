// Real Electron, isolated gateway and stub model: the file viewer's open-external action reaches the shell once per click.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { appLocaleFromLanguage, getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { sendWithFiles, uploadFixture, type StoredFile } from "../support/attachment-fixtures.ts";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app.ts";

const shots = process.env.BUTLER_SMOKE_SCREENSHOTS;
const evidence = process.env.BUTLER_SMOKE_EVIDENCE ?? join(process.env.TMPDIR ?? "/tmp", "viewer-open-external-evidence");
mkdirSync(evidence, { recursive: true });
if (shots) mkdirSync(shots, { recursive: true });
const shellLog = join(evidence, "shell-open.jsonl");
writeFileSync(shellLog, "");
process.env.BUTLER_TEST_SHELL_OPEN_LOG = shellLog;
process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE ??= createRequire(resolve("packages/butler-app/client/electron/package.json"))("electron") as string;
const copy = getAppCopy(appLocaleFromLanguage("ko"));
const sessionTitle = "첨부 파일 검토";
const pane = '[data-test-class="file-viewer"]';
const header = `${pane} [data-test-class="file-viewer-header"]`;
const action = `${header} [data-test-class="file-viewer-open-external"]`;

/** A 1×1 PNG; the viewer only needs a decodable picture. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mMo2XEGAAOcAfk4If7EAAAAAElFTkSuQmCC", "base64");

const fixtures = [
  { name: "검토.md", mimeType: "text/markdown", buffer: Buffer.from("# 검토\n\n기본 앱에서 읽을 문서입니다.\n"), kind: "markdown" },
  { name: "그림.png", mimeType: "image/png", buffer: PNG, kind: "image" },
  { name: "검토.py", mimeType: "text/plain", buffer: Buffer.from("print('review')\n"), kind: "script" },
];
type Fixture = typeof fixtures[number];
type ShellLine = { action: string; target: string };
const stored: StoredFile[] = [];
const app = await browserAgentApp(evidence, () => null);

function shellLines(): ShellLine[] {
  return readFileSync(shellLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ShellLine);
}

async function click(selector: string) {
  await waitBrowser(() => app.page.clickSelector(selector).then(() => true, () => false), `click ${selector}`);
}

async function settle() {
  await waitBrowser(() => app.page.expression(`document.getAnimations().every((a) => a.playState !== 'running'
    || a.timeline !== document.timeline || a.effect?.getTiming().iterations === Infinity)`), "viewer settled");
  await app.page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));
}

async function openFixture(fixture: Fixture) {
  // Session info's attachment list opens the file pane, including pictures. In the transcript,
  // picture tiles instead open the media overlay, while document tiles open this same file pane.
  const image = fixture.kind === "image";
  if (image) await click('[data-test-class="session-info-toggle"]');
  const tile = `[data-test-class="message-attachment-list"] [data-slot="attachment-tile"] button[aria-label="${fixture.name}"]`;
  await click(image ? `[data-slot="conversation-aside"] ${tile}` : tile);
  await waitBrowser(() => app.page.expression(`document.querySelector('${header} h2')?.textContent === ${JSON.stringify(fixture.name)}`), `${fixture.name} header`);
  await waitBrowser(() => app.page.expression(`(() => {
    const body = document.querySelector('${pane} [data-test-class="artifact-viewer"]');
    if (!body || body.textContent === ${JSON.stringify(copy.artifacts.loading)}) return false;
    const image = body.querySelector('img');
    return image ? image.complete && image.naturalWidth > 0 : Boolean(body.textContent);
  })()`), `${fixture.name} loaded`);
  if (image) await click('[data-test-class="session-info-toggle"]');
  await settle();
}

async function hoverAction(label: string) {
  const point = await app.page.expression<{ x: number; y: number }>(`(() => {
    const box = document.querySelector('${action}').getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  await app.page.movePointer(point.x, point.y);
  await waitBrowser(() => app.page.expression(`document.querySelector('[data-slot="tooltip-content"]')?.textContent === ${JSON.stringify(label)}`), "localized DS tooltip");
}

async function assertHeader(fixture: Fixture) {
  const label = fixture.kind === "script" ? copy.fileViewer.showInFolder : copy.fileViewer.openInDefaultApp;
  const layout = await app.page.expression<{
    count: number; icon: boolean; label: string; last: string; offRow: string[];
  }>(`(() => {
    const root = document.querySelector('${header}'), title = root.querySelector('h2');
    const actions = [...root.querySelectorAll('button, a')], external = root.querySelector('${action}');
    const center = (node) => { const box = node.getBoundingClientRect(); return box.y + box.height / 2; };
    return { count: root.querySelectorAll('${action}').length,
      icon: external?.tagName === 'BUTTON' && !external.textContent.trim() && Boolean(external.querySelector('svg')),
      label: external?.getAttribute('aria-label'), last: actions.at(-1)?.getAttribute('data-test-class'),
      offRow: actions.filter((node) => Math.abs(center(node) - center(title)) > 14).map((node) => node.getAttribute('aria-label')) };
  })()`);
  assert.equal(layout.count, 1);
  assert.equal(layout.icon, true, "external action is an icon button");
  assert.equal(layout.label, `${label}: ${fixture.name}`);
  assert.equal(layout.last, "file-viewer-close", "close stays last");
  assert.deepEqual(layout.offRow, [], "name, actions and close share a row");
  await hoverAction(label);
  await app.page.movePointer(5, 890);
}

function assertCopy(line: ShellLine, fixture: Fixture) {
  const root = realpathSync(join(app.gateway.butlerData, "tmp", "opened-files"));
  const target = realpathSync(line.target);
  const inside = relative(root, target);
  assert(inside && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside), line.target);
  assert(lstatSync(line.target).isFile(), "shell target is a real file");
  assert.deepEqual(readFileSync(target), fixture.buffer, "all stored bytes reach the default app");
  if (process.platform === "darwin") {
    const mark = spawnSync("xattr", ["-p", "com.apple.quarantine", target], { encoding: "utf8" });
    assert.equal(mark.status, 0);
    assert.match(mark.stdout, /^0081;/u, "copy carries the downloaded mark");
  }
}

async function assertShellAction(fixture: Fixture) {
  const count = shellLines().length;
  await click(action);
  await waitBrowser(async () => shellLines().length > count, "desktop action logged");
  await settle();
  const lines = shellLines();
  assert.equal(lines.length, count + 1, "one click appends exactly one shell action");
  assert.equal(lines[count].action, fixture.kind === "script" ? "showItemInFolder" : "openPath");
  assertCopy(lines[count], fixture);
}

async function capture(name: string, tooltip = false) {
  if (!shots) return;
  if (!tooltip) await app.page.movePointer(5, 890);
  await settle();
  const rect = await app.page.expression<{ x: number; y: number; width: number; height: number }>(`(() => {
    const box = document.querySelector('${pane}').getBoundingClientRect();
    return { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.floor(box.width), height: Math.floor(box.height) };
  })()`);
  const png = await app.main<string>(`(async () => (await ${app.win}.webContents.capturePage(${JSON.stringify(rect)})).toPNG().toString('base64'))()`);
  writeFileSync(join(shots, `${name}.png`), Buffer.from(png, "base64"));
}

async function assertRefusals() {
  const count = shellLines().length;
  const rejected = await app.page.evaluate(async () => {
    try { await window.butlerApp!.openMessageFile!({ fileId: "../../../etc/hosts" }); return false; }
    catch { return true; }
  });
  assert.equal(rejected, true, "malformed id rejects");
  const unknown = await app.page.evaluate(() => window.butlerApp!.openMessageFile!({ fileId: "file-00000000-0000-0000-0000-000000000000" }));
  assert.equal(unknown.opened, false, "unknown id opens nothing");
  assert.equal(shellLines().length, count, "refused calls cause no shell action");
  const result = await app.page.expression<{ opened: boolean }>(`window.butlerApp.openMessageFile(${JSON.stringify({ fileId: stored[0].file_id, path: "/etc/hosts" })})`);
  assert.equal(result.opened, true, "extra renderer path is dropped");
  const lines = shellLines();
  assert.equal(lines.length, count + 1);
  assert.equal(lines[count].action, "openPath");
  assertCopy(lines[count], fixtures[0]);
  // Check every shell request, including the injected renderer path.
  for (const line of lines) {
    const inside = relative(realpathSync(join(app.gateway.butlerData, "tmp", "opened-files")), realpathSync(line.target));
    assert(inside && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside), line.target);
  }
}

async function seed() {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko" }) });
  const { session } = await app.gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: sessionTitle }) });
  for (const fixture of fixtures) stored.push(await uploadFixture(app.gateway, session.id, fixture));
  await sendWithFiles(app.gateway, session.id, "첨부 파일을 확인해 줘.", stored);
}

try {
  await seed();
  for (const theme of ["light", "dark"] as const) {
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
    await app.main(`${app.win}.setContentSize(1280, 900)`);
    await app.page.reload();
    await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
    await waitBrowser(() => app.page.expression("innerWidth === 1280"), "1280 wide renderer");
    await click(`[data-test-class="app-sidebar"] [aria-label="${sessionTitle}"]`);
    for (const fixture of fixtures) {
      await openFixture(fixture);
      await assertHeader(fixture); await assertShellAction(fixture);
      if (fixture.kind !== "script") await capture(`header-${fixture.kind}-${theme}`);
      if (fixture.kind === "markdown" && shots) {
        await hoverAction(copy.fileViewer.openInDefaultApp);
        await capture(`tooltip-${theme}`, true);
        await app.page.movePointer(5, 890);
      }
    }
  }
  await assertRefusals();
  console.log(JSON.stringify({ result: "BEHAVIOR_PASS", shellActions: shellLines().length, screenshots: shots }));
} catch (error) {
  writeFileSync(join(evidence, "failure.png"), await app.page.screenshot());
  throw error;
} finally { await app.stop(); }
