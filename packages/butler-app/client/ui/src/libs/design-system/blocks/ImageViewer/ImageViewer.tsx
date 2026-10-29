import { useRef, type KeyboardEvent, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ImageViewerSurface, type ImageViewerImage, type ImageViewerLabels } from "./ImageViewerSurface";
import styles from "./ImageViewer.module.css";

export * from "./ImageViewerSurface";

export interface ImageViewerProps {
  /** The pictures of one message or block, in reading order. */
  images: readonly ImageViewerImage[];
  /** The shown picture; `null` closes the viewer. */
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  labels: ImageViewerLabels;
  /** IconButtons for the shown picture, built by the container for `index`. */
  actions?: ReactNode;
}

/**
 * A modal image viewer (lightbox): the picture fitted to the window on a blurred surface-tone scrim, previous/next
 * through its set (buttons and the arrow keys), the caption and source line, the container's actions and
 * Close (also Esc and a click on the scrim). Focus is trapped and returns to the opener; reduced motion
 * keeps only the fade. Pictures open fitted and zoom up to 4x (double-click or tap, pinch, ctrl/cmd + wheel, the
 * +, - and 0 keys, and the zoom buttons when their labels are given); a drag pans while zoomed. A `video` item plays
 * with native controls and does not zoom.
 */
export function ImageViewer({ images, index, onIndexChange, onClose, labels, actions }: ImageViewerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Opened from any picture (no Radix trigger): focus returns to that picture.
  const openerRef = useRef<HTMLElement | null>(null);
  const current = index === null ? undefined : images[index];
  const previous = index !== null && index > 0 ? () => onIndexChange(index - 1) : undefined;
  const next = index !== null && index < images.length - 1 ? () => onIndexChange(index + 1) : undefined;
  const keys = (event: KeyboardEvent) => {
    // A focused video's controls own the arrow keys (seek).
    if (event.target instanceof HTMLMediaElement) return;
    const step = event.key === "ArrowLeft" ? previous : event.key === "ArrowRight" ? next : undefined;
    if (!step) return;
    event.preventDefault();
    step();
  };
  return (
    <DialogPrimitive.Root open={Boolean(current)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={styles.overlay} data-slot="image-viewer-overlay" />
        {current && index !== null ? (
          <DialogPrimitive.Content className={styles.content} data-slot="image-viewer" onKeyDown={keys}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              closeRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => { event.preventDefault(); openerRef.current?.focus(); }}>
            <DialogPrimitive.Title className="sr-only">{current.caption ?? current.alt}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only" aria-live="polite">
              {images.length > 1 ? labels.position(index + 1, images.length) : current.alt}
            </DialogPrimitive.Description>
            <ImageViewerSurface image={current} index={index} total={images.length} labels={labels} actions={actions}
              onPrevious={previous} onNext={next} onClose={onClose} closeRef={closeRef} />
          </DialogPrimitive.Content>
        ) : null}
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
