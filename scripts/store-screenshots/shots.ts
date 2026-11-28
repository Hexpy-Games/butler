import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { timeBasedFiniteAnimationsSettled } from "../../tests/support/animation-settle.ts";
import { type App, type Locale, until, windowSetup } from "./app.ts";
import { storeScale } from "./ui.ts";

type Bounds = { x: number; y: number; width: number; height: number };
type Geometry = {
  display: { width: number; height: number; scaleFactor: number };
  windowBounds: Bounds;
  contentBounds: Bounds;
};
type View = { theme: string; language: string; visibleTextLength: number; uiScale: string; devicePixelRatio: number };
type Facts = Partial<Geometry & View> & { name: string; method?: string; screenError?: string; error?: string; evidenceError?: string; beforePixels?: object };

const screenScript = join(import.meta.dir, "screen.ps1");
const paint = "new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))";
const visibleToast = '[data-sonner-toast][data-visible="true"]';
const toastClose = `${visibleToast}[data-front="true"][data-mounted="true"][data-removed="false"] button[data-close-button]`;

async function closeToasts(app: App) {
  await until(async () => {
    const state = await app.page.expression<"clear" | "ready" | "waiting">(`(() => {
      if (!document.querySelector(${JSON.stringify(visibleToast)})) return 'clear';
      const button = document.querySelector(${JSON.stringify(toastClose)});
      if (!button) return 'waiting';
      const { x, y, width, height } = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(x + width / 2, y + height / 2)) ? 'ready' : 'waiting';
    })()`);
    if (state === "clear") return true;
    if (state === "ready") await app.page.clickSelector(toastClose);
    return false;
  }, "visible toasts to close");
}

function screen(...args: string[]) {
  const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", screenScript, ...args], { windowsHide: true, timeout: 20_000 });
  assert.equal(result.exitCode, 0, result.stderr.toString().trim() || "Screen command failed");
}

export async function focus(app: App) {
  return app.main.evaluate<Geometry>(`(() => {
    ${windowSetup}
    const { bounds, size, scaleFactor } = screen.getPrimaryDisplay();
    const displayScale = ${app.displayScale};
    if (!(Math.abs(scaleFactor - displayScale) < 0.01 &&
      Math.round(size.width * scaleFactor) === 1920 && Math.round(size.height * scaleFactor) === 1080))
      throw new Error('Expected 1920x1080 at scaleFactor ' + displayScale + ': ' + JSON.stringify({ size, scaleFactor }));
    win.setBounds(bounds);
    win.setAlwaysOnTop(true, 'screen-saver');
    app.focus({ steal: true });
    win.show(); win.focus(); win.moveTop();
    return { display: { ...size, scaleFactor }, windowBounds: win.getBounds(), contentBounds: win.getContentBounds() };
  })()`);
}

async function settle(app: App, bounds: Bounds) {
  const point = await app.page.evaluate(() => {
    for (const x of [900, 1000, 800, 1100, 700]) {
      const node = document.elementFromPoint(x, 16);
      if (node && !node.closest("button, a, input, select, [role=button], [title], [data-state=closed]")) return { x, y: 16 };
    }
    return { x: 900, y: 24 };
  });
  // The desktop cursor may be unavailable in a headless session. CDP also clears renderer hover.
  try {
    screen("-Mode", "Pointer", "-X", String(Math.round((bounds.x + point.x) * app.displayScale)),
      "-Y", String(Math.round((bounds.y + point.y) * app.displayScale)));
  } catch {}
  await app.page.movePointer(point.x, point.y);
  // A real pointer user sees no keyboard focus ring.
  await app.page.expression(`(document.activeElement?.matches(':focus-visible') && document.activeElement.blur(), true)`);
  await app.page.waitForFunction(() => !document.querySelector("[data-slot=tooltip-content]"));
  await app.page.expression(`(async () => { await document.fonts.ready; await ${paint}; })()`);
  await app.page.waitForFunction(timeBasedFiniteAnimationsSettled);
  await app.main.evaluate(`(async () => {
    ${windowSetup}
    await browserView()?.webContents.executeJavaScript(${JSON.stringify(paint)});
  })()`);
}

async function composite(app: App, path: string) {
  await app.main.evaluate(`(async () => {
    ${windowSetup}
    const size = { width: 1920, height: 1080 };
    const checkSize = (actual, expected) => {
      if (actual.width !== expected.width || actual.height !== expected.height)
        throw new Error('Unexpected capture dimensions: ' + JSON.stringify({ actual, expected }));
    };
    checkSize(win.getContentBounds(), size);
    const base = await win.webContents.capturePage();
    checkSize(base.getSize(), size);
    const view = browserView();
    if (!view) {
      process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(path)}, base.toPNG());
      return;
    }
    const { x, y, width, height } = view.getBounds();
    const overlay = await view.webContents.capturePage(undefined, { stayHidden: true });
    checkSize(overlay.getSize(), { width, height });
    const pixels = base.getBitmap(), tab = overlay.getBitmap();
    for (let row = Math.max(0, -y); row < Math.min(height, size.height - y); row++) {
      const start = Math.max(0, -x), end = Math.min(width, size.width - x);
      if (start < end) tab.copy(pixels, ((row + y) * size.width + x + start) * 4,
        (row * width + start) * 4, (row * width + end) * 4);
    }
    process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(path)}, nativeImage.createFromBitmap(pixels, size).toPNG());
  })()`, false, 25_000);
}

async function pixels(app: App, path: string, facts: Facts, beforePixels?: (app: App) => Promise<object>) {
  if (beforePixels) facts.beforePixels = await beforePixels(app);
  try {
    screen("-Mode", "Capture", "-Out", path);
    facts.method = "screen";
  } catch (error) {
    facts.screenError = app.safe(String(error));
    if (beforePixels) facts.beforePixels = await beforePixels(app);
    await composite(app, path);
    facts.method = "capturePage";
  }
  const png = readFileSync(path);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1920, 1080], "PNG dimensions");
}

export function shotRecorder(out: string, locale: Locale, selected: ReadonlySet<string>, displayScale: number) {
  mkdirSync(out, { recursive: true });
  const facts = { ...locale, displayScale, combinedScale: storeScale * displayScale,
    selected: [...selected], shots: [] as Facts[], stubRequests: {
    profile_import: 0, pattern_extraction: 0, pattern_proposal: 0, extract_profile_candidates: 0, other_memory_tasks: 0,
  } as Record<string, number>, memoryModel: null as unknown, memoryRun: null as unknown, errors: [] as string[] };
  return {
    facts,
    selected: (prefix: string) => selected.has(prefix),
    save: () => writeFileSync(join(out, "facts.json"), JSON.stringify(facts, null, 2) + "\n"),
    async shot(name: string, app: App | undefined, prepare: () => Promise<void>,
      beforePixels?: (app: App) => Promise<object>, onFailure?: (error: unknown) => Promise<unknown>) {
      if (!selected.has(name.slice(0, 2))) return;
      const entry: Facts = { name };
      facts.shots.push(entry);
      const path = join(out, `${name}.png`);
      try {
        if (app) Object.assign(entry, await focus(app));
        await prepare();
        assert(app, "Butler did not launch");
        const geometry = await focus(app);
        Object.assign(entry, geometry);
        // A toast can arrive while the frame settles (run 46126644309, en-US #2); close it and settle again.
        for (let attempt = 0; ; attempt++) {
          await closeToasts(app);
          await settle(app, geometry.contentBounds);
          if (!await app.page.expression<boolean>(`Boolean(document.querySelector(${JSON.stringify(visibleToast)}))`)) break;
          assert(attempt < 2, "A toast kept appearing before capture");
        }
        const view: View = await app.page.evaluate(() => ({
          theme: document.body.classList.contains("theme-dark") ? "dark" : "light",
          language: document.documentElement.lang,
          visibleTextLength: document.body.innerText.length,
          uiScale: getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim(),
          devicePixelRatio,
        }));
        Object.assign(entry, view);
        assert.equal(entry.theme, locale.theme);
        assert.equal(entry.language?.split("-")[0], locale.language);
        assert.equal(view.uiScale, String(storeScale), "Unexpected UI scale");
        assert(Math.abs(view.devicePixelRatio - storeScale * app.displayScale) < 0.01, `Unexpected devicePixelRatio: ${view.devicePixelRatio}`);
        await pixels(app, path, entry, beforePixels);
      } catch (error) {
        const failure = onFailure ? await onFailure(error).catch(() => error) : error;
        entry.error = app ? app.safe(String(failure)) : String(failure);
        rmSync(path, { force: true });
        try {
          const failed = join(out, `${name}-FAILED.png`);
          if (app) {
            await focus(app).catch(() => {});
            await closeToasts(app);
            await pixels(app, failed, entry);
          } else {
            screen("-Mode", "Capture", "-Out", failed);
            entry.method = "screen";
          }
        } catch (evidenceError) {
          entry.evidenceError = app ? app.safe(String(evidenceError)) : String(evidenceError);
        }
      }
    },
  };
}
