/// <reference types="bun" />
import { expect, test } from "bun:test";
import { defineWallpaperModule } from "./manifest";
import { BLOOM_WALLPAPER, SILK_WALLPAPER } from "./modules";
import { BUILTIN_WALLPAPERS, createWallpaperRegistry, type WallpaperScene } from "./registry";
import { createWallpaperStillRenderer, wallpaperStillKey, type WallpaperStillSize } from "./still";

const SIZE: WallpaperStillSize = { width: 320, height: 200 };

function recorder() {
  const scenes: Array<{ scene: WallpaperScene; size: WallpaperStillSize }> = [];
  const draw = (scene: WallpaperScene, size: WallpaperStillSize) => {
    scenes.push({ scene, size });
    return Promise.resolve(new Blob([`${scene.module.manifest.id}:${scenes.length}`]));
  };
  return { scenes, draw };
}

test("still keys: source content, tone and size; a module keys like its bare source", () => {
  const aurora = { kind: "live", module: "butler.bloom", params: { colors: "aurora", speed: 1 } } as const;
  const reordered = { params: { speed: 1, colors: "aurora" }, module: "butler.bloom", kind: "live" } as const;
  expect(wallpaperStillKey(aurora, SIZE, "light")).toBe(wallpaperStillKey(reordered, SIZE, "light"));
  expect(wallpaperStillKey(aurora, SIZE, "dark")).not.toBe(wallpaperStillKey(aurora, SIZE, "light"));
  expect(wallpaperStillKey(aurora, { width: 160, height: 100 }, "light")).not.toBe(wallpaperStillKey(aurora, SIZE, "light"));
  expect(wallpaperStillKey(BLOOM_WALLPAPER, SIZE, "light")).toBe(wallpaperStillKey({ kind: "live", module: "butler.bloom" }, SIZE, "light"));
});

test("equal requests share one render; tone and size render again", async () => {
  const { scenes, draw } = recorder();
  const stills = createWallpaperStillRenderer(draw);
  const first = stills.render({ kind: "live", module: "butler.silk" }, SIZE, "light");
  expect(stills.render({ module: "butler.silk", kind: "live" }, SIZE, "light")).toBe(first);
  expect(stills.render(SILK_WALLPAPER, SIZE, "light")).toBe(first);
  await stills.render(SILK_WALLPAPER, SIZE, "dark");
  await stills.render(SILK_WALLPAPER, { width: 160, height: 100 }, "light");
  expect(scenes.map(({ scene, size }) => [scene.dark, size.width])).toEqual([[false, 320], [true, 320], [false, 160]]);
  expect(await (await first).text()).toBe("butler.silk:1");
});

test("scenes resolve values for the tone; unknown modules draw the default", async () => {
  const { scenes, draw } = recorder();
  const stills = createWallpaperStillRenderer(draw);
  await stills.render(SILK_WALLPAPER, SIZE, "dark");
  await stills.render({ kind: "live", module: "me.gone" }, SIZE, "light");
  expect(scenes[0]?.scene.values).toEqual({ base: "#1a1b1e" });
  expect(scenes[1]?.scene.module).toBe(BLOOM_WALLPAPER);
});

test("a failed render is not cached, so the next request tries again", async () => {
  let fail = true;
  const stills = createWallpaperStillRenderer(() => (fail ? Promise.reject(new Error("lost")) : Promise.resolve(new Blob(["ok"]))));
  await expect(stills.render(SILK_WALLPAPER, SIZE, "light")).rejects.toThrow("lost");
  fail = false;
  expect(await (await stills.render(SILK_WALLPAPER, SIZE, "light")).text()).toBe("ok");
});

test("the cache keeps the most recently used stills", async () => {
  const { scenes, draw } = recorder();
  const stills = createWallpaperStillRenderer(draw, { limit: 2 });
  await stills.render(SILK_WALLPAPER, SIZE, "light");
  await stills.render(BLOOM_WALLPAPER, SIZE, "light");
  await stills.render(SILK_WALLPAPER, SIZE, "light");
  await stills.render(SILK_WALLPAPER, SIZE, "dark");
  expect(scenes).toHaveLength(3);
  // Bloom was the least recently used: it renders again; silk (dark) is still cached.
  await stills.render(BLOOM_WALLPAPER, SIZE, "light");
  await stills.render(SILK_WALLPAPER, SIZE, "dark");
  expect(scenes).toHaveLength(4);
});

test("still keys follow the module's content: a changed shader renders again", async () => {
  const flow = (fragment: string) => defineWallpaperModule({
    manifest: { id: "me.flow", name: { en: "Flow", ko: "흐름" }, version: "0.1.0", engine: 1, motion: "static", image: "none", params: [] },
    fragment,
  });
  const first = flow("void main(){fragColor=vec4(1.);}");
  const edited = flow("void main(){fragColor=vec4(.5);}");
  const before = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), first]);
  const after = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), edited]);
  const source = { kind: "live", module: "me.flow" } as const;
  expect(wallpaperStillKey(source, SIZE, "light", before)).not.toBe(wallpaperStillKey(source, SIZE, "light", after));
  expect(wallpaperStillKey(first, SIZE, "light")).toBe(wallpaperStillKey(source, SIZE, "light", before));
  const { scenes, draw } = recorder();
  const stills = createWallpaperStillRenderer(draw);
  await stills.render(source, SIZE, "light", before);
  await stills.render(source, SIZE, "light", after);
  await stills.render(source, SIZE, "light", after);
  expect(scenes.map(({ scene }) => scene.module)).toEqual([first, edited]);
});
