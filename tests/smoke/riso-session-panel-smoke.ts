// Renderer smoke through the isolated native gateway with a canonical session replay.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";
import { populatedSession, replaySession } from "../support/session-info-fixtures";
import { assertWallpaperPaint } from "../support/wallpaper-paint";
import type { SessionView } from "../../packages/butler-app/client/ui/src/app/types";

const cases = ["light", "dark"].flatMap(theme => ["reduce", "no-preference"].map(motion => `${theme}-${motion}`));
if (await runSmokeCases(cases, "BUTLER_RISO_CASE", import.meta.path, { isolate: true })) process.exit(0);
const [theme, ...motionParts] = (process.env.BUTLER_RISO_CASE ?? cases[0]!).split("-");
const motion = motionParts.join("-") as "reduce" | "no-preference";
const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const shots = join(process.env.BUTLER_SMOKE_SCREENSHOTS ?? process.env.TMPDIR ?? "/tmp", "captures");
mkdirSync(shots, { recursive: true });
const server = await createNativeAppServer({ uiRoot: process.env.BUTLER_SMOKE_UI_ROOT });
const browser = await launchSmokeBrowser();
try {
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
    reduce_motion: motion === "reduce", conversation_background: { source: { kind: "live", module: "butler.riso-print" }, overlay: 0 } }) });
  const { session } = await server.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Riso layout" }) });
  const view = populatedSession(await server.api<SessionView>(`/session-view?session_id=${session.id}`));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: motion });
  // Read the actual print uniform, without changing the renderer or its animation clock.
  await page.addInitScript(id => {
    localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({ schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id, left_open: true, right_open: false }));
    const names = new WeakMap<WebGLUniformLocation, string>();
    const proto = WebGL2RenderingContext.prototype;
    const locate = proto.getUniformLocation;
    proto.getUniformLocation = function(program, name) {
      const location = locate.call(this, program, name);
      if (location) names.set(location, name);
      return location;
    };
    const upload = proto.uniform4f;
    proto.uniform4f = function(location, x, y, z, w) {
      if (location && names.get(location) === "u_col" && (this.canvas as HTMLCanvasElement).matches('[data-test-class~="conversation-wallpaper"]')) {
        Object.assign(window, { risoColumn: [x, y, z, w] });
      }
      if (location && names.get(location) === "u_contentRect2" && (this.canvas as HTMLCanvasElement).matches('[data-test-class~="conversation-wallpaper"]')) {
        Object.assign(window, { risoComposer: [x, y, z, w] });
      }
      upload.call(this, location, x, y, z, w);
    };
  }, session.id);
  await replaySession(page, () => view);
  await server.signIn(page);
  await page.goto(server.url);
  await page.locator('[data-test-class="session-info-toggle"]').waitFor();
  await assertWallpaperPaint(page, '[data-test-class~="conversation-wallpaper"]', "butler.riso-print");
  const capture = (state: string) => page.screenshot({ path: join(shots, `${baseline ? "before" : "after"}-${theme}-${motion}-${state}.png`) });
  const toggle = page.locator('[data-test-class="session-info-toggle"]');
  const results: unknown[] = [];
  await settle(page);
  results.push(await geometry(page));
  await capture("closed");
  for (const state of ["open", "closed-again"]) {
    await toggle.click();
    await capture(`${state}-just-toggled`);
    await settle(page);
    await capture(state);
    const measured = await geometry(page);
    results.push(measured);
    if (!baseline) assert(measured.error < 1 && measured.composerError < 1, `Riso follows ${state} without window resize: ${JSON.stringify(measured)}`);
  }
  // Resize the content area without a viewport resize, including a fixed-width column.
  await page.locator('[data-test-class~="conversation"]').evaluate(node => { node.style.width = "1000px"; });
  await settle(page);
  const resized = await geometry(page);
  if (!baseline) assert(resized.error < 1 && resized.composerError < 1, `Riso follows container resize: ${JSON.stringify(resized)}`);
  assert.equal(page.viewportSize()!.width, 1440);
  console.log(JSON.stringify({ theme, motion, baseline, results, resized, screenshots: shots, stubModelCalls: server.stubModelCalls.length }));
} finally {
  await browser.close();
  await server.stop();
}

async function settle(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"
    || animation.timeline !== document.timeline || animation.effect?.getTiming().iterations === Infinity));
  // The print's existing zone tween follows the column glide.
  await page.waitForTimeout(700);
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-test-class~="conversation-wallpaper"]')!.getBoundingClientRect();
    const column = document.querySelector('[data-column-glide="messages"]')
      ?? document.querySelector('[data-test-class~="message-list"]');
    if (!column) throw new Error("Message column missing");
    const rect = column.getBoundingClientRect();
    const aside = document.querySelector('[data-slot="conversation-aside"][data-layout="docked"]')?.getBoundingClientRect();
    const expected = [rect.left - canvas.left, Math.max(rect.right, aside?.right ?? 0) - canvas.left];
    const actual = (window as unknown as { risoColumn: number[] }).risoColumn;
    if (!actual) throw new Error("No riso column uniform captured");
    const composer = document.querySelector('[data-test-class~="composer-card"]')!.getBoundingClientRect();
    const keepOut = (window as unknown as { risoComposer: number[] }).risoComposer;
    const composerError = Math.abs(keepOut[0]! / keepOut[2]! * composer.width - (composer.left - canvas.left));
    return { expected, actual, composerError, error: Math.max(...expected.map((value, i) => Math.abs(value - actual[i]!))) };
  });
}
