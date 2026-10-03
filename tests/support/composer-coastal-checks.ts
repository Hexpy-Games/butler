import assert from "node:assert/strict";
import type { Page } from "playwright";

const frames = (page: Page) => page.locator("[data-decoration-perf]").evaluate(node => JSON.parse((node as HTMLElement).dataset.metrics!).frames as number);
async function frozen(page: Page, reason: string) {
  await page.waitForTimeout(100);
  const before = await frames(page);
  await page.waitForTimeout(450);
  assert.equal(await frames(page), before, reason);
}
async function playing(page: Page) {
  const before = await frames(page);
  await page.waitForTimeout(450);
  assert((await frames(page)) > before, "coast animates without typing");
}

export async function checkCoastalLifecycle(page: Page) {
  await page.waitForSelector("canvas[data-ready=true]");
  assert.equal(await page.locator("canvas").getAttribute("data-error"), null);
  const size = await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => ({
    width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight,
  }));
  assert(size.width <= size.cssWidth + 1 && size.height <= size.cssHeight + 1, "raster density capped at 1x");
  await playing(page);
  const first = await page.locator("canvas").screenshot();
  await page.waitForTimeout(250);
  assert(!first.equals(await page.locator("canvas").screenshot()), "the live shader changes rendered pixels");
  await page.getByRole("textbox", { name: "Try your message" }).blur();
  await playing(page);
  await page.getByLabel("Mode", { exact: true }).selectOption("static");
  await frozen(page, "static coast is one rendered frame");
  const still = await page.locator("canvas").screenshot();
  await page.waitForTimeout(150);
  assert(still.equals(await page.locator("canvas").screenshot()), "static pixels stay identical");
  await page.getByLabel("Mode", { exact: true }).selectOption("interactive");
  await playing(page);
  await page.getByRole("switch", { name: "Reduce motion", exact: true }).check();
  await frozen(page, "shared reduced-motion freezes coast");
  await page.getByRole("switch", { name: "Reduce motion", exact: true }).uncheck();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await frozen(page, "OS reduced-motion freezes coast");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await playing(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await frozen(page, "hidden coast stops");
  await page.evaluate(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await playing(page);
  await page.locator("[data-decoration-layer]").evaluate(node => {
    (node as HTMLElement).style.transform = "translateY(20000px)";
  });
  await frozen(page, "offscreen coast stops");
  await page.locator("[data-decoration-layer]").evaluate(node => { (node as HTMLElement).style.transform = ""; });
  await playing(page);
  await page.getByRole("textbox", { name: "Try your message" }).press("a");
  await page.waitForFunction(() => {
    const gl = document.querySelector("canvas")!.getContext("webgl2")!;
    const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    return gl.getUniform(program, gl.getUniformLocation(program, "p_foamAmount")!) > 0.61;
  });
  await page.waitForTimeout(450);
  const foam = await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext("webgl2")!;
    const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    return gl.getUniform(program, gl.getUniformLocation(program, "p_foamAmount")!) as number;
  });
  assert(Math.abs(foam - 0.6) < 0.0001, "typing foam pulse settles back to ambient");
  await page.getByRole("textbox", { name: "Try your message" }).press("Backspace");
}
