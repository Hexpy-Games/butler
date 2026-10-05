// Real App typing under unrelated SSE/work-status refreshes, on a stub agent.
// Checks the committed controls, DOM identity, focus, geometry and full submitted draft.
import { installKeystrokeTiming, readKeystrokeTiming } from "../support/composer-keystroke-timing.ts";
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { chromium, firefox, webkit, type Page } from "playwright";
import { assertTypingLayout, readComposerText } from "../support/transcript-layout-probe.ts";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { installComposerRenderProbe, readComposerRenderProbe, resetComposerRenderProbe } from "../support/composer-render-probe.ts";
import { smokeBrowserArgs } from "../support/smoke-browser.ts";
import { appCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import type { SessionSummary, SessionView } from "../../packages/butler-app/client/ui/src/app/types.ts";

type Frame = { same: boolean; focused: boolean; height: number };
type FrameWindow = Window & { __composerFrames: Frame[]; __composerFrameId: number };
const server = await createNativeAppServer({
  uiRoot: resolve("packages/butler-app/client/ui/dist"),
  config: { user: { name: "Smoke", language: "en" } },
  stubReply: () => "Complete stub answer.",
});
const engines = { chromium, firefox, webkit };
const names = process.env.BUTLER_SMOKE_BROWSER ? [process.env.BUTLER_SMOKE_BROWSER] : Object.keys(engines);

async function beginFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as FrameWindow;
    const editor = document.querySelector('[contenteditable="true"]');
    target.__composerFrames = [];
    const tick = () => {
      const current = document.querySelector('[contenteditable="true"]');
      const card = document.querySelector('[data-test-class="composer-card"]')!;
      target.__composerFrames.push({ same: editor === current, focused: document.activeElement === current,
        height: card.getBoundingClientRect().height });
      target.__composerFrameId = requestAnimationFrame(tick);
    };
    tick();
  });
}

try {
  for (const name of names) {
    const engine = engines[name as keyof typeof engines];
    assert(engine, `Unknown smoke browser: ${name}`);
    const browser = await engine.launch({ headless: true, args: engine === chromium ? smokeBrowserArgs() : [] });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await installComposerRenderProbe(page);
      await server.signIn(page);
      let workStatusReads = 0;
      let usageReads = 0;
      let activeSessionId = "";
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/messages" && request.method() === "POST" &&
            request.postDataJSON().text === "Seed conversation") activeSessionId = request.postDataJSON().chat_id;
        if (new URL(request.url()).pathname === "/work-status") workStatusReads += 1;
        if (new URL(request.url()).pathname === "/usage-monitor") usageReads += 1;
      });
      await page.goto(server.url);
      await page.locator('[contenteditable="true"]').click();
      const editor = page.locator('[contenteditable="true"]');
      await editor.fill("Seed conversation");
      await page.locator('[data-test-class="composer-card"]').getByRole("button", { name: "Send", exact: true }).click();
      await page.getByText("Complete stub answer.", { exact: true }).waitFor();
      await page.locator('[data-test-class="context-donut-button"]').waitFor({ state: "attached" });
      await page.locator('[contenteditable="true"]').click();
      const running = page.getByRole("tab", { name: appCopy.space.running, exact: true });
      if (!(await running.isVisible())) {
        await page.getByRole("button", { name: appCopy.titlebar.showLeftPanel, exact: true }).click();
      }
      await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === "/work-status"),
        running.click(),
      ]);
      await editor.fill("D");
      await editor.focus();
      await page.waitForFunction(() => document.getAnimations().every((animation) =>
        animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
      // Drain the sidebar's 1.5s replay reconciliation before measuring input alone.
      await page.waitForTimeout(1800);
      const initialRenders = await readComposerRenderProbe(page);
      assert((initialRenders["composer-controls-row"] ?? 0) > 0, "render probe observes the controls row at mount");
      await resetComposerRenderProbe(page);
      await installKeystrokeTiming(page);
      await editor.pressSequentially(" typing probe", { delay: 100 });
      const typingRenders = await readComposerRenderProbe(page);
      assert.equal(typingRenders["composer-controls-row"] ?? 0, 0, "nonempty typing does not rerender the controls row");
      assert.equal(typingRenders["composer-shell"] ?? 0, 0, "nonempty typing does not rerender the composer shell");
      assert.deepEqual(Object.keys(typingRenders).filter(key => key.startsWith("outside:")), [],
        "zero extra renders outside the composer per keystroke");
      console.log(JSON.stringify({ phase: "typing-only", characters: 13, commit: await readKeystrokeTiming(page, 13), typingRenders }));
      await assertTypingLayout(page, engine.name());
      await editor.fill("D");
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      await resetComposerRenderProbe(page);
      await beginFrames(page);
      const readsBefore = workStatusReads;
      const usageBefore = usageReads;
      const suffix = "raft survives typing and live refresh.";
      // The updates use the normal gateway API and reach the real SSE connection.
      const external = (await server.api<{ session: SessionSummary }>("/sessions", {
        method: "POST", body: JSON.stringify({ kind: "chat", title: "Other conversation" }),
      })).session;
      await Promise.all([
        editor.pressSequentially(suffix, { delay: 100 }),
        server.api("/messages", { method: "POST", body: JSON.stringify({
          chat_id: external.id, text: "Unrelated live update", client_message_id: `client-${crypto.randomUUID()}`,
        }) }),
        page.waitForResponse((response) => new URL(response.url()).pathname === "/work-status"),
      ]);
      const frames = await page.evaluate(() => {
        const target = window as unknown as FrameWindow;
        cancelAnimationFrame(target.__composerFrameId);
        return target.__composerFrames;
      });
      const renders = await readComposerRenderProbe(page);
      assert(frames.length > 10, "sampled frames during input and refetch");
      assert(frames.every((frame) => frame.same && frame.focused));
      const heights = frames.map((frame) => frame.height);
      const heightDrift = Math.max(...heights) - Math.min(...heights);
      assert.equal(heightDrift, 0, "single-line typing/refetch must not change composer height");
      assert.equal(renders["context-donut-button-unchanged"] ?? 0, 0, "typing does not rerender the unchanged context ring");
      assert.equal(renders["model-button"] ?? 0, 0, "typing does not rerender the unchanged model control");
      assert(workStatusReads > readsBefore, "work-status actually refreshed during typing");
      assert.equal(usageReads, usageBefore, "closed usage popover performs no per-keystroke reads");
      const latest = await server.api<SessionView>(`/session-view?session_id=${encodeURIComponent(activeSessionId)}`);
      const offset = await page.locator('[data-test-class="context-donut-button"]').evaluate((node) =>
        Number((node as HTMLElement).style.getPropertyValue("--context-offset")));
      assert(Math.abs(offset - 2 * Math.PI * 8 * (1 - latest.context!.ratio!)) < 0.00001,
        "a real context change must reach the ring; memoization must not serve stale usage");
      assert.equal(await readComposerText(page), `D${suffix}`, "complete draft survives every update");
      // Stable event wrappers must read the latest draft, including keyboard submission.
      const sent = page.waitForRequest((request) => new URL(request.url()).pathname === "/messages" && request.method() === "POST");
      await editor.press("Control+Enter");
      assert.equal((await sent).postDataJSON().text, `D${suffix}`);
      await page.locator('[data-test-class="user-message-text"]').filter({ hasText: `D${suffix}` }).waitFor();
      console.log(JSON.stringify({ ok: true, service: "composer-refresh", browser: engine.name(),
        typedCharacters: suffix.length, frames: frames.length, heightDrift, renders,
        workStatusReads: workStatusReads - readsBefore, usageReads: usageReads - usageBefore }));
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.stop();
}
