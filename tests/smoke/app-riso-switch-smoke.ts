// test-category: race
// Real App UI with replayed gateway responses: switching between a new chat and a chat keeps one riso print, and it never
// draws bare (no keep-out) while the next screen loads.
import { strict as assert } from "node:assert";
import type { MessageRecord } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { installInitiatedGateway, session } from "../support/initiated-fixtures";
import { launchSmokeBrowser } from "../support/smoke-browser";

type Draw = { keep: boolean; column: boolean };
const CANVAS = 'canvas[data-test-class~="conversation-wallpaper"]';
const messages = Array.from({ length: 3 }, (_, i) => [
  { id: `ask-${i}`, chat_id: "general", turn_id: `turn-${i}`, role: "user", status: "sent", cursor: 2 * i + 1,
    created_at: `2026-10-26T0${i}:00:00Z`, text: `${i}번째 질문` },
  { id: `answer-${i}`, chat_id: "general", turn_id: `turn-${i}`, role: "assistant", status: "delivered", cursor: 2 * i + 2,
    created_at: `2026-10-26T0${i}:01:00Z`, text: `${i}번째 답변` },
] as MessageRecord[]).flat();

const browser = await launchSmokeBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("riso-switch-smoke")) {
      sessionStorage.setItem("riso-switch-smoke", "1");
      localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({ schema: "butler.app-ui-state.v1",
        cached_at: new Date().toISOString(), active_session_id: "other", left_open: true, right_open: false }));
    }
    // Every draw of the conversation wallpaper: whether the print had a content keep-out or its column on.
    const draws: Draw[] = [];
    Object.assign(window, { __risoDraws: draws });
    const names = new WeakMap<WebGLUniformLocation, string>();
    const last = new WeakMap<WebGL2RenderingContext, { keep: number; column: number }>();
    const proto = WebGL2RenderingContext.prototype;
    const locate = proto.getUniformLocation;
    proto.getUniformLocation = function (program, name) {
      const location = locate.call(this, program, name);
      if (location) names.set(location, name);
      return location;
    };
    const upload = proto.uniform4f;
    proto.uniform4f = function (location, x, y, z, w) {
      const name = location ? names.get(location) : undefined;
      if (name === "u_contentRect" || name === "u_col") {
        const state = last.get(this) ?? { keep: 0, column: 0 };
        if (name === "u_contentRect") state.keep = z;
        else state.column = w;
        last.set(this, state);
      }
      upload.call(this, location, x, y, z, w);
    };
    const drawArrays = proto.drawArrays;
    proto.drawArrays = function (mode, first, count) {
      const state = last.get(this);
      if (state && (this.canvas as HTMLCanvasElement).matches('canvas[data-test-class~="conversation-wallpaper"]')) {
        draws.push({ keep: state.keep > 0, column: state.column > 0 });
      }
      drawArrays.call(this, mode, first, count);
    };
  });
  await installInitiatedGateway(page, "ko", "light", session(messages));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/session-view*", async route => {
    if (new URL(route.request().url()).searchParams.get("session_id") === "general") await held;
    await route.fallback();
  });
  await page.goto("http://127.0.0.1:43827/");
  await page.evaluate(() => fetch("http://127.0.0.1:43827/settings", { method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversation_background: { source: { kind: "live", module: "butler.riso-print" }, overlay: 0 } }) }));
  await page.reload();
  await page.locator(`${CANVAS}[data-painted-module="butler.riso-print"]`).waitFor({ state: "attached" });
  await page.waitForFunction(() => (window as unknown as { __risoDraws: Draw[] }).__risoDraws.some(draw => draw.keep));
  await page.evaluate(selector => {
    document.querySelector<HTMLCanvasElement>(selector)!.dataset.smokeCanvas = "first";
    (window as unknown as { __risoDraws: Draw[] }).__risoDraws.length = 0;
  }, CANVAS);

  // New chat -> a chat whose view is still loading, then its messages; then back to the new chat.
  await page.locator('[data-tree-item="s:general"] [data-test-class~="tree-row"]').click();
  await page.waitForTimeout(300);
  release();
  await page.getByText("2번째 답변").waitFor();
  await page.waitForTimeout(500);
  await page.locator('[data-tree-item="s:other"] [data-test-class~="tree-row"]').click();
  await page.getByText("2번째 답변").waitFor({ state: "hidden" });
  await page.waitForTimeout(500);

  const draws = await page.evaluate(() => (window as unknown as { __risoDraws: Draw[] }).__risoDraws);
  assert(draws.length > 0, "the print drew during the switches");
  assert(draws.every(draw => draw.keep || draw.column), `the print never draws bare between screens: ${JSON.stringify(draws)}`);
  assert.equal(await page.locator(`${CANVAS}[data-smoke-canvas="first"]`).count(), 1, "one wallpaper stays mounted across both switches");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, draws: draws.length }));
} finally {
  await browser.close();
}
