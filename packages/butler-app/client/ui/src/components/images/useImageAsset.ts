import { useEffect, useState } from "react";
import { getImageMeta, type ImageAsset } from "./imageApi";

/** Fetch only on identity changes; a failed or expired load can ask for fresh signing. */
export function useImageAsset(id?: string) {
  const [asset, setAsset] = useState<ImageAsset>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setAsset(undefined);
    if (id) void getImageMeta(id, controller.signal).then(setAsset, () => {});
    return () => controller.abort();
  }, [id, revision]);
  return { asset: asset?.id === id ? asset : undefined, refresh: () => setRevision(n => n + 1) };
}
