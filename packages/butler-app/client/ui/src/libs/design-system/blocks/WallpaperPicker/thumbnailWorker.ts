import { wallpaperDefaultImageAsset } from "../Wallpaper/imageCache";
import type { WallpaperScene } from "../Wallpaper/registry";
import { drawWallpaperStill } from "../Wallpaper/stillGpu";

type Request = { id: number; scene: WallpaperScene; image?: Blob };
let queue = Promise.resolve();

/** The shared offscreen context must finish each encode before another request changes its buffer. */
async function render({ id, scene, image }: Request) {
  try {
    if (scene.image && image) {
      scene.image.asset = wallpaperDefaultImageAsset(scene.module.manifest.id, {
        key: scene.image.asset, load: () => Promise.resolve(image),
      });
    }
    const blob = await drawWallpaperStill(scene, { width: 320, height: 200 });
    self.postMessage({ id, blob });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : "Thumbnail failed" });
  }
}

self.onmessage = ({ data }: MessageEvent<Request>) => {
  queue = queue.then(() => render(data));
};
