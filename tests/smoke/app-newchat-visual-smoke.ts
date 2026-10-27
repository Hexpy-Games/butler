// Browser smoke: preview.6 content, computed surfaces and geometry; no unit-test ratchet growth.
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { captureNewChatMatrix, compareNewChatCase, type NewChatVisualCase } from "../support/newchat-visual.ts";

const reference = JSON.parse(readFileSync(new URL("../fixtures/newchat-preview6/reference.json", import.meta.url), "utf8")) as {
  revision: string; cases: Record<string, NewChatVisualCase>;
};
// Wrapping suggestions at 89c589074; pending owner approval (preview 14 큰 글자).
assert.equal(reference.revision, "89c589074fcb8a953f54c9ce04836b4f7d1cf2d2");
// Complete copy wraps in the header column; each grid row shares a height.
const CARD_HEIGHT_PX: Record<string, number> = { 1280: 186, 375: 206 };
const output = resolve(process.env.BUTLER_SMOKE_SCREENSHOTS ?? ".tmp/newchat-regression/fix");
const actual = await captureNewChatMatrix(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist", output);
assert.deepEqual(Object.keys(actual.cases), Object.keys(reference.cases), "All eight viewport/theme/wallpaper cases are required");
const failures: string[] = [];
let maxGeometryDelta = 0;
for (const [key, visual] of Object.entries(actual.cases)) {
  try { maxGeometryDelta = Math.max(maxGeometryDelta, compareNewChatCase(visual, reference.cases[key]!)); }
  catch (error) { failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`); }
  const expected = CARD_HEIGHT_PX[key.split("-")[0]!]!;
  const heights = visual.nodes.filter(node => node.slot === "tinted-glass").map(node => node.rect[3]!);
  if (heights.length !== 4 || heights.some(height => Math.abs(height - expected) >= 3))
    failures.push(`${key}: suggestion card heights ${JSON.stringify(heights)} vs ${expected} (3px incident threshold)`);
}
const report = { ok: failures.length === 0, reference: reference.revision, cases: 8, geometryIncidentPx: 3,
  maxGeometryDelta, modelCalls: actual.modelCalls, screenshots: actual.screenshots, failures };
writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, failures: failures.map(failure => failure.split("\n")[0]) }));
assert.equal(failures.length, 0, `New-chat visual regression: see ${output}/report.json`);
