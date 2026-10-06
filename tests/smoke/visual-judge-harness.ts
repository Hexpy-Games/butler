// Integration smoke: screenshot artifacts and stub/replay boundary, no live model calls.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser.ts";
import { judgeScreenshotPair, type VisionRequest } from "../support/visual-judge.ts";

const output = mkdtempSync(join(tmpdir(), "visual-judge-"));
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
const enabled = process.env.BUTLER_VISUAL_JUDGE;
const replay = process.env.BUTLER_VISUAL_JUDGE_REPLAY;
try {
  const page = await browser.newPage();
  await page.setContent("<main><h1>Expected screen</h1><button>Continue</button></main>");
  const expected = join(output, "before.png");
  await page.screenshot({ path: expected });
  await page.locator("h1").evaluate(element => { element.textContent = "Actual screen"; });
  const actual = join(output, "after.png");
  await page.screenshot({ path: actual });
  const options = { expected, actual, expectation: "Heading and Continue button remain visible, readable and separate." };
  let calls = 0;
  let recorded: VisionRequest | undefined;
  const transport = { mode: "stub" as const, judge: async (request: VisionRequest) => {
    calls++; recorded = request;
    assert.equal(request.model, "openai/gpt-6-luna");
    assert.equal(request.messages[0].content.filter(part => part.type === "image_url").length, 2);
    return { pass: true, reason: "Synthetic stub verdict for transport verification only" };
  } };
  delete process.env.BUTLER_VISUAL_JUDGE;
  assert.equal(await judgeScreenshotPair({ ...options, transport }), undefined);
  assert.equal(calls, 0);
  process.env.BUTLER_VISUAL_JUDGE = "1";
  await judgeScreenshotPair({ ...options, transport });
  assert.equal(calls, 1);
  const digest = createHash("sha256").update(JSON.stringify(recorded)).digest("hex");
  const evidence = join(output, `${digest.slice(0, 16)}-judge`);
  assert.deepEqual(readFileSync(join(evidence, "expected.png")), readFileSync(expected));
  assert.deepEqual(readFileSync(join(evidence, "actual.png")), readFileSync(actual));
  await assert.rejects(judgeScreenshotPair({ ...options, transport: { mode: "stub", judge: async () => ({ pass: false, reason: "Clipped heading" }) } }), /Clipped heading/);
  await assert.rejects(judgeScreenshotPair({ ...options, transport: { mode: "stub", judge: async () => ({ pass: "true" }) } }), /Invalid vision verdict/);
  const cassette = join(output, "replay.json");
  writeFileSync(cassette, JSON.stringify({ [digest]: { pass: true, reason: "Recorded synthetic verdict" } }));
  process.env.BUTLER_VISUAL_JUDGE_REPLAY = cassette;
  await judgeScreenshotPair(options);
  await assert.rejects(judgeScreenshotPair({ ...options, expectation: "Different expectation" }), /No visual replay/);
  delete process.env.BUTLER_VISUAL_JUDGE_REPLAY;
  await assert.rejects(judgeScreenshotPair(options), /requires BUTLER_VISUAL_JUDGE_REPLAY/);
  console.log(JSON.stringify({ ok: true, cases: 7, stubCalls: calls, liveCalls: 0 }));
} finally {
  if (enabled === undefined) delete process.env.BUTLER_VISUAL_JUDGE; else process.env.BUTLER_VISUAL_JUDGE = enabled;
  if (replay === undefined) delete process.env.BUTLER_VISUAL_JUDGE_REPLAY; else process.env.BUTLER_VISUAL_JUDGE_REPLAY = replay;
  await browser.close(); rmSync(output, { recursive: true, force: true });
}
