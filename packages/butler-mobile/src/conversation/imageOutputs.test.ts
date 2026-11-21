// test-category: pure-logic
import { expect, test } from "bun:test";
import { clampView, outputImages, zoomAt } from "./imageOutputs";

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
