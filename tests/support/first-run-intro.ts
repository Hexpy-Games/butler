import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import { settleFirstRun } from "./first-run-visual";

type IntroProbe = Window & { introGLDraws: number };

/** Count actual GL submissions in the renderer, including the reveal's two passes. */
export async function installIntroProbe(page: Page) {
  await page.addInitScript(() => {
    const state = window as unknown as IntroProbe;
    state.introGLDraws = 0;
    const original = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function (...args) {
      state.introGLDraws += 1;
      return original.apply(this, args);
    };
  });
}

/** The settled intro must hold its last frame with no GL work for 1.5 seconds. */
export async function assertIntroIdle(page: Page) {
  await settleFirstRun(page);
  const before = await page.evaluate(() => (window as unknown as IntroProbe).introGLDraws);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => (window as unknown as IntroProbe).introGLDraws);
  assert.equal(after - before, 0, "settled intro: 0 GL submissions over 1.5s");
  return { intervalMs: 1500, glSubmissions: after - before, revealSubmissions: before };
}
