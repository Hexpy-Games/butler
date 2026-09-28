/// <reference types="bun" />
import { expect, test } from "bun:test";
import { NO_WALLPAPER_CONTENT_RECT, wallpaperContentRectUniform } from "./contentRect";

const VIEWPORT = { left: 0, top: 0, width: 1000, height: 600 };
const BUFFER_2X = { width: 2000, height: 1200 };

test("the content rect maps client CSS px to drawing-buffer px with a bottom-left origin", () => {
  // 100px from the left, 50px from the top, 400×200 CSS px at 2 buffer px per CSS px.
  expect(wallpaperContentRectUniform({ x: 100, y: 50, width: 400, height: 200 }, VIEWPORT, BUFFER_2X))
    .toEqual([200, 700, 800, 400]);
});

test("container canvases subtract their own client offset and scale per axis", () => {
  const canvas = { left: 300, top: 120, width: 500, height: 250 };
  const buffer = { width: 500, height: 250 };
  expect(wallpaperContentRectUniform({ x: 350, y: 170, width: 100, height: 50 }, canvas, buffer)).toEqual([50, 150, 100, 50]);
});

test("the rect is clipped to the canvas", () => {
  expect(wallpaperContentRectUniform({ x: -100, y: 500, width: 300, height: 300 }, VIEWPORT, BUFFER_2X))
    .toEqual([0, 0, 400, 200]);
});

test("unknown, empty, off-canvas or non-finite rects are zeros", () => {
  expect(NO_WALLPAPER_CONTENT_RECT).toEqual([0, 0, 0, 0]);
  expect(wallpaperContentRectUniform(null, VIEWPORT, BUFFER_2X)).toEqual(NO_WALLPAPER_CONTENT_RECT);
  expect(wallpaperContentRectUniform(undefined, VIEWPORT, BUFFER_2X)).toEqual(NO_WALLPAPER_CONTENT_RECT);
  expect(wallpaperContentRectUniform({ x: 10, y: 10, width: 0, height: 40 }, VIEWPORT, BUFFER_2X)).toEqual(NO_WALLPAPER_CONTENT_RECT);
  expect(wallpaperContentRectUniform({ x: 1200, y: 10, width: 100, height: 40 }, VIEWPORT, BUFFER_2X)).toEqual(NO_WALLPAPER_CONTENT_RECT);
  expect(wallpaperContentRectUniform({ x: Number.NaN, y: 10, width: 100, height: 40 }, VIEWPORT, BUFFER_2X)).toEqual(NO_WALLPAPER_CONTENT_RECT);
  expect(wallpaperContentRectUniform({ x: 0, y: 0, width: 10, height: 10 }, { ...VIEWPORT, width: 0 }, BUFFER_2X)).toEqual(NO_WALLPAPER_CONTENT_RECT);
});
