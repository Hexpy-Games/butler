import { useState, type MouseEvent, type ReactNode, type Ref } from "react";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { ArrowLeft, ArrowRight, ImageIcon, XIcon } from "../../components/Icons";
import { TintedGlass } from "../../components/TintedGlass";
import { Typo } from "../../components/Typo";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";
import { SiteIcon } from "../../lib/SiteIcon";
import styles from "./ImageViewer.module.css";

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

function Picture({ image, failedLabel }: { image: ImageViewerImage; failedLabel: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === image.src) {
    return (
      <TintedGlass className={dsClass(styles.failed)} radius="control" padding="md" role="img" aria-label={`${image.alt} · ${failedLabel}`}>
        <ImageIcon size="xl" />
        <Typo.Caption tone="secondary">{failedLabel}</Typo.Caption>
      </TintedGlass>
    );
  }
  if (image.kind === "video") {
    return (
      <video key={image.src} className={cn(styles.picture, styles.video)} src={image.src} aria-label={image.alt}
        controls playsInline preload="metadata" onError={() => setFailed(image.src)} />
    );
  }
  return <img key={image.src} className={styles.picture} src={image.src} alt={image.alt} draggable={false} onError={() => setFailed(image.src)} />;
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
  return (
    <div className={styles.surface} data-contained={contained ? "" : undefined} data-image-viewer-backdrop="" onClick={backdropClick(onClose)}>
      <div className={styles.bar} data-image-viewer-backdrop="">
        {many ? (
          <TintedGlass className={dsClass(styles.capsule)} radius="control" padding="none">
            <Typo.Caption numeric="tabular" aria-hidden="true">{labels.position(index + 1, total)}</Typo.Caption>
          </TintedGlass>
        ) : <span />}
        <TintedGlass className={dsClass(styles.capsule)} radius="control" padding="none">
          <ButtonContainer size="icon-sm">
            {actions}
            <IconButton ref={closeRef} label={labels.close} onClick={onClose}><XIcon size="sm" /></IconButton>
          </ButtonContainer>
        </TintedGlass>
      </div>
      <div className={styles.stage} data-image-viewer-backdrop="">
        <Picture image={image} failedLabel={labels.failed} />
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
