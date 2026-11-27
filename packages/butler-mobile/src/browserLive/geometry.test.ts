// test-category: pure-logic
import { expect, test } from "bun:test";
import { fit, toFrame } from "./geometry";

test("fits a landscape frame on a portrait stage", () => {
  const box = fit({ width: 200, height: 400 }, { width: 800, height: 400 });
  expect(box).toEqual({ x: 0, y: 150, width: 200, height: 100 });
  expect(toFrame({ x: 50, y: 200 }, box)).toEqual({ x: 0.25, y: 0.5 });
  expect(toFrame({ x: 50, y: 149 }, box)).toBeNull();
});

test("fits a portrait frame on a landscape stage", () => {
  const box = fit({ width: 400, height: 200 }, { width: 400, height: 800 });
  expect(box).toEqual({ x: 150, y: 0, width: 100, height: 200 });
  expect(toFrame({ x: 200, y: 50 }, box)).toEqual({ x: 0.5, y: 0.25 });
  expect(toFrame({ x: 149, y: 50 }, box)).toBeNull();
});
