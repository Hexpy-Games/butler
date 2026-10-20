// Browser smoke: preview.6 content, computed surfaces and geometry; no unit-test ratchet growth.
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { captureNewChatMatrix, compareNewChatCase, type NewChatVisualCase } from "../support/newchat-visual.ts";

const reference = JSON.parse(readFileSync(new URL("../fixtures/newchat-preview6/reference.json", import.meta.url), "utf8")) as {
  revision: string; cases: Record<string, NewChatVisualCase>;
};
// #1239 (e60ee7b93): owner-approved light secondary text #696d73 -> #52565a.
assert.equal(reference.revision, "daa2a28c91daa2f20d2659d89ab182e8636f38c1");
// #924 (dcbd58d68): suggestion cards hug their ordinal and copy, with no empty
// art slot, and every card in the row shares one height (CSS px, per width).
const CARD_HEIGHT_PX: Record<string, number> = { 1280: 142, 375: 156 };
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
  if (heights.length !== 4 || heights.some(height => Math.abs(height - expected) > 1))
    failures.push(`${key}: suggestion card heights ${JSON.stringify(heights)} vs ${expected} (1px tolerance)`);
}
const report = { ok: failures.length === 0, reference: reference.revision, cases: 8, geometryTolerancePx: 1,
  maxGeometryDelta, modelCalls: actual.modelCalls, screenshots: actual.screenshots, failures };
writeFileSync(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, failures: failures.map(failure => failure.split("\n")[0]) }));
assert.equal(failures.length, 0, `New-chat visual regression: see ${output}/report.json`);
