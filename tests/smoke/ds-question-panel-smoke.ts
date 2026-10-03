import { launchSmokeBrowser } from "../support/smoke-browser.ts";
// Showcase harness only: static DS Viewer, no gateway, product state or model calls.
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { type Page } from "playwright";

const dist = resolve("packages/butler-app/client/ui/dist-ds-site");
const output = resolve(".tmp/question-panel");
mkdirSync(output, { recursive: true });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
  const path = new URL(request.url).pathname;
  const file = Bun.file(join(dist, path === "/" ? "index.html" : path));
  return new Response(file);
} });
const browser = await launchSmokeBrowser();
function assert(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
async function visit(page: Page, block = "ComposerQuestionPanel", width = 1440, theme = "light", reduced = false) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`http://127.0.0.1:${server.port}/?page=blocks/${block}&locale=ko&width=${width < 640 ? width : "app"}&theme=${theme}&motion=${reduced ? "reduced" : "full"}`);
  await page.locator('[data-ds-story]').first().waitFor();
}
function story(page: Page, name: string) { return page.locator('[data-ds-story]').filter({ has: page.getByText(name, { exact: true }) }).first(); }
async function interactions(page: Page) {
  const single = story(page, "Single choice · recommended focus · Other");
  assert(await single.locator('[aria-checked="true"]').count() === 0, "recommendation must not select");
  await single.getByRole("radio").first().click();
  assert(await single.locator('[data-slot="question-answer-card"]').count() === 1, "single tap sends");
  const multi = story(page, "Multiple choice · scroll fades");
  const panel = multi.locator('[data-slot="composer-question-panel"]');
  await panel.focus(); await page.keyboard.press("1"); await page.keyboard.press("2"); await page.keyboard.press("Space");
  assert(await multi.locator('[aria-checked="true"]').count() === 1, "Space toggles highlighted multi option");
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp");
  assert(await multi.getByRole("checkbox").nth(1).evaluate((n) => n === document.activeElement), "arrows move actual row focus");
  await page.keyboard.press("Enter");
  assert((await multi.locator('[data-slot="question-answer-card"]').innerText()).includes("작업 완료"), "multi keyboard sends complete label");
  const text = story(page, "Short text");
  assert(await text.getByRole("button", { name: "보내기", exact: true }).isDisabled(), "empty text disables send");
  await text.getByRole("textbox").fill("   ");
  assert(await text.getByRole("button", { name: "보내기", exact: true }).isDisabled(), "whitespace is unanswered");
  await text.getByRole("textbox").fill("분기 보고서"); await text.getByRole("textbox").press("Enter");
  assert((await text.locator('[data-slot="question-answer-card"]').innerText()).includes("분기 보고서"), "text sends");
  const four = story(page, "Four questions · partial answers");
  await four.getByRole("tab", { name: "확인", exact: true }).click();
  assert((await four.innerText()).includes("건너뜀"), "review labels skipped");
  await four.getByRole("button", { name: "보내기", exact: true }).click();
  assert((await four.locator('[data-slot="question-answer-card"]').innerText()).match(/건너뜀/g)?.length === 4, "all unanswered remain in summary");
  const working = story(page, "Working · disabled");
  assert(await working.getByRole("radio").first().getAttribute("aria-disabled") === "true", "working disables options");
  const collapsed = story(page, "Collapsed · answer by message");
  await collapsed.getByRole("textbox").fill("메일부터 정리해줘");
  await collapsed.getByRole("button", { name: "보내기", exact: true }).click();
  assert((await collapsed.locator('[data-slot="question-answer-card"]').innerText()).includes("메시지로 답함"), "message closes form");
  const keyboard = story(page, "Keyboard · focus panel to start");
  await keyboard.locator('[data-slot="composer-question-panel"]').focus(); await page.keyboard.press("4");
  await keyboard.getByRole("textbox").press("Escape");
  assert(await keyboard.getByRole("textbox").count() === 0, "Esc exits Other input");
  await keyboard.locator('[data-slot="composer-question-panel"]').focus(); await page.keyboard.press("4");
  await keyboard.getByRole("textbox").fill("직접 경로"); await keyboard.getByRole("textbox").press("Enter");
  assert((await keyboard.locator('[data-slot="question-answer-card"]').innerText()).includes("직접 경로"), "Other sends text");
  const schedule = story(page, "Three questions · Tabs · review");
  await schedule.locator('[data-slot="composer-question-panel"]').focus(); await page.keyboard.press("ArrowLeft");
  assert(await schedule.getByRole("tab").first().getAttribute("aria-selected") === "true", "left changes question");
  await page.keyboard.press("ArrowRight");
  assert(await schedule.getByRole("tab").nth(1).getAttribute("aria-selected") === "true", "right changes question");
  await schedule.getByRole("checkbox").first().click();
  await schedule.locator('[data-slot="composer-question-panel"]').focus(); await page.keyboard.press("Escape");
  await schedule.getByRole("button", { name: "답변 대기", exact: true }).click();
  assert(await schedule.locator('[aria-checked="true"]').count() === 1, "collapse and resume preserve draft");
  await schedule.getByRole("button", { name: "건너뛰기", exact: true }).click();
  await schedule.getByRole("button", { name: "건너뛰기", exact: true }).click();
  assert((await schedule.innerText()).includes("건너뜀"), "question skip reaches review");
  const submitting = story(page, "Submitting");
  assert(await submitting.getByRole("button", { name: "보내기", exact: true }).isDisabled(), "submitting disables send");
  const error = story(page, "Error · retry");
  assert(await error.getByRole("alert").isVisible(), "error announced");
  await error.getByRole("button", { name: "보내기", exact: true }).click();
  assert(await error.locator('[data-slot="question-answer-card"]').count() === 1, "error retains answer for retry");
  const onboarding = story(page, "Onboarding · new chat first turn");
  await onboarding.getByRole("textbox").fill("민수"); await onboarding.getByRole("textbox").press("Enter");
  await onboarding.getByRole("radio").first().click(); await onboarding.getByRole("radio").first().click();
  await onboarding.getByRole("button", { name: "보내기", exact: true }).click();
  assert((await onboarding.locator('[data-slot="question-answer-card"]').innerText()).includes("민수"), "onboarding advances and keeps first answer");
}
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await visit(page); await interactions(page);
  let renders = 0;
  for (const block of ["ComposerQuestionPanel", "QuestionAnswerCard"]) {
    for (const width of [320, 375, 390, 430, 1440]) for (const theme of ["light", "dark"]) {
      await visit(page, block, width, theme, true);
      const overflow = await page.locator('[data-ds-fixture-canvas]').evaluateAll((nodes) => nodes.filter((n) => n.scrollWidth > n.clientWidth + 1).length);
      assert(overflow === 0, `${block} ${width} ${theme}: ${overflow} overflowing canvases`);
      await page.screenshot({ path: join(output, `${block}-${width}-${theme}.png`), fullPage: true });
      renders++;
    }
  }
  assert(errors.length === 0, `browser errors: ${errors.join("; ")}`);
  console.log(`PASS: question interactions; ${renders} renders, 5 widths × 2 themes × 2 blocks, reduced motion; no canvas overflow or browser errors`);
} finally { await browser.close(); server.stop(true); }
