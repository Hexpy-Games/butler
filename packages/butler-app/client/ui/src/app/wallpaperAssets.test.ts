/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test";
import {
  WALLPAPER_UPLOAD_MAX_BYTES,
  deleteWallpaperAsset,
  listWallpaperAssets,
  loadWallpaperAssetImage,
  uploadWallpaperAsset,
  uploadedWallpaperSource,
  wallpaperAssetProblem,
  wallpaperUploadProblem,
  type WallpaperAsset,
} from "./wallpaperAssets";

const ASSET: WallpaperAsset = {
  id: "wp_0123456789abcdef0123456789abcdef", width: 3840, height: 2160, luminance: 0.72, color: "#c0a080", bytes: 812_000, createdAt: "2026-09-28T01:00:00Z",
};

const saved = { fetch: globalThis.fetch, window: Object.getOwnPropertyDescriptor(globalThis, "window") };
afterEach(() => {
  globalThis.fetch = saved.fetch;
  if (saved.window) Object.defineProperty(globalThis, "window", saved.window); else Reflect.deleteProperty(globalThis, "window");
});

type Call = { url: string; method: string; body?: unknown };

/** Browser mode: no desktop bridge, same-origin fetch answering from `routes`. */
function browser(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(input), method, body: init?.body });
    const route = routes[`${method} ${String(input)}`];
    return route ? route() : new Response("{}", { status: 404 });
  }) as typeof fetch;
  return calls;
}

const envelope = (data: unknown, status = 200) => new Response(JSON.stringify({ protocol_version: "butler.app.v1", data }), { status });
const failure = (code: string, status: number) => new Response(JSON.stringify({ error: { code, message: "raw server text" } }), { status });

test("uploads are checked before they leave: JPEG, PNG or WebP up to 25 MB", () => {
  expect(wallpaperUploadProblem({ type: "image/png", size: 10 })).toBeNull();
  expect(wallpaperUploadProblem({ type: "image/webp", size: WALLPAPER_UPLOAD_MAX_BYTES })).toBeNull();
  expect(wallpaperUploadProblem({ type: "image/gif", size: 10 })).toBe("unsupported-type");
  expect(wallpaperUploadProblem({ type: "image/jpeg", size: WALLPAPER_UPLOAD_MAX_BYTES + 1 })).toBe("too-large");
  // No type from the OS: the gateway sniffs the bytes.
  expect(wallpaperUploadProblem({ type: "", size: 10 })).toBeNull();
});

test("an uploaded image is selected filling the screen, dimmed for its luminance", () => {
  expect(uploadedWallpaperSource(ASSET)).toEqual({ kind: "image", asset: ASSET.id, fit: "cover", dim: 0.3, blur: 0 });
  expect(uploadedWallpaperSource({ ...ASSET, luminance: 0.15 }).dim).toBe(0);
  expect(uploadedWallpaperSource({ ...ASSET, luminance: 0.95 }).dim).toBe(0.4);
});

test("gateway failures map to what the toast says; raw server text never shows", () => {
  const coded = (code: string, status = 400) => Object.assign(new Error("raw"), { code, status });
  expect(wallpaperAssetProblem(coded("wallpaper_in_use", 409))).toBe("in-use");
  expect(wallpaperAssetProblem(coded("wallpaper_unsupported_type", 415))).toBe("unsupported-type");
  expect(wallpaperAssetProblem(coded("wallpaper_too_large", 413))).toBe("too-large");
  expect(wallpaperAssetProblem(coded("wallpaper_image_invalid"))).toBe("unreadable");
  expect(wallpaperAssetProblem(coded("wallpaper_dimensions_unsupported"))).toBe("unreadable");
  expect(wallpaperAssetProblem(coded("payload_too_large", 413))).toBe("too-large");
  expect(wallpaperAssetProblem(coded("request_failed", 500))).toBe("failed");
  expect(wallpaperAssetProblem(new Error("offline"))).toBe("failed");
});

test("browser mode: list (oldest first), upload, delete and bytes over same-origin fetch", async () => {
  const older = { ...ASSET, id: "wp_older" };
  const calls = browser({
    "GET /wallpapers": () => envelope({ wallpapers: [ASSET, older] }),
    "POST /wallpapers": () => envelope(ASSET, 201),
    [`DELETE /wallpapers/${ASSET.id}`]: () => envelope({ id: ASSET.id, deleted: true }),
    [`GET /wallpapers/${ASSET.id}/thumbnail`]: () => new Response(new Blob(["thumb"], { type: "image/jpeg" })),
    [`GET /wallpapers/${ASSET.id}`]: () => new Response(new Blob(["full"], { type: "image/jpeg" })),
  });
  expect((await listWallpaperAssets()).map((asset) => asset.id)).toEqual(["wp_older", ASSET.id]);
  const file = new File(["png"], "sea.png", { type: "image/png" });
  expect(await uploadWallpaperAsset(file)).toEqual(ASSET);
  expect((calls[1]?.body as FormData).get("file")).toBeInstanceOf(File);
  await deleteWallpaperAsset(ASSET.id);
  expect(await (await loadWallpaperAssetImage(ASSET.id, "thumbnail")).text()).toBe("thumb");
  expect(await (await loadWallpaperAssetImage(ASSET.id, "full")).text()).toBe("full");
  expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
    "GET /wallpapers", "POST /wallpapers", `DELETE /wallpapers/${ASSET.id}`, `GET /wallpapers/${ASSET.id}/thumbnail`, `GET /wallpapers/${ASSET.id}`,
  ]);
});

test("browser mode: a rejected request throws with its code and status", async () => {
  browser({
    [`DELETE /wallpapers/${ASSET.id}`]: () => failure("wallpaper_in_use", 409),
    "POST /wallpapers": () => failure("wallpaper_unsupported_type", 415),
    [`GET /wallpapers/${ASSET.id}`]: () => failure("wallpaper_not_found", 404),
  });
  const problem = (promise: Promise<unknown>) => promise.then(() => "ok", wallpaperAssetProblem);
  expect(await problem(deleteWallpaperAsset(ASSET.id))).toBe("in-use");
  expect(await problem(uploadWallpaperAsset(new File(["x"], "a.png", { type: "image/png" })))).toBe("unsupported-type");
  await expect(loadWallpaperAssetImage(ASSET.id, "full")).rejects.toMatchObject({ code: "wallpaper_not_found", status: 404 });
});

test("desktop mode: the preload bridge carries the requests, auth and bytes", async () => {
  const calls: Array<[string, unknown]> = [];
  const bridge = {
    listWallpapers: async () => { calls.push(["listWallpapers", undefined]); return { ok: true, data: { wallpapers: [ASSET] } }; },
    uploadWallpaper: async (input: { name: string; mimeType: string; bytes: ArrayBuffer }) => {
      calls.push(["uploadWallpaper", { name: input.name, mimeType: input.mimeType, size: input.bytes.byteLength }]);
      return { ok: true, data: ASSET };
    },
    deleteWallpaper: async (input: unknown) => {
      calls.push(["deleteWallpaper", input]);
      return { ok: false, error: { code: "wallpaper_in_use", status: 409 } };
    },
    readWallpaperImage: async (input: unknown) => {
      calls.push(["readWallpaperImage", input]);
      return { ok: true, data: { bytes: new TextEncoder().encode("jpeg").buffer, mimeType: "image/jpeg" } };
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { butlerApp: bridge } });
  globalThis.fetch = (() => Promise.reject(new Error("fetch must not be used"))) as unknown as typeof fetch;
  expect(await listWallpaperAssets()).toEqual([ASSET]);
  expect(await uploadWallpaperAsset(new File(["abc"], "sea.webp", { type: "image/webp" }))).toEqual(ASSET);
  await expect(deleteWallpaperAsset(ASSET.id)).rejects.toMatchObject({ code: "wallpaper_in_use", status: 409 });
  const blob = await loadWallpaperAssetImage(ASSET.id, "thumbnail");
  expect([blob.type, await blob.text()]).toEqual(["image/jpeg", "jpeg"]);
  expect(calls).toEqual([
    ["listWallpapers", undefined],
    ["uploadWallpaper", { name: "sea.webp", mimeType: "image/webp", size: 3 }],
    ["deleteWallpaper", { id: ASSET.id }],
    ["readWallpaperImage", { id: ASSET.id, variant: "thumbnail" }],
  ]);
});
