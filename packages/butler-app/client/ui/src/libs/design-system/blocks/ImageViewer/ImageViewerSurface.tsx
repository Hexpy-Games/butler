import type { MouseEvent, ReactNode, Ref } from "react";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { ArrowLeft, ArrowRight, XIcon, ZoomIn, ZoomOut } from "../../components/Icons";
import { TintedGlass } from "../../components/TintedGlass";
import { Typo } from "../../components/Typo";
import { dsClass } from "../../lib/internal";
import { SiteIcon } from "../../lib/SiteIcon";
import styles from "./ImageViewer.module.css";
import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEP, useZoomPan } from "./zoom";
import { Picture, zoomKeys } from "./ImageViewerPicture";

/** Where a picture was read: the provenance line under the caption ("shop.example · 오후 5:41 확인"). */
export interface ImageViewerSource {
  /** Domain or site name. */
  site: string;
  /** Formatted read time ("Checked 5:41 PM" / "오후 5:41 확인"). */
  checked?: string;
  /** Favicon URL; a globe without it. */
  icon?: string;
}

/** One picture of the set. `alt` names it for assistive tech; `caption` is the visible line. */
export interface ImageViewerImage {
  src: string;
  alt: string;
  /** `video` plays on the stage with native controls; it never autoplays and preloads metadata only. */
  kind?: "image" | "video";
  caption?: string;
  source?: ImageViewerSource;
}

/** Localized chrome copy; the container passes app copy. */
export interface ImageViewerLabels {
  close: string;
  previous: string;
  next: string;
  /** "2 / 5" style position, also announced. */
  position: (current: number, total: number) => string;
  /** Shown when the picture cannot load. */
  failed: string;
  /** Zoom buttons for pictures; without them zoom stays on gestures and the +, - and 0 keys. */
  zoomIn?: string;
  zoomOut?: string;
}

export interface ImageViewerSurfaceProps {
  image: ImageViewerImage;
  index: number;
  total: number;
  labels: ImageViewerLabels;
  /** IconButtons for the shown picture (open its page, save, copy), set beside Close. */
  actions?: ReactNode;
  onPrevious?: () => void;
  onNext?: () => void;
  onClose: () => void;
  closeRef?: Ref<HTMLButtonElement>;
  /** `contained`: the surface paints its own scrim inside a positioned parent (previews). */
  contained?: boolean;
}

/** A click on the scrim itself (not a picture, a capsule or a button) closes. */
function backdropClick(onClose: () => void) {
  return (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).dataset.imageViewerBackdrop !== undefined) onClose();
  };
}

/**
 * The viewer's layout without the overlay: a bar (position, actions, close), the picture fitted to the
 * stage with previous/next on its sides, and the caption with its source line. `ImageViewer` renders it
 * in a modal dialog; previews render it `contained`.
 */
export function ImageViewerSurface({
  image, index, total, labels, actions, onPrevious, onNext, onClose, closeRef, contained = false,
}: ImageViewerSurfaceProps) {
  const many = total > 1;
  const zoomable = image.kind !== "video";
  const zoom = useZoomPan(zoomable, image.src);
  return (
    <div className={styles.surface} data-contained={contained ? "" : undefined} data-image-viewer-backdrop="" onClick={backdropClick(onClose)}
      onKeyDown={zoomable ? zoomKeys(zoom) : undefined}>
      <div className={styles.bar} data-image-viewer-backdrop="">
        {many ? (
          <TintedGlass className={dsClass(styles.capsule)} radius="control" padding="none">
            <Typo.Caption numeric="tabular" aria-hidden="true">{labels.position(index + 1, total)}</Typo.Caption>
          </TintedGlass>
        ) : <span />}
        <TintedGlass className={dsClass(styles.capsule)} radius="control" padding="none">
          <ButtonContainer size="icon-sm">
            {zoomable && labels.zoomOut ? (
              <IconButton label={labels.zoomOut} disabled={zoom.view.scale <= MIN_ZOOM} onClick={() => zoom.zoomBy(1 / ZOOM_STEP)}><ZoomOut size="sm" /></IconButton>
            ) : null}
            {zoomable && labels.zoomIn ? (
              <IconButton label={labels.zoomIn} disabled={zoom.view.scale >= MAX_ZOOM} onClick={() => zoom.zoomBy(ZOOM_STEP)}><ZoomIn size="sm" /></IconButton>
            ) : null}
            {actions}
            <IconButton ref={closeRef} label={labels.close} onClick={onClose}><XIcon size="sm" /></IconButton>
          </ButtonContainer>
        </TintedGlass>
      </div>
      <div className={styles.stage} data-image-viewer-backdrop="">
        <Picture image={image} failedLabel={labels.failed} zoom={zoom} />
        {many ? (
          <>
            <TintedGlass className={dsClass(styles.nav)} data-side="start" radius="control" padding="none">
              <IconButton label={labels.previous} disabled={!onPrevious} onClick={onPrevious}><ArrowLeft size="sm" /></IconButton>
            </TintedGlass>
            <TintedGlass className={dsClass(styles.nav)} data-side="end" radius="control" padding="none">
              <IconButton label={labels.next} disabled={!onNext} onClick={onNext}><ArrowRight size="sm" /></IconButton>
            </TintedGlass>
          </>
        ) : null}
      </div>
      {image.caption || image.source ? (
        <TintedGlass className={dsClass(styles.caption)} radius="control" padding="sm">
          {image.caption ? <Typo.Text lineClamp={3}>{image.caption}</Typo.Text> : null}
          {image.source ? (
            <span className={styles.source}>
              <SiteIcon src={image.source.icon} />
              <Typo.Caption tone="tertiary" truncate>{[image.source.site, image.source.checked].filter(Boolean).join(" · ")}</Typo.Caption>
            </span>
          ) : null}
        </TintedGlass>
      ) : <span />}
    </div>
  );
}
