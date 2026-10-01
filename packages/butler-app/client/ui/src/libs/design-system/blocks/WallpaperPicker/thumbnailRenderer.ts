// Edited/user wallpapers still use the exact renderer, on a worker rather than the UI thread.
import { loadWallpaperImageBytes } from "../Wallpaper/imageCache";
import { resolveWallpaperScene, wallpaperStillKey, type WallpaperRegistry } from "../Wallpaper";
import type { WallpaperSource, WallpaperTone } from "../Wallpaper/types";

const SIZE = { width: 320, height: 200 };
const LIMIT = 48;
const cache = new Map<string, Promise<Blob>>();
const pending = new Map<number, { resolve: (blob: Blob) => void; reject: (error: Error) => void }>();
let worker: Worker | null = null;
let sequence = 0;

function renderer(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./thumbnailWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
    const request = pending.get(data.id);
    pending.delete(data.id);
    if (data.blob) request?.resolve(data.blob);
    else request?.reject(new Error(data.error ?? "Thumbnail failed"));
  };
  worker.onerror = () => {
    for (const request of pending.values()) request.reject(new Error("Thumbnail worker failed"));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

async function draw(source: Extract<WallpaperSource, { kind: "live" }>, tone: WallpaperTone, registry: WallpaperRegistry): Promise<Blob> {
  const scene = resolveWallpaperScene(source, registry, tone);
  if (!scene) throw new Error("No thumbnail scene");
  const image = scene.image ? await loadWallpaperImageBytes(() => Promise.reject(new Error("No image loader")), scene.image.asset, "thumbnail") : undefined;
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      renderer().postMessage({ id, scene: { ...scene, module: { ...scene.module, defaultImage: undefined } }, image });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

/** Full fidelity stills, cached by actual params, tone and module revision; failures are evicted. */
export function renderPickerThumbnail(source: Extract<WallpaperSource, { kind: "live" }>, tone: WallpaperTone, registry: WallpaperRegistry): Promise<Blob> {
  const key = wallpaperStillKey(source, SIZE, tone, registry);
  const previous = cache.get(key);
  if (previous) {
    cache.delete(key); cache.set(key, previous);
    return previous;
  }
  const result = draw(source, tone, registry);
  cache.set(key, result);
  result.catch(() => { if (cache.get(key) === result) cache.delete(key); });
  if (cache.size > LIMIT) cache.delete(cache.keys().next().value!);
  return result;
}
