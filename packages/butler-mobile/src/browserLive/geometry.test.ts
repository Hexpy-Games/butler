// test-category: pure-logic
import { expect, test } from "bun:test";
import { fit, pageViewport, toFrame } from "./geometry";

test("page viewport is the stage in whole CSS px within what the gateway accepts", () => {
  const viewport = pageViewport({ width: 0, height: 0 }, { width: 390.4, height: 843.6 });
  expect(viewport).toEqual({ width: 390, height: 844 });
  expect(pageViewport(viewport, { width: 390.2, height: 843.8 })).toBe(viewport);
  expect(pageViewport(viewport, { width: 390, height: 500 })).toEqual({ width: 390, height: 500 });
  expect(pageViewport(viewport, { width: 844, height: 390 })).toEqual({ width: 844, height: 390 });
  expect(pageViewport(viewport, { width: 150, height: 2200 })).toEqual({ width: 200, height: 2000 });
  expect(pageViewport(viewport, { width: 1400, height: 150 })).toEqual({ width: 1280, height: 200 });
});

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
