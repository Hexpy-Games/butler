import { smokeBrowserArgs } from "../support/smoke-browser.ts";
// Four live App surfaces at both required widths/themes, with a deterministic tool provider.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { assertNewChatSurfaces } from "../support/newchat-visual.ts";

const output = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? "/tmp/onboarding-p7-screenshots");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
const screenshots: string[] = [];
try {
  // Reuse the context for sandboxed single-process Chromium.
  const page = await browser.newPage({ reducedMotion: "reduce" });
  for (const width of [375, 1280]) for (const theme of ["light", "dark"]) {
    let asked = false;
    const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist"), onboardingComplete: false,
      stubToolCall: request => {
        if (asked || !JSON.stringify(request.messages).includes("처음 설정을 도와주세요")) return null;
        asked = true;
        const tools = request.body.tools as Array<{ function?: { name?: string } }>;
        assert(tools.some(tool => tool.function?.name === "ask_user"), "onboarding session exposes ask_user");
        return { name: "ask_user", arguments: { questions: [{ id: "address", eyebrow: "호칭", title: "어떻게 불러드리면 좋겠습니까?", kind: "single", allow_custom: true,
          options: [{ id: "name", label: "이름으로 부르기", description: "알려주신 이름으로 부릅니다." }, { id: "nickname", label: "별명으로 부르기", description: "편한 별명을 알려주세요." }] }] } };
      } });
    await page.setViewportSize({ width, height: 900 });
    try {
      const now = new Date().toISOString();
      await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme, onboarding: { consent_version: 2, accepted_at: now, completed_at: now } }) });
      await server.signIn(page);
      await page.goto(server.url);
      await page.getByText("버틀러와 알아가기", { exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const capture = async (surface: string) => {
        await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        await page.waitForFunction(() => document.getAnimations().every(animation =>
          animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
        const path = `${output}/${surface}-${width}-${theme}-ko.png`;
        await page.screenshot({ path }); screenshots.push(path);
      };
      await assertNewChatSurfaces(page);
      await capture("new-chat");
      const general = page.getByRole("button", { name: "일반", exact: true });
      if (!(await general.isVisible())) await page.getByRole("button", { name: "사이드바 보기", exact: true }).click();
      await general.click();
      assert.equal(await page.locator('[data-test-class="titlebar-title"]').innerText(), "일반");
      // A mobile navigation selection closes its drawer; show it for this capture.
      if (!(await general.isVisible())) await page.getByRole("button", { name: "사이드바 보기", exact: true }).click();
      if (width === 375) await page.getByRole("button", { name: "사이드바 숨기기", exact: true }).last().click();
      await page.locator('[data-slot="composer-compact-preview"]').click();
      const editor = page.locator('[contenteditable="true"]');
      await editor.fill("안녕 "); await editor.press("End");
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 });
      const caret = await editor.evaluate(() => {
        const selection = window.getSelection()!; const text = selection.focusNode!.textContent!;
        const end = text.replace(/\u200b$/u, "").length; const glyph = document.createRange();
        glyph.setStart(selection.focusNode!, end - 1); glyph.setEnd(selection.focusNode!, end);
        return { offset: selection.focusOffset, end, delta: selection.getRangeAt(0).getBoundingClientRect().left - glyph.getBoundingClientRect().right };
      });
      assert.equal(caret.offset, caret.end); assert(Math.abs(caret.delta) < 1, JSON.stringify(caret));
      await capture("composition");
      await cdp.send("Input.insertText", { text: "한" }); await cdp.detach();
      await editor.fill("");
      await server.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text: "처음 설정을 도와주세요", client_message_id: crypto.randomUUID() }) });
      const panel = page.locator('[data-slot="composer-question-panel"]');
      await panel.waitFor();
      assert.equal(await panel.getByText("어떻게 불러드리면 좋겠습니까?", { exact: true }).count(), 1);
      await panel.getByRole("radio", { name: /직접 입력/u }).click();
      await panel.getByRole("textbox").fill("민수님");
      assert(!/ask_user|온보딩|스튜어드/u.test(await page.locator("body").innerText()), "Internal names stay out of visible copy");
      assert.equal(await page.getByText("답변을 기다리고 있습니다.", { exact: true }).count(), 1);
      await capture("question");
      if (width === 375) await page.getByRole("button", { name: "사이드바 보기", exact: true }).click();
      const row = await general.boundingBox();
      assert(row && row.x >= 0 && row.x + row.width <= width, "sidebar General row is inside the viewport");
      await capture("sidebar");
    } finally { await server.stop(); }
  }
  console.log(JSON.stringify({ ok: true, screenshots, cases: 16, caretTolerancePx: 1 }));
} finally { await browser.close(); }
