// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { WALLPAPER_NOISE_SIZE, wallpaperNoiseTexture } from "./noise";

test("the noise texture is a deterministic 256×256 RGBA buffer", () => {
  const first = wallpaperNoiseTexture();
  expect(WALLPAPER_NOISE_SIZE).toBe(256);
  expect(first).toBeInstanceOf(Uint8Array);
  expect(first.length).toBe(256 * 256 * 4);
  expect(wallpaperNoiseTexture()).toEqual(first);
});

test("each channel is independent, evenly spread noise", () => {
  const noise = wallpaperNoiseTexture();
  for (let channel = 0; channel < 4; channel += 1) {
    let sum = 0;
    const buckets = new Array(8).fill(0);
    for (let index = channel; index < noise.length; index += 4) {
      sum += noise[index]!;
      buckets[noise[index]! >> 5] += 1;
    }
    const texels = noise.length / 4;
    expect(sum / texels).toBeGreaterThan(120);
    expect(sum / texels).toBeLessThan(135);
    for (const count of buckets) expect(Math.abs(count / texels - 1 / 8)).toBeLessThan(0.01);
  }
  // Channels are not copies of each other.
  expect(noise[0] === noise[1] && noise[4] === noise[5] && noise[8] === noise[9]).toBe(false);
});
