// test-category: race
// Requires macOS and the Electron 44 dependency; not part of CI smoke because
// coverage needs real classic scrollbars. NSArgumentDomain sets the scrollbar
// policy per process only; offline VisualHarness fixtures never change system settings.
// For scroller S and content reference C (documented per surface), the gap is
// unused lane + extra inset vs overlay not explained by a drawn scrollbar, both
// measured inside S: unused + max(0, overlay(C.right - S.left) -
// classic(C.right - S.left) - drawn lane) + max(0, classic(C.left - S.left) -
// overlay(C.left - S.left)). The unused lane is the reserved lane when S fits;
// the drawn lane is the reserved lane when S overflows. Jump is the decrease in
// C.right - S.left from fits to overflows. JSON retains absolute C coordinates.
// A platform probe and explicit fit/overflow checks distinguish actual unused
// lanes from unavailable coverage or harness failures.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { fixtureData, installBridge, surfaces, unavailable, type State, type Surface } from "../support/classic-scrollbar-gap-surfaces.ts";
import { execFileSync, spawn } from "node:child_process";
import { assertTransition, sampleTransition } from "../support/classic-scrollbar-gap-frames.ts";
import { growTranscript } from "../support/classic-scrollbar-gap-growth.ts";
import { textSizeFactor } from "../../packages/butler-app/client/ui/src/app/textSize.ts";
import type { SettingsView } from "../../packages/butler-app/client/ui/src/app/types.ts";

// Keep the entry runnable with the repository's Bun script, but use Node's
// WebSocket transport for Playwright's CDP connection (Bun's handshake stalls).
if (typeof Bun !== "undefined") {
  const driver = spawn("node", ["--experimental-strip-types", import.meta.filename], { stdio: "inherit", env: process.env });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => driver.kill(signal));
  const code = await new Promise<number | null>((done, fail) => { driver.once("error", fail); driver.once("exit", done); });
  process.exit(code ?? 1);
}
const { spawnElectron, stopElectronChild } = await import("../support/electron-child.ts");

type Mode = "classic" | "overlay";
type Metric = { lane: number; laneApi: string; overflows: boolean; unused: number; end: number; start: number;
  content: { text: string; referenceText: string; items: number; icons: number; value: string };
  height: number; scrollHeight: number; overflowY: string; overflowsX: boolean; overflowX: string; dpr: number; rect: { x: number; y: number; width: number; height: number } };
type Cell = { metric?: Metric; error?: string; gap?: number; rawGap?: number };
type Row = { surface: Surface; cells: Record<string, Cell>; jump?: Partial<Record<Mode, number>>; rawJump?: Partial<Record<Mode, number>>; comparable?: Partial<Record<State, boolean>> };
const rows: Row[] = surfaces.map(surface => ({ surface, cells: {} }));
const conditions: unknown[] = [];
const textSize = process.env.BUTLER_SMOKE_TEXT_SIZE ?? "default";
assert(["default", "large", "larger"].includes(textSize), "invalid smoke text size");
const uiScale = textSizeFactor(textSize as SettingsView["text_size"]);
const zoomMeasurements = new Map<string, unknown[]>();
const probes: Partial<Record<Mode, number>> = {};
const harnessFailures: string[] = [];
const transitions: { surface: string; mode: Mode; trigger: string; result?: Awaited<ReturnType<typeof sampleTransition>>; error?: string }[] = [];
const shots = process.env.BUTLER_SCROLLBAR_GAP_SHOTS;
const report = process.env.BUTLER_SCROLLBAR_GAP_REPORT;
if (shots) mkdirSync(shots, { recursive: true });
const devicePixels = (n: number, dpr: number) => Math.round(Math.abs(n) * dpr) * Math.sign(n);
const fitFixtures = new Map<string, { height: number; compact: boolean }>();
const key = (state: State, mode: Mode) => `${state}/${mode}`;
const require = createRequire(resolve("packages/butler-app/client/electron/package.json"));
const electron: string = require("electron");
assert.equal(process.platform, "darwin", "Requires macOS NSArgumentDomain scrollbar policies; no simulated scrollbar flags permitted");

async function launch(mode: Mode) {
  const dir = mkdtempSync(join(tmpdir(), "butler-gap-"));
  for (const name of ["home", "data", "profile"]) mkdirSync(join(dir, name));
  let output = "";
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(dir, "home"), BUTLER_DATA: join(dir, "data"), BUTLER_GAP_PROFILE: join(dir, "profile"),
    BUTLER_APP_ELECTRON_USER_DATA_DIR: join(dir, "profile") };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnElectron(electron, [resolve("tests/support/classic-scrollbar-gap-main.mjs"),
    "-AppleShowScrollBars", mode === "classic" ? "Always" : "WhenScrolling", "--remote-debugging-port=0"],
  { env, cleanupPaths: [dir], onOutput: bytes => { output += bytes.toString(); } });
  try {
    const deadline = Date.now() + 30_000;
    while (!output.includes("GAP_HOST ") || !output.includes("DevTools listening on ")) {
      assert(child.exitCode === null, `Electron exited: ${output}`);
      assert(Date.now() < deadline, `Electron startup did not finish: ${output}`);
      await new Promise(done => setTimeout(done, 50));
    }
    const url = JSON.parse(output.match(/GAP_HOST (\{[^\n]+\})/u)![1]).url as string;
    console.error(`Electron ${mode}: host ready`);
    const browser = await chromium.connectOverCDP(output.match(/DevTools listening on (ws:\/\/[^\s]+)/u)![1], { timeout: 30_000 });
    console.error(`Electron ${mode}: CDP connected`);
    return { child, browser, url };
  } catch (error) { await stopElectronChild(child); throw error; }
}

async function resize(url: string, width: number, height: number) {
  return fetch(`${url}/__window?width=${width}&height=${height}`).then(response => response.json());
}

async function probe(page: Page, mode: Mode) {
  const measurement = await probeWidths(page);
  const width = measurement.native;
  probes[mode] = width;
  assert(mode === "classic" ? width > 0 : width === 0,
    `${mode} platform probe measured ${width}px; expected ${mode === "classic" ? "> 0" : "0"}. No gap evidence is valid for this process.`);
}

async function probeWidths(page: Page) {
  return page.evaluate(async () => {
    const node = document.createElement("div");
    node.style.cssText = "position:absolute;width:100px;height:100px;overflow-y:scroll;visibility:hidden";
    document.body.append(node);
    const lane = () => new Promise<number>(done => {
      const observer = new ResizeObserver(([entry]) => {
        observer.disconnect(); done(node.getBoundingClientRect().width - entry.contentRect.width);
      });
      observer.observe(node);
    });
    const native = await lane();
    node.style.scrollbarWidth = "thin";
    const thin = await lane();
    node.remove();
    return { native, thin, laneApi: "getBoundingClientRect - ResizeObserver.contentRect (unbordered, unpadded probe)", published: getComputedStyle(document.documentElement).getPropertyValue("--scrollbar-width").trim(),
      dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } };
  });
}

async function zoom(url: string, factor: number) {
  const response = await fetch(`${url}/__zoom?factor=${factor}`);
  assert(response.ok, `Zoom failed: ${await response.clone().text()}`);
  const result = await response.json();
  assert.equal(result.factor, factor);
  return result;
}

async function open(page: Page, url: string, surface: Surface, state: State, theme: string) {
  const fit = state === "fits" ? fitFixtures.get(surface.name) : undefined;
  let height = fit?.height ?? surface.heights?.[state === "fits" ? 0 : 1] ?? 860;
  let compact = fit?.compact ?? false;
  await openFixture(page, url, surface, state, theme, height, compact);
  if (state !== "fits" || surface.axis === "x") return;
  let metric = await measure(page, surface);
  if (metric.overflows) {
    // Request the missing CSS height in DIPs. macOS may cap the actual window.
    height += metric.scrollHeight - metric.height + 32;
    await resize(url, surface.width ?? 1280, Math.ceil(height * uiScale));
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    metric = await measure(page, surface);
    if (metric.overflows && !compact) {
      compact = true;
      await openFixture(page, url, surface, state, theme, height, compact);
    }
  }
  fitFixtures.set(surface.name, { height, compact });
}

async function openFixture(page: Page, url: string, surface: Surface, state: State, theme: string, height: number, compact: boolean) {
  await resize(url, surface.width ?? 1280, Math.ceil(height * uiScale));
  await zoom(url, 1);
  const data = fixtureData(state, compact);
  await fetch(`${url}/__fixture`, { method: "POST", body: JSON.stringify({ ...data, fixture: { ...data.fixture, storage: surface.storage?.(state) } }) });
  await page.goto(`${url}/?visual=components&theme=${theme}&locale=ko${surface.route ?? ""}`);
  await page.locator('[data-test-class~="conversation"], [data-test-class="editable-document"]').first().waitFor();
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--scrollbar-width") !== "");
  const before = await probeWidths(page);
  const window = await zoom(url, uiScale);
  await page.waitForFunction(({ dpr, factor }) => Math.abs(devicePixelRatio - dpr * factor) < 0.001,
    { dpr: before.dpr, factor: uiScale });
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const after = await probeWidths(page);
  assert(Math.abs(after.viewport.width - window.size[0] / uiScale) <= 1, "CSS viewport width must follow page zoom");
  assert(Math.abs(after.viewport.height - window.size[1] / uiScale) <= 1, "CSS viewport height must follow page zoom");
  zoomMeasurements.get(url)!.push({ surface: surface.name, state, theme, height, compact, before, after });
  await surface.navigate?.(page, state);
  await page.locator(surface.s).first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"
    || !(animation.timeline instanceof DocumentTimeline) || animation.effect?.getTiming().iterations === Infinity));
  await page.waitForTimeout(100);
  await page.bringToFront();
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function measure(page: Page, surface: Surface): Promise<Metric> {
  return page.locator(surface.s).first().evaluate(async (element, selector) => {
    const s = element as HTMLElement;
    const c = selector === ":scope" ? s : s.querySelector(selector);
    if (!c) throw new Error(`Content reference missing: ${selector}`);
    // ResizeObserver exposes the fractional content box excluding the scrollbar.
    const contentWidth = await new Promise<number>(done => {
      const observer = new ResizeObserver(([entry]) => { observer.disconnect(); done(entry.contentRect.width); });
      observer.observe(s);
    });
    const style = getComputedStyle(s), bounds = s.getBoundingClientRect(), content = c.getBoundingClientRect();
    const lane = bounds.width - contentWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
    const overflows = s.scrollHeight > s.clientHeight + 1;
    const text = (node: Element) => (node.textContent ?? "").replace(/\s+/gu, " ").trim();
    const contentIdentity = { text: text(s), referenceText: text(c),
      items: s.querySelectorAll('[role="menuitem"], [role="option"], [role="tab"], button, li').length,
      icons: s.querySelectorAll("svg").length, value: s instanceof HTMLTextAreaElement ? s.value : "" };
    return { content: contentIdentity, lane, laneApi: "getBoundingClientRect - ResizeObserver.contentRect - computed padding/borders", overflows, unused: overflows ? 0 : lane, end: content.right, start: content.left,
      height: s.clientHeight, scrollHeight: s.scrollHeight, overflowY: style.overflowY, dpr: devicePixelRatio,
      overflowsX: s.scrollWidth > s.clientWidth + 1, overflowX: style.overflowX,
      rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } };
  }, surface.c);
}

async function capture(page: Page, surface: Surface, state: State, mode: Mode, theme: string, metric: Metric) {
  if (!shots) return;
  const { rect } = metric;
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  const right = Math.min(viewport.width, rect.x + rect.width + 40);
  const edge = Math.max(0, rect.x + rect.width - 120);
  const height = Math.min(viewport.height - y, rect.height);
  assert(height > 0 && right > x, "Surface has no visible screenshot area");
  const session = await page.context().newCDPSession(page);
  try {
    for (const [suffix, left, width] of [["surface", x, Math.min(rect.width, viewport.width - x)], ["edge", edge, right - edge]] as const) {
      const result = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false,
        clip: { x: left, y, width, height, scale: 2 / metric.dpr } });
      writeFileSync(join(shots, `${surface.name}-${state}-${mode}-${theme}-${suffix}.png`), Buffer.from(result.data, "base64"));
    }
  } finally { await session.detach(); }
}

async function cell(page: Page, url: string, row: Row, state: State, mode: Mode) {
  const id = key(state, mode);
  try {
    await open(page, url, row.surface, state, "light");
    const metric = await measure(page, row.surface);
    row.cells[id] = { metric };
    await capture(page, row.surface, state, mode, "light", metric);
    await row.surface.leave?.(page);
    if (shots) {
      await open(page, url, row.surface, state, "dark");
      await capture(page, row.surface, state, mode, "dark", await measure(page, row.surface));
      await row.surface.leave?.(page);
    }
    const axis = row.surface.axis ?? "y";
    const overflowStyle = axis === "x" ? metric.overflowX : metric.overflowY;
    assert(["auto", "scroll"].includes(overflowStyle), `S is not a ${axis} scroller (${overflowStyle})`);
    assert.equal(axis === "x" ? metric.overflowsX : metric.overflows, state === "overflows",
      `requested ${state} on ${axis}, got scrollHeight=${metric.scrollHeight}, clientHeight=${metric.height}`);
  } catch (error) {
    const message = `${row.surface.name} ${id}: ${String(error)}`;
    console.error(message);
    row.cells[id] = { ...row.cells[id], error: message };
    harnessFailures.push(message);
  }
}

async function run(mode: Mode) {
  const host = await launch(mode);
  try {
    const context = host.browser.contexts()[0];
    const page = context.pages()[0];
    page.setDefaultTimeout(5000);
    await context.route("**/*", route => new URL(route.request().url()).origin === host.url ? route.continue() : route.abort());
    await installBridge(page);
    await probe(page, mode);
    const condition = await resize(host.url, 1280, 860);
    const consoleState = execFileSync("ioreg", ["-n", "Root", "-d1"], { encoding: "utf8" });
    const screenLocked = /"IOConsoleLocked"\s*=\s*Yes/u.test(consoleState);
    const measurements: unknown[] = [];
    zoomMeasurements.set(host.url, measurements);
    conditions.push({ mode, ...condition, screenLocked, textSize, uiScale, zoomMeasurements: measurements });
    assert(String(condition.electron).startsWith("44."), `Requires Electron 44, got ${condition.electron}`);
    await transitionCells(page, host.url, mode);
    for (const row of rows) for (const state of ["fits", "overflows"] as const) {
      console.error(`Measuring ${row.surface.name} ${state}/${mode}`);
      await cell(page, host.url, row, state, mode);
      if (report) writeFileSync(report + ".partial.json", JSON.stringify({ probes, conditions, rows, transitions, harnessFailures }, null, 2));
    }
  } finally {
    // Disconnecting CDP is followed by owned-group teardown, including failures.
    await disconnect(host.browser);
    await stopElectronChild(host.child);
  }
}
async function transitionCells(page: Page, url: string, mode: Mode) {
  for (const name of ["transcript", "dialog-self", "aside-docked", "settings-nav", "model-picker"]) {
    const surface = surfaces.find(surface => surface.name === name)!;
    for (const trigger of name === "transcript" ? ["messages", "window-shrink"] : [name === "model-picker" ? "filter" : "window-shrink"]) {
      const record: typeof transitions[number] = { surface: name, mode, trigger };
      transitions.push(record);
      try {
        console.error(`Sampling frames ${name} ${mode} ${trigger}`);
        await open(page, url, surface, name === "model-picker" ? "overflows" : "fits", "light");
        const search = page.locator('[data-slot="popover-content"] input');
        if (name === "model-picker") { await search.fill("Layout model 60"); await page.waitForTimeout(100); }
        record.result = await sampleTransition(page, surface, async () => {
          if (trigger === "messages") { await growTranscript(page); }
          else if (trigger === "filter") { await search.fill(""); }
          else { await resize(url, surface.width ?? 1280, Math.ceil((surface.heights?.[1] ?? 340) * uiScale)); }
        }, `${name}-${mode}-${trigger}`);
        console.error(JSON.stringify({ surface: name, mode, trigger, summaries: record.result.summaries }));
        if (name === "transcript" || name === "dialog-self") assertTransition(record.result);
      } catch (error) {
        record.error = String(error);
        console.error(`${name} ${mode} ${trigger}: ${record.error}`);
        harnessFailures.push(`${name} ${mode} ${trigger}: ${record.error}`);
      } finally { await surface.leave?.(page); }
    }
  }
}
async function disconnect(browser: Browser) { try { await browser.close(); } catch { /* process already exited */ } }

function calculate() {
  for (const row of rows) {
    for (const state of ["fits", "overflows"] as const) {
      const classic = row.cells[key(state, "classic")], overlay = row.cells[key(state, "overlay")];
      if (overlay?.metric && !overlay.error) {
        overlay.rawGap = overlay.metric.unused;
        overlay.gap = devicePixels(overlay.rawGap, overlay.metric.dpr);
      }
      if (classic?.metric && overlay?.metric && !classic.error && !overlay.error) {
        const c = classic.metric, o = overlay.metric;
        try {
          assert(c.content && o.content, `${row.surface.name} ${state}: missing content identity; rerun this surface`);
          assert.deepEqual(c.content, o.content, `${row.surface.name} ${state}: classic/overlay content differs`);
          (row.comparable ??= {})[state] = true;
        } catch (error) {
          (row.comparable ??= {})[state] = false;
          const message = String(error);
          classic.error = overlay.error = message;
          harnessFailures.push(message);
          continue;
        }
        classic.rawGap = c.unused + Math.max(0, (o.end - o.rect.x) - (c.end - c.rect.x) - (c.overflows ? c.lane : 0)) + Math.max(0, (c.start - c.rect.x) - (o.start - o.rect.x));
        classic.gap = devicePixels(classic.rawGap, c.dpr);
      }
    }
    for (const mode of ["classic", "overlay"] as const) {
      const fits = row.cells[key("fits", mode)]?.metric, overflows = row.cells[key("overflows", mode)]?.metric;
      if (fits && overflows) {
        const raw = (fits.end - fits.rect.x) - (overflows.end - overflows.rect.x);
        (row.rawJump ??= {})[mode] = raw;
        (row.jump ??= {})[mode] = devicePixels(raw, fits.dpr);
      }
    }
  }
}

function markdown() {
  const heading = "| Surface | fits/classic | fits/overlay | overflows/classic | overflows/overlay | raw lane CSS px fits/overflows | probe classic | jump classic / overlay |\n|---|---:|---:|---:|---:|---:|---:|---:|";
  const body = rows.map(row => {
    const cells = ["fits/classic", "fits/overlay", "overflows/classic", "overflows/overlay"].map(id => {
      const cell = row.cells[id];
      return cell?.error ? "ERROR" : cell?.gap === undefined ? "—" : cell.gap !== 0 ? `**${cell.gap}**` : "0";
    });
    const lane = (["fits", "overflows"] as const).map(state => row.cells[key(state, "classic")]?.metric?.lane).map(n => n === undefined ? "—" : Number(n.toFixed(6))).join(" / ");
    return `| ${row.surface.name} | ${cells.join(" | ")} | ${lane} | ${probes.classic ?? "—"} | ${row.jump?.classic ?? "—"} / ${row.jump?.overlay ?? "—"} |`;
  });
  return [heading, ...body].join("\n");
}

function inventory() {
  const root = "packages/butler-app/client/ui/src";
  const pattern = /overflow(?:-[xy])?\s*:\s*['"]?(?:auto|scroll|hidden auto)|overflow[XY]\s*:\s*['"](?:auto|scroll)/u;
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(?:css|tsx)$/u.test(entry.name)) files.push(path);
    }
  };
  walk(root);
  return files.sort().flatMap(path => readFileSync(path, "utf8").split(/\r?\n/u)
    .flatMap((text, index) => pattern.test(text) ? [`${path}:${index + 1}:${text}`] : []));
}

for (const mode of ["classic", "overlay"] as const) {
  try { await run(mode); }
  catch (error) { harnessFailures.push(`${mode}: ${String(error)}`); }
}
calculate();
const table = markdown();
console.log(table);
const selectors = rows.map(({ surface }) => ({ name: surface.name, S: surface.s, C: surface.c, note: surface.note }));
const payload = { table, units: "gap/jump: whole device pixels; rawGap/rawJump/metric/frame summaries: CSS px", probes, conditions,
  rows: rows.map(({ surface, ...row }) => ({ name: surface.name, ...row })), transitions, selectors, unavailable, inventory: inventory(), harnessFailures, shots };
if (report) {
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, JSON.stringify(payload, null, 2) + "\n");
  writeFileSync(report.replace(/\.json$/u, "") + ".md", table + "\n\n" + JSON.stringify({ selectors, unavailable, conditions, harnessFailures }, null, 2) + "\n");
}
console.log(JSON.stringify({ probes, conditions, selectors, unavailable, report, shots }, null, 2));
const gaps = rows.flatMap(row => Object.entries(row.cells).filter(([, cell]) => (cell.gap ?? 0) !== 0).map(([id, cell]) => `${row.surface.name} ${id}: ${cell.gap} device px (raw ${cell.rawGap} CSS px, dpr ${cell.metric?.dpr})`));
const missing = rows.flatMap(row => ["fits/classic", "fits/overlay", "overflows/classic", "overflows/overlay"].filter(id => row.cells[id]?.gap === undefined).map(id => `${row.surface.name} ${id}`));
assert.deepEqual(harnessFailures, [], `Harness failures (not gap evidence):\n${harnessFailures.join("\n")}`);
assert.deepEqual(missing, [], `Missing measurement cells: ${missing.join(", ")}`);
assert.deepEqual(gaps, [], `Unused scrollbar space:\n${gaps.join("\n")}`);
