// test-category: pure-logic
import { expect, test } from "bun:test";
import { centringInsets, clampView, onPicture, outputImages, zoomAt } from "./imageOutputs";

test("outputImages finds nested JSON image entries and ignores objects without schema", () => {
  const images = outputImages({ output: JSON.stringify({ results: [
    { schema: "butler.image.v1", image: "first" },
    { schema: "butler.image.v1", image: "second" },
    { image: "ignored" },
  ] }) });
  expect(images.map(image => image.image)).toEqual(["first", "second"]);
});

test("clampView bounds pan and zoomAt keeps the zoom point still", () => {
  expect(clampView({ scale: 2, x: 500, y: -500 }, 200, 100)).toEqual({ scale: 2, x: 100, y: -50 });
  expect(zoomAt({ scale: 1, x: 0, y: 0 }, 2, 50, 0)).toEqual({ scale: 2, x: -50, y: 0 });
});

test("centringInsets centres fitted content and reaches zero at twice the scale", () => {
  expect(centringInsets({ width: 400, height: 800 }, 400, 400, 1)).toEqual({ top: 200, bottom: 200, left: 0, right: 0 });
  expect(centringInsets({ width: 400, height: 800 }, 400, 400, 2)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
});

test("onPicture distinguishes points above and inside the centred picture", () => {
  expect(onPicture({ x: 10, y: 150 }, { x: 0, y: -200 }, 400, 400, 1)).toBe(false);
  expect(onPicture({ x: 10, y: 250 }, { x: 0, y: -200 }, 400, 400, 1)).toBe(true);
});
