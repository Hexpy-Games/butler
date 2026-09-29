import { useEffect, useRef, useState } from "react";

/** A thumbnail to show: its content key and how to get its encoded bytes. */
export interface WallpaperThumbnailRequest {
  key: string;
  load: () => Promise<Blob>;
}

const dataUrls = new WeakMap<Blob, Promise<string>>();

/** A `data:` URL for a blob (the app CSP allows data: images, not blob: URLs), once per blob. */
function dataUrl(blob: Blob): Promise<string> {
  let url = dataUrls.get(blob);
  if (!url) {
    url = new Promise<string>((resolve, reject) => {
      const reader = new window.FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("Thumbnail read failed"));
      reader.readAsDataURL(blob);
    });
    dataUrls.set(blob, url);
  }
  return url;
}

/**
 * The image URL for a thumbnail request, reloaded when its key changes. The
 * previous thumbnail stays until the next one is ready (no flash while a
 * selected module's params change); a failed load shows none.
 */
export function useWallpaperThumbnail(request: WallpaperThumbnailRequest | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const loadRef = useRef(request?.load);
  const key = request?.key ?? null;

  useEffect(() => {
    loadRef.current = request?.load;
  });

  useEffect(() => {
    const load = loadRef.current;
    if (key === null || !load) {
      setUrl(null);
      return undefined;
    }
    let live = true;
    load().then(dataUrl).then((next) => {
      if (live) setUrl(next);
    }).catch(() => {
      if (live) setUrl(null);
    });
    return () => {
      live = false;
    };
  }, [key]);

  return url;
}
