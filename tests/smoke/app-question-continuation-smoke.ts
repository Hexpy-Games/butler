// Real gateway/stub mid-turn forms: durable assistant segments and chronological answer rows.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { smokeBrowserArgs } from "../support/smoke-browser.ts";

let round = 0;
const texts = ["Before the first question.", "Before the second question.", "Before the third question.", "New continuation after all answers."];
// Background rounds (title, smart group) stream the same text but offer no tools; only the conversation turn does.
const isConversation = (request: import("../support/native-app-server.ts").StubModelRequest) =>
  request.stream && Array.isArray(request.body.tools) && request.body.tools.length > 0 && JSON.stringify(request.messages).includes("Help me choose.");
// A second request in the same chat: the question is answered later, after the reply ends.
const later = { round: 0, input: "" };
const isLater = (request: import("../support/native-app-server.ts").StubModelRequest) =>
  request.stream && Array.isArray(request.body.tools) && request.body.tools.length > 0 && JSON.stringify(request.messages).includes("Help me plan.");
const baseline = process.env.BUTLER_SMOKE_BASELINE === "1";
const server = await createNativeAppServer({
  uiRoot: process.env.BUTLER_SMOKE_UI_ROOT,
  config: { user: { name: "Smoke", language: "en" } },
  stubReply: request => {
    if (isLater(request)) {
      later.round++;
      if (later.round === 3) later.input = JSON.stringify(request.messages);
      return ["", "Card is up.", "Got your answer."][later.round - 1] ?? "";
    }
    return isConversation(request) ? (round++, round <= 3 ? "" : texts[3]) : "{}";
  },
  stubToolCall: request => isLater(request) ? (later.round === 1 ? { name: "ask_user", arguments: { questions: [{
    id: "platform", eyebrow: "Platform", title: "Where should it run?", kind: "single", allow_custom: false,
    options: [{ id: "web", label: "Web" }, { id: "mobile", label: "Mobile" }],
  }] } } : null) : isConversation(request) && round <= 3 ? { name: "ask_user", arguments: { questions: [{
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
  assert(!content.some(row => row.includes("Answers to your deferred questions")), `no raw follow-up: ${JSON.stringify(content)}`);
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
  // Answered later: the follow-up turn shows the answer card in place of the queued answer text.
  await page.locator('[data-slot="composer-compact-preview"]').click();
  await page.locator('[contenteditable="true"]').fill("Help me plan.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const panel = page.locator('[data-slot="composer-question-panel"]');
  await panel.getByText("Where should it run?", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Answer later", exact: true }).click();
  await page.getByText("Card is up.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Answer pending", exact: true }).click();
  await panel.getByText("Mobile", { exact: true }).click();
  await page.getByText("Got your answer.", { exact: true }).waitFor();
  expected.push("Help me plan.", "Card is up.", "Got your answer.");
  const answered = page.locator('[data-slot="question-answer-card"]').filter({ hasText: "Mobile" });
  await answered.waitFor();
  await transcript(page, expected);
  await page.reload();
  await page.getByText("Got your answer.", { exact: true }).waitFor();
  await answered.waitFor();
  await transcript(page, expected);
  assert.equal(await answered.count(), 1, "one answer card for the later answer");
  assert(later.input.includes("Answers to your deferred questions") && later.input.includes('\\"mobile\\"'), "the model still receives the answers");
  await captureLayouts(page, "answered-later", expected, "Got your answer.");
  console.log(JSON.stringify({ ok: true, service: "question-continuation", rounds: round, laterRounds: later.round, rows: expected.length, liveAndReload: true }));
} finally {
  await browser.close();
  await server.stop();
}
