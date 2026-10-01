/// <reference types="bun" />
import { expect, test } from "bun:test";
import { createWallpaperImageCache } from "./imageCache";
import type { WallpaperImageVariant } from "./types";

function recordingLoader({ fail = new Set<string>() }: { fail?: Set<string> } = {}) {
  const calls: Array<[string, WallpaperImageVariant]> = [];
  const loader = (asset: string, variant: WallpaperImageVariant) => {
    calls.push([asset, variant]);
    return fail.has(asset) ? Promise.reject(new Error(`404 ${asset}`)) : Promise.resolve(new Blob([`${asset}:${variant}`]));
  };
  return { calls, loader };
}

test("the loader runs once per asset and variant; repeated and concurrent requests share it", async () => {
  const { calls, loader } = recordingLoader();
  const cache = createWallpaperImageCache(loader);
  const [first, second] = await Promise.all([cache.blob("a", "full"), cache.blob("a", "full")]);
  expect(first).toBe(second);
  expect(await (await cache.blob("a", "full")).text()).toBe("a:full");
  expect(calls).toEqual([["a", "full"]]);
  await cache.blob("a", "thumbnail");
  await cache.blob("b", "full");
  expect(calls).toEqual([["a", "full"], ["a", "thumbnail"], ["b", "full"]]);
});

test("unused assets are released, so a later request loads again", async () => {
  const { calls, loader } = recordingLoader();
  const cache = createWallpaperImageCache(loader);
  await cache.blob("a", "full");
  await cache.blob("b", "full");
  cache.retain(new Set(["b"]));
  await cache.blob("b", "full");
  await cache.blob("a", "full");
  expect(calls).toEqual([["a", "full"], ["b", "full"], ["a", "full"]]);
});

test("a failed load is not cached: the next request retries", async () => {
  const fail = new Set(["a"]);
  const { calls, loader } = recordingLoader({ fail });
  const cache = createWallpaperImageCache(loader);
  await expect(cache.blob("a", "full")).rejects.toThrow("404 a");
  fail.clear();
  expect(await (await cache.blob("a", "full")).text()).toBe("a:full");
  expect(calls).toHaveLength(2);
});

test("a loader that throws synchronously rejects instead of throwing", async () => {
  const cache = createWallpaperImageCache(() => {
    throw new Error("offline");
  });
  await expect(cache.blob("a", "full")).rejects.toThrow("offline");
});
