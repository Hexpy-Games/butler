// Attachment tiles in the real Electron App (app://butler), stub model only. Signed message-file URLs get a short
// gateway lifetime (BUTLER_APP_SIGNED_URL_TTL_SECONDS, the product's own knob), so a sent message that scrolls in after
// it must load fresh ones: pictures decode (naturalWidth > 0) and videos reach their first frame, in the composer and in
// sent messages. A long file name takes two lines, breaking at its own boundaries (`_`, `-`, the extension) with no line
// of a single character, ends in an ellipsis and shows its whole name in the tooltip. A credential-named
// file the policy withholds (`.env`, reported to the model in `skipped_files`) shows no "attachment unavailable" tag; a
// delivered file that is gone keeps it (needs an agent built with `butler-agent/e2e-fixtures`, as the CI smoke binary is,
// for the `message_attachment` hold point). A tile whose link was revoked before expiry (connection code rotated)
// re-signs and loads.
// KO/EN × light/dark × 1440/390 crops at 2× go to BUTLER_SMOKE_SCREENSHOTS.
// Every check is reported; the run fails at the end on any failed check. BUTLER_SMOKE_BASELINE=1 captures the old
// build (BUTLER_SMOKE_UI_ROOT, BUTLER_NATIVE_AGENT_EXECUTABLE) and reports its checks without failing.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { appLocaleFromLanguage, getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { allowStubImages, drawPhoto, mixedFixtures, sendWithFiles, uploadFixture, type FixtureFile } from "../support/attachment-fixtures.ts";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app.ts";
import type { StubModelRequest } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";

const TTL_SECONDS = 15;
const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const shots = process.env.BUTLER_SMOKE_SCREENSHOTS;
const phase = baseline ? "before" : "after";
const evidence = process.env.BUTLER_SMOKE_EVIDENCE ?? join(process.env.TMPDIR ?? "/tmp", "attachment-thumbnails-evidence");
process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE ??= createRequire(resolve("packages/butler-app/client/electron/package.json"))("electron") as string;
if (shots) mkdirSync(shots, { recursive: true });
const failures: string[] = [];
const TILE = '[data-slot="attachment-tile"]';
/** A message's own tiles (the session-info panel lists the same files outside the messages). */
const SENT = 'article [data-test-class="message-attachment-list"]';
const COMPOSER = '[data-test-class~="composer-card"]';
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Language = "ko" | "en";
const words = {
  ko: { title: "첨부 확인", send: "이 파일들 확인해 줘", long: "2026년_2분기_매출_분석_보고서_최종_검토본.pdf", skipTitle: "배포 설정", skip: "배포 설정을 만들어 줘",
    skipReply: "배포 설정을 만들었습니다. 비밀 값은 .env에 따로 두었습니다.", missTitle: "보고서", miss: "보고서를 보내 줘", missReply: "보고서를 보냈습니다." },
  en: { title: "Attachments", send: "Please check these files", long: "q2-2026-revenue-analysis-report-final-review.pdf", skipTitle: "Deploy settings",
    skip: "Make the deploy settings", skipReply: "I made the deploy settings and kept the secrets in .env.", missTitle: "Report", miss: "Send me the report",
    missReply: "Here is the report." },
} as const;

async function check(name: string, run: () => Promise<unknown>) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${(error as Error).message.split("\n")[0]}`); }
}

/** The turn's tool round: tool outputs since the last user message, for the scenario its text names. */
function turnOf(request: StubModelRequest, language: Language) {
  const messages = request.messages as Array<{ role?: string; content?: unknown }>;
  const last = messages.map((message) => message.role).lastIndexOf("user");
  const text = JSON.stringify(messages[last]?.content ?? "");
  const scenario = text.includes(words[language].skip) ? "skip" : text.includes(words[language].miss) ? "miss" : undefined;
  return { scenario, round: messages.slice(last + 1).filter((message) => message.role === "tool").length, outputs: messages.slice(last + 1) };
}

function stub(language: Language, modelSawSkip: { value: boolean }) {
  const hasTools = (request: StubModelRequest) => Array.isArray(request.body.tools) && request.body.tools.length > 0;
  return {
    stubReply: (request: StubModelRequest) => {
      const { scenario } = turnOf(request, language);
      return scenario === "skip" ? words[language].skipReply : scenario === "miss" ? words[language].missReply : "Stub reply from the isolated smoke model.";
    },
    stubToolCall: (request: StubModelRequest) => {
      if (!hasTools(request)) return null;
      const { scenario, round, outputs } = turnOf(request, language);
      if (scenario === "skip") {
        if (round === 0) return { name: "write_file", arguments: { path: "deploy/.env", content: "API_KEY=fixture\n", create_parents: true } };
        if (round === 1) return { name: "output_publish", arguments: { path: "deploy/.env", title: ".env" } };
        modelSawSkip.value ||= /skipped_files[^\]]*\.env/u.test(JSON.stringify(outputs));
      }
      if (scenario === "miss") {
        if (round === 0) return { name: "write_file", arguments: { path: "report.md", content: "# Report\n", create_parents: true } };
        if (round === 1) return { name: "deliver_files", arguments: { files: [{ path: "report.md", title: "Report" }] } };
      }
      return null;
    },
  };
}

/** The delivered copies waiting for the answer (the e2e-fixtures hold point keeps the answer from attaching them). */
function removeHandoffCopies(butlerData: string) {
  const root = join(butlerData, "app-server/message-files/.handoffs");
  let removed = 0;
  for (const turn of readdirSync(root)) {
    for (const name of readdirSync(join(root, turn))) if (name !== ".turn") { rmSync(join(root, turn, name), { force: true }); removed += 1; }
  }
  return removed;
}

/**
 * A genuinely missing file: the turn's delivered copy disappears before the answer attaches it. Needs an agent built
 * with `butler-agent/e2e-fixtures` (the CI smoke binary) for the `message_attachment` hold point.
 */
async function sendWithMissingFile(server: App["gateway"], release: string, text: string, create: (title: string) => Promise<string>, title: string) {
  rmSync(release, { force: true }); rmSync(`${release}.held`, { force: true });
  const sessionId = await create(title);
  await server.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: sessionId, text, client_message_id: crypto.randomUUID() }) });
  await waitBrowser(async () => existsSync(`${release}.held`), "the answer held before attaching (agent built with e2e-fixtures)");
  if (removeHandoffCopies(server.butlerData) === 0) throw new Error("no delivered copy to remove");
  writeFileSync(release, "release");
  // The held answer is projected again with the next transcript change (the turns seeded after it).
  return async () => waitBrowser(async () => (await server.api<{ latest_turn?: { state?: string } }>(`/session-view?session_id=${encodeURIComponent(sessionId)}`)).latest_turn?.state === "delivered", "missing-file turn delivered");
}

type App = Awaited<ReturnType<typeof browserAgentApp>>;

/** Raw page CDP for viewport emulation and 2× element crops. */
async function pageCdp(app: App) {
  const targets = await fetch(`http://127.0.0.1:${app.debug}/json/list`).then((response) => response.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
  const socket = new WebSocket(targets.find((target) => target.type === "page" && target.url.startsWith("app://butler/"))!.webSocketDebuggerUrl);
  await new Promise((done) => socket.addEventListener("open", done, { once: true }));
  let id = 0;
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  socket.addEventListener("message", (message) => {
    const payload = JSON.parse(String(message.data));
    pending.get(payload.id)?.(payload.result ?? {}); pending.delete(payload.id);
  });
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((done) => {
    pending.set(++id, done); socket.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => socket.close() };
}
type Cdp = Awaited<ReturnType<typeof pageCdp>>;

async function viewport(app: App, cdp: Cdp, width: number, theme: "light" | "dark") {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: width > 600 ? 900 : 844, deviceScaleFactor: 2, mobile: false });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(400);
  await app.page.expression("document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))))");
}

/** One state, one image: the element's box (plus a margin) at 2×. */
async function crop(app: App, cdp: Cdp, selector: string, name: string) {
  if (!shots) return;
  const box = await app.page.expression<{ x: number; y: number; width: number; height: number } | null>(`(() => {
    const node = ${selector}; if (!node) return null; node.scrollIntoView({ block: "center" });
    const r = node.getBoundingClientRect(); const m = 12;
    return { x: Math.max(0, r.x - m), y: Math.max(0, r.y - m), width: Math.min(innerWidth, r.width + 2 * m), height: r.height + 2 * m }; })()`);
  if (!box) { console.log(`No crop for ${name}`); return; }
  await sleep(250);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 }, captureBeyondViewport: false });
  writeFileSync(join(shots, `${phase}-${name}.png`), Buffer.from(String(shot.data), "base64"));
}

const media = (scope: string) => `[...document.querySelectorAll('${scope} ${TILE}')].filter((tile) => tile.dataset.kind !== "file").map((tile) => ({
  kind: tile.dataset.kind, picture: tile.querySelector("img")?.naturalWidth ?? 0, frame: tile.querySelector("video")?.readyState ?? 0 }))`;

async function assertLoaded(app: App, scope: string, count: number) {
  try {
    await waitBrowser(() => app.page.expression(`(() => { const tiles = ${media(scope)}; return tiles.length === ${count}
      && tiles.every((tile) => tile.kind === "image" ? tile.picture > 0 : tile.frame >= 1); })()`), `${scope} pictures and first frames`);
  } catch (error) {
    throw new Error(`${(error as Error).message}: ${JSON.stringify(await app.page.expression(media(scope)))}`, { cause: error });
  }
}

/** Puts files into the composer's file input, as the picker does. */
async function attach(app: App, files: FixtureFile[]) {
  const payload = files.map((file) => ({ name: file.name, type: file.mimeType, data: file.buffer.toString("base64") }));
  // Pictures are admitted once the composer knows its model takes images (the stub's catalog entry has loaded).
  await openComposer(app);
  await waitBrowser(() => app.page.expression(`document.querySelector('${COMPOSER}')?.textContent.includes("Stub") ?? false`), "composer model loaded");
  const before = await app.page.expression<number>(`document.querySelectorAll('${COMPOSER} ${TILE}').length`);
  await app.page.expression(`(() => { const input = document.querySelector("input[type='file']"); const transfer = new DataTransfer();
    for (const file of ${JSON.stringify(payload)}) transfer.items.add(new File([Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0))], file.name, { type: file.type }));
    input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  await waitBrowser(() => app.page.expression(`document.querySelectorAll('${COMPOSER} ${TILE}').length === ${before + files.length}`), "composer tiles");
  await openComposer(app);
}

/** The composer shows its files while it is open. */
async function openComposer(app: App) {
  await app.page.expression("document.querySelector('[data-slot=\"composer-compact-preview\"]')?.click(), true");
  await sleep(300);
}

async function openSession(app: App, title: string) {
  const row = `document.querySelector('[data-test-class="app-sidebar"] [aria-label="${title}"]')`;
  await waitBrowser(() => app.page.expression(`Boolean(${row})`), `${title} in the sidebar`);
  await app.page.expression(`${row}.focus()`);
  await app.page.press("Enter");
  await waitBrowser(() => app.page.expression(`document.querySelector('[data-test-class="conversation"]')?.textContent.length > 0`), `${title} open`);
  // Settled: the message list stops changing (a draft started while the session still loads is reset with it).
  let last = "";
  await waitBrowser(async () => {
    const now = await app.page.expression<string>(`[...document.querySelectorAll('[data-test-class="conversation"] article')].map((row) => row.textContent?.length).join()`);
    const same = now === last && now !== "";
    last = now;
    await sleep(700);
    return same;
  }, `${title} settled`);
}

/** The tile button named `name` (stored names may come back in another Unicode normal form). */
const tileButton = (scope: string, name: string) => `[...document.querySelectorAll('${scope} ${TILE} button')]
  .find((button) => button.getAttribute("aria-label")?.normalize("NFC") === ${JSON.stringify(name.normalize("NFC"))})`;
const same = (expression: string, name: string) => `(${expression})?.normalize("NFC") === ${JSON.stringify(name.normalize("NFC"))}`;

/**
 * The long name's tile: two visible lines (the clamp), the first ending at a name boundary (`_`, `-`, a space, or before
 * the extension), no line of a single character, the rest clipped behind the ellipsis, and the whole name in its tooltip.
 */
async function assertLongName(app: App, scope: string, name: string) {
  const facts = await app.page.expression<{ clamp: string; lines: string[]; clipped: boolean; box: number[] } | null>(`(() => {
    const button = ${tileButton(scope, name)};
    const text = [...(button?.querySelectorAll('[data-line-clamp],[data-truncate]') ?? [])].find((node) => ${same("node.textContent", name)});
    if (!text) return null; const box = text.getBoundingClientRect(); const range = document.createRange(); const lines = new Map();
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT); let node;
    while ((node = walker.nextNode())) for (let i = 0; i < node.data.length; i++) {
      range.setStart(node, i); range.setEnd(node, i + 1); const r = range.getClientRects()[0];
      if (!r || r.bottom > box.bottom + 1) continue; const top = Math.round(r.top); lines.set(top, (lines.get(top) ?? "") + node.data[i]); }
    const r = button.getBoundingClientRect();
    return { clamp: getComputedStyle(text).webkitLineClamp, lines: [...lines.values()], clipped: text.scrollHeight > text.clientHeight + 1,
      box: [r.x + r.width / 2, r.y + r.height / 2] }; })()`);
  const [first, second] = facts?.lines ?? [];
  const boundary = Boolean(first && second && (/[_\- ]$/u.test(first) || second.startsWith(".")));
  const orphan = facts?.lines.some((line) => [...line].length < 2) ?? true;
  if (!facts || facts.clamp !== "2" || facts.lines.length !== 2 || !boundary || orphan || !facts.clipped) {
    throw new Error(`name layout ${JSON.stringify(facts)}`);
  }
  // Off the tile first, then onto it with two moves, so the tooltip sees a fresh hover.
  await app.page.movePointer(2, 2);
  await sleep(300);
  await app.page.movePointer(facts.box[0]! - 4, facts.box[1]! - 4);
  await app.page.movePointer(facts.box[0]!, facts.box[1]!);
  await waitBrowser(() => app.page.expression(same(`document.querySelector('[data-slot="tooltip-content"]')?.textContent`, name)), "full name tooltip");
  await app.page.movePointer(2, 2);
}

/** Scrolls the conversation to an end: the top, until a message's tiles show, or the bottom. */
async function scroll(app: App, to: "top" | "bottom") {
  const move = `(() => { let node = document.querySelector('[data-test-class="conversation"] article');
    for (; node; node = node.parentElement) if (node.scrollHeight > node.clientHeight + 100 && /auto|scroll/u.test(getComputedStyle(node).overflowY)) {
      node.scrollTop = ${to === "top" ? "0" : "node.scrollHeight"}; break; } return true; })()`;
  if (to === "bottom") { await app.page.expression(move); await sleep(500); return; }
  await waitBrowser(async () => { await app.page.expression(move); return app.page.expression(`Boolean(document.querySelector('${SENT}'))`); }, "message attachments in view");
  await sleep(300);
}
const scrollToTop = (app: App) => scroll(app, "top");

const lastAnswer = `[...document.querySelectorAll('[data-test-class="conversation"] article')].at(-1)`;

async function seed(app: App, language: Language, fixtures: FixtureFile[], release: string) {
  const server = app.gateway;
  const config = JSON.parse(readFileSync(join(server.butlerData, "butler.config.json"), "utf8"));
  await allowStubImages(server, config.models.local[0].server_url);
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "full_access" }) });
  const create = async (title: string) => (await server.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title }) })).session.id;
  const missDelivered = await sendWithMissingFile(server, release, words[language].miss, create, words[language].missTitle);
  await sendWithFiles(server, await create(words[language].skipTitle), words[language].skip, []);
  const sessionId = await create(words[language].title);
  const stored = [];
  for (const fixture of fixtures) stored.push(await uploadFixture(server, sessionId, fixture));
  await sendWithFiles(server, sessionId, words[language].send, stored);
  // Later messages push the attachments above the fold, so their row mounts only when scrolled to.
  for (let index = 0; index < 6; index += 1) await sendWithFiles(server, sessionId, `${index + 1}. ${"본문 줄입니다. Body line. ".repeat(60)}`, []);
  await missDelivered();
}

/**
 * A signature revoked before it expires (the connection code rotated): the tile's refused load re-signs the file once
 * and the new URL loads. Rotation ends the harness's own token, so this runs last.
 */
async function revokedLinks(app: App, language: Language) {
  // Opened at the bottom: the list carries fresh links, and the attachments' row is not mounted yet.
  await openSession(app, words[language].title);
  const fetched = Date.now();
  await app.page.expression("window.butlerApp.rotateConnectionCode().then(() => true)");
  await scrollToTop(app);
  if (Date.now() - fetched >= (TTL_SECONDS - 2) * 1000) throw new Error("setup too slow: the links expired before the row mounted");
  await check(`${language} revoked links: the refused tiles re-sign and load`, () => assertLoaded(app, SENT, 3));
}

async function language(language: Language, fixtures: FixtureFile[]) {
  const copy = getAppCopy(appLocaleFromLanguage(language));
  const modelSawSkip = { value: false };
  const stubs = stub(language, modelSawSkip);
  mkdirSync(join(evidence, language), { recursive: true });
  const release = join(evidence, language, "attach-release");
  writeFileSync(release, "release");
  const app = await browserAgentApp(join(evidence, language), stubs.stubToolCall, process.env.BUTLER_SMOKE_UI_ROOT, {
    config: { user: { name: "Smoke", language } }, stubReply: stubs.stubReply, env: { BUTLER_APP_SIGNED_URL_TTL_SECONDS: String(TTL_SECONDS), BUTLER_E2E_HOLD_POINT: "message_attachment", BUTLER_E2E_HOLD_RELEASE: release },
  });
  const cdp = await pageCdp(app);
  const cells = [[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]] as const;
  const device = (width: number) => width === 390 ? "phone" : "desktop";
  const capture = async (selector: string, state: string, prepare?: () => Promise<unknown>) => {
    for (const [width, theme] of cells) {
      await viewport(app, cdp, width, theme); await prepare?.();
      await crop(app, cdp, selector, `${state}-${theme}-${language}-${device(width)}`);
    }
    await viewport(app, cdp, 1440, "light");
  };
  try {
    const [photo, sunset, video, pdf, docx] = fixtures;
    const long = { ...pdf!, name: words[language].long };
    await seed(app, language, [...fixtures, long], release);
    await viewport(app, cdp, 1440, "light");
    await openSession(app, words[language].title);
    const opened = Date.now();
    const composer = `document.querySelector('${COMPOSER}')`;
    const longTile = (scope: string) => `${tileButton(scope, long.name)}?.closest('${TILE}')`;
    // The phone layout mounts its own composer, so each width fills a fresh one: 1, 3 and 6 files.
    for (const width of [1440, 390]) {
      const steps = [["composer-1", [photo!], 1], ["composer-3", [video!, pdf!], 2], ["composer-6", [sunset!, docx!, long], 3]] as const;
      await viewport(app, cdp, width, "light");
      for (const [state, files, media] of steps) {
        await attach(app, [...files]);
        if (width === 1440) await check(`${language} composer (${media} pictures/videos of ${state.slice(9)} files) loads`, () => assertLoaded(app, COMPOSER, media));
        for (const theme of ["light", "dark"] as const) { await viewport(app, cdp, width, theme); await openComposer(app); await crop(app, cdp, composer, `${state}-${theme}-${language}-${device(width)}`); }
      }
      if (width === 1440) await check(`${language} composer: long name truncates with the full name in the tooltip`, () => assertLongName(app, COMPOSER, long.name));
      for (const theme of ["light", "dark"] as const) { await viewport(app, cdp, width, theme); await openComposer(app); await crop(app, cdp, longTile(COMPOSER), `long-name-composer-${theme}-${language}-${device(width)}`); }
    }
    await viewport(app, cdp, 1440, "light");
    // The sent message mounts only once scrolled to, after its signed URLs expired.
    await sleep(Math.max(0, opened + (TTL_SECONDS + 3) * 1000 - Date.now()));
    const toTop = () => scrollToTop(app);
    await toTop();
    await check(`${language} sent message after the signed URLs expired: pictures and video load`, () => assertLoaded(app, SENT, 3));
    await capture(`document.querySelector('${SENT}')?.closest('article')`, "sent", toTop);
    await toTop();
    await check(`${language} sent message: long name truncates with the full name in the tooltip`, () => assertLongName(app, SENT, long.name));
    await capture(longTile(SENT), "long-name-sent", toTop);
    await skippedAndMissing(app, language, copy.conversation.attachmentUnavailable, modelSawSkip, capture);
    await revokedLinks(app, language);
  } catch (error) {
    writeFileSync(join(evidence, `${language}-failure.png`), await app.page.screenshot());
    throw error;
  } finally { cdp.close(); await app.stop(); }
}

async function skippedAndMissing(app: App, language: Language, unavailable: string, modelSawSkip: { value: boolean },
  capture: (selector: string, state: string, prepare?: () => Promise<unknown>) => Promise<void>) {
  const tagged = `[...${lastAnswer}.querySelectorAll('*')].some((node) => node.children.length === 0 && node.textContent.trim() === ${JSON.stringify(unavailable)})`;
  await openSession(app, words[language].missTitle);
  await check(`${language} missing delivered file keeps the unavailable tag`, () =>
    waitBrowser(() => app.page.expression(tagged), "unavailable tag on the missing file"));
  await capture(lastAnswer, "missing");
  await openSession(app, words[language].skipTitle);
  await waitBrowser(() => app.page.expression(`${lastAnswer}.textContent.includes(${JSON.stringify(words[language].skipReply)})`), "skipped-file answer");
  await check(`${language} policy-withheld .env shows no unavailable tag`, async () => {
    if (await app.page.expression(tagged)) throw new Error("the answer carries the unavailable tag");
  });
  await check(`${language} the model got the skip reason (skipped_files)`, async () => { if (!modelSawSkip.value) throw new Error("no skipped_files in the tool result"); });
  await capture(lastAnswer, "skipped");
}

let browser: Awaited<ReturnType<typeof launchSmokeBrowser>> | undefined;
try {
  browser = await launchSmokeBrowser();
  const maker = await browser.newPage();
  await maker.goto("about:blank");
  const sets = { ko: await mixedFixtures(maker, "ko"), en: await mixedFixtures(maker, "en") };
  const wide = await drawPhoto(maker, "wide.jpg", 1600, 900, 140);
  await maker.close(); await browser.close(); browser = undefined;
  for (const code of ["ko", "en"] as const) {
    // Two photos, the video, the PDF and the Word file; the long name reuses the PDF.
    const [photo, , video, pdf, docx] = sets[code];
    await language(code, [photo!, { ...wide, name: code === "ko" ? "노을.jpg" : "sunset.jpg" }, video!, pdf!, docx!]);
  }
} finally { await browser?.close(); }
console.log(failures.length ? `Failed checks (${phase}): ${failures.join("; ")}` : `Attachment thumbnails smoke passed (${phase})`);
if (failures.length && !baseline) process.exit(1);
