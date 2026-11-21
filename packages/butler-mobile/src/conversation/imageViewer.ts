import { useSyncExternalStore } from "react";

export interface ViewerImage {
  source: { uri: string; headers: Record<string, string> };
  alt: string; width: number; height: number;
}

let state: { images: ViewerImage[]; index: number | null } = { images: [], index: null };
const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openImageViewer(images: ViewerImage[], index: number) {
  const usable = images.filter(image => Boolean(image.source.uri));
  const target = images[index];
  const at = target ? usable.indexOf(target) : -1;
  if (at < 0) return;
  state = { images: usable, index: at };
  for (const listener of listeners) listener();
}

export function closeImageViewer() {
  state = { ...state, index: null };
  for (const listener of listeners) listener();
}

export function useImageViewer(): { images: ViewerImage[]; index: number | null } {
  return useSyncExternalStore(subscribe, () => state);
}
