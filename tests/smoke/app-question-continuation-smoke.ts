// Real gateway/stub mid-turn forms: durable assistant segments and chronological answer rows.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { smokeBrowserArgs } from "../support/smoke-browser.ts";

let round = 0;
const texts = ["Before the first question.", "Before the second question.", "Before the third question.", "New continuation after all answers."];
const isConversation = (request: import("../support/native-app-server.ts").StubModelRequest) =>
  request.stream && JSON.stringify(request.messages).includes("Help me choose.");
const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const server = await createNativeAppServer({
  uiRoot: process.env.BUTLER_SMOKE_UI_ROOT,
  config: { user: { name: "Smoke", language: "en" } },
  stubReply: request => isConversation(request) ? (round++, round <= 3 ? "" : texts[3]) : "{}",
  stubToolCall: request => isConversation(request) && round <= 3 ? { name: "ask_user", arguments: { questions: [{
    id: `format-${round}`, eyebrow: "Format", title: `Question ${round}?`, kind: "single", allow_custom: false,
    options: [{ id: "full", label: `Answer ${round}` }, { id: "brief", label: "Brief" }],
  }] } } : null,
});
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
const screenshots = process.env.BUTLER_SMOKE_SCREENSHOTS;
if (screenshots) mkdirSync(screenshots, { recursive: true });

async function transcript(page: import("playwright").Page, expected: string[]): Promise<void> {
  if (baseline) return;
  const rows = page.locator('[data-test-class~="message-list"] > article');
  const content = await rows.allTextContents();
  const indexes = expected.map(text => content.findIndex(row => row.includes(text)));
  assert(indexes.every((index, position) => index >= 0 && (position === 0 || index > indexes[position - 1])),
    `chronological distinct rows: ${JSON.stringify({ expected, content })}`);
  for (const text of expected) assert.equal(content.filter(row => row.includes(text)).length, 1, `retained once: ${text}`);
  if (expected.includes(texts[3])) {
    for (const question of [1, 2, 3]) {
      assert(content.find(row => row.includes(`Question ${question}?`))?.includes("1 record"), "each question owns its activity");
    }
    assert(!content.find(row => row.includes(texts[3]))?.includes("records"), "final segment does not repeat earlier question activity");
  }
}

async function captureLayouts(page: import("playwright").Page, name: string, expected: string[], ready: string) {
  if (!screenshots) return;
  for (const width of [375, 1280]) for (const theme of ["light", "dark"]) for (const wallpaper of [false, true]) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme, wallpaper: { source: wallpaper ? { kind: "live", module: "butler.bloom", params: { colors: "monochrome" } } : { kind: "none" } } }) });
    await page.setViewportSize({ width, height: 1600 });
    await page.reload();
    await page.getByText(ready, { exact: true }).first().waitFor();
    await transcript(page, expected);
    await page.screenshot({ path: resolve(screenshots, `${name}-${width}-${theme}-${wallpaper ? "wallpaper" : "plain"}.png`) });
  }
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await server.signIn(page);
  await page.goto(server.url);
  await page.locator('[data-slot="composer-compact-preview"]').click();
  await page.locator('[contenteditable="true"]').fill("Help me choose.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const expected = ["Help me choose."];
  for (const question of [1, 2, 3]) {
    const panel = page.locator('[data-slot="composer-question-panel"]');
    await panel.getByText(`Question ${question}?`, { exact: true }).waitFor();
    expected.push(`Question ${question}?`);
    await transcript(page, expected);
    if (screenshots) await page.screenshot({ path: resolve(screenshots, `question-${question}-pending.png`) });
    await captureLayouts(page, `question-${question}-pending`, expected, `Question ${question}?`);
    await page.reload();
    await panel.getByText(`Question ${question}?`, { exact: true }).waitFor();
    await transcript(page, expected);
    await panel.getByText(`Answer ${question}`, { exact: true }).click();
    await page.locator('[data-slot="question-answer-card"]').filter({ hasText: `Answer ${question}` }).waitFor();
    expected.push(`Answer ${question}`);
  }
  await page.getByText(texts[3], { exact: true }).waitFor();
  expected.push(texts[3]);
  await transcript(page, expected);
  await page.reload();
  await page.getByText(texts[3], { exact: true }).waitFor();
  await transcript(page, expected);
  assert.equal(round, 4, "exactly four stub rounds");
  await captureLayouts(page, "answered", expected, texts[3]);
  console.log(JSON.stringify({ ok: true, service: "question-continuation", rounds: round, rows: expected.length, liveAndReload: true }));
} finally {
  await browser.close();
  await server.stop();
}
