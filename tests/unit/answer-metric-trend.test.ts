import { expect, test } from "bun:test";
import { answerMetricTrend } from "../../packages/butler-app/client/shared/answer-metric-trend";
import type { AnswerBlocksView } from "../../packages/butler-app/client/shared/answer-blocks-view";
import { parseAnswerBlocks } from "../../packages/butler-app/client/shared/answer-blocks-parse";

// test-category: pure-logic
test("metric color follows sign and direction, with the stored v1 default", () => {
  expect([answerMetricTrend("+2"), answerMetricTrend("-2"), answerMetricTrend("+2", "down-good"), answerMetricTrend("-2", "down-good")]).toEqual(["up", "down", "down", "up"]);
  for (const delta of [undefined, "2", "+2", "-2"]) expect(answerMetricTrend(delta, "neutral")).toBe("neutral");
  expect(answerMetricTrend("2")).toBe("neutral");
});

// test-category: pure-logic
test("stored v1 and v2 parsing preserves nested signed image decoration and numeric bounds", () => {
  expect(parseAnswerBlocks({ v: 1, blocks: [{ type: "callout", text: "Old" }] })?.v).toBe(1);
  const image_url = "/message-assets/img_0123456789?expires=123&signature=abc";
  const spec: AnswerBlocksView = { v: 2, blocks: [{ type: "group", blocks: [{ type: "image", img: "img_0123456789", image_url }, { type: "text", text: "**New**" }] }] };
  expect(parseAnswerBlocks(spec)).toEqual(spec);
  expect(parseAnswerBlocks({ v: 2, blocks: [{ type: "progress", items: [{ label: "A", value: -1 }, { label: "B", value: 1, max: 0 }] }] })).toBeNull();
});
