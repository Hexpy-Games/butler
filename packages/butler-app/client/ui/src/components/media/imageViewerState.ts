import { create } from "zustand";

/** One picture the app can show large. `source` is the page it was read from. */
export interface ViewerImage {
  asset?: import("../images/imageApi").ImageAsset;
  src: string;
  alt: string;
  /** `video` plays in the viewer (an attached video file). */
  kind?: "image" | "video";
  caption?: string;
  /** The page the picture shows or came from; opens in the conversation's browser. */
  source?: string;
  /** When the source was read (ISO time). */
  checked?: string;
  /** The conversation the picture belongs to; its browser opens the source. */
  sessionId?: string;
  /** Opens the source another way (a live browser tab for an activity screenshot). */
  openSource?: () => Promise<void> | void;
}

interface ImageViewerState {
  images: ViewerImage[];
  index: number | null;
}

/** The one viewer of the window: the set it pages through and the shown index. */
export const useImageViewerState = create<ImageViewerState>(() => ({ images: [], index: null }));

/** Opens the viewer on `images` (one message's or one block's pictures) at `index`. */
export function openImageViewer(images: ViewerImage[], index: number) {
  const usable = images.filter((image) => Boolean(image.src));
  const target = images[index];
  const at = target ? usable.indexOf(target) : -1;
  if (at < 0) return;
  useImageViewerState.setState({ images: usable, index: at });
}

export function closeImageViewer() {
  useImageViewerState.setState({ index: null });
}
