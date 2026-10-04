// Browser behavior smoke: public renderers, stub data, no model calls.
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser";

const stage = process.env.BUTLER_COPY_STAGE ?? "after";
const output = resolve(`.tmp/activity-copy/${stage}`);
const root = resolve(process.env.BUTLER_COPY_UI_ROOT ?? "packages/butler-app/client/ui/dist");
mkdirSync(output, { recursive: true });
const goal = "다운로드 폴더의 보고서를 확인해 주세요.";
const brief = `사용자 요청: '${goal}' 이번 수행은 내부 지시대로 하라. 내부 위임 지시입니다.`;
const block = "copy-goal";
const fixture = process.env.BUTLER_SMOKE_ACTIVITY_CAPTURE
  ? JSON.parse(readFileSync(process.env.BUTLER_SMOKE_ACTIVITY_CAPTURE, "utf8"))
  : { relation: { safe_title: goal }, latest_turn: { progress: { safe_progress_rows: [
    { id: "goal", kind: "message", state: "delivered", semantic_block_id: block,
      work_decision_source: "model-authored", work_decision_title: "요청 확인",
      work_decision_summary: brief, safe_label: "요청 확인", activity_stage: "conception" },
    ...["work", "plan", "checkpoint", "disposition"].map(kind => ({
      id: kind, kind, state: "delivered", semantic_block_id: block,
      safe_tool_name: "work_tool", safe_label: "도구 사용", bridge_phase: "btcc_operation" })),
    ...["run_command", "read_file"].map(name => ({ id: name, kind: "used_tool",
      state: "delivered", semantic_block_id: block, safe_tool_name: name,
      safe_input_label: "보고서.txt", safe_label: "도구 사용", bridge_phase: "btcc_operation" })),
  ] } } };
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const file = Bun.file(join(root, new URL(request.url).pathname));
  return new Response(await file.exists() ? file : Bun.file(join(root, "index.html")));
} });
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await page.addInitScript(value => {
    (window as Window & { butlerActivityFixture?: unknown }).butlerActivityFixture = value;
  }, fixture);
  for (const width of [1280, 375]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=quick-fixes&mode=activity&theme=${theme}&state=completed`);
    await page.locator('[data-harness-ready="true"]').waitFor();
    const conversation = page.locator('[data-test-class="turn-current-phase-activity"]').first();
    await conversation.locator('[data-test-class="toggle-turn-activity-disclosure"]').click();
    for (const surface of ["conversation", "modal"]) {
      if (surface === "modal") {
        await page.getByRole("button", { name: "위임 작업", exact: true }).click();
        await page.locator('[data-test-class="steward-observer-dialog"] [data-test-class="toggle-turn-activity-disclosure"]').click();
      }
      const activity = surface === "modal"
        ? page.locator('[data-test-class="steward-observer-dialog"]') : conversation;
      if (stage === "after") {
        const text = await activity.innerText();
        assert(!/\bWork\b|work_tool|이번 수행은|내부 위임 지시/u.test(text), "internal bookkeeping and brief stay hidden");
        if (!process.env.BUTLER_SMOKE_ACTIVITY_CAPTURE) {
          assert(text.includes(goal));
          assert(text.includes("1 명령, 1 조회"));
          assert.equal(await activity.locator('[data-truncate="true"]').count(), 1);
        }
      }
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => document.getAnimations().every(animation =>
        animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
      await page.screenshot({ path: join(output, `${surface}-${width}-${theme}.png`), fullPage: true });
    }
  }
  console.log(JSON.stringify({ stage, capturedFixture: Boolean(process.env.BUTLER_SMOKE_ACTIVITY_CAPTURE), screenshots: 8 }));
} finally { await browser.close(); server.stop(true); }
