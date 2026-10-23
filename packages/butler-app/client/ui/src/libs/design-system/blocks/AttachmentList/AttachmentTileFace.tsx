import { useCallback, useState } from "react";
import { FileText, Play, X } from "../../components/Icons";
import { TintedGlass } from "../../components/TintedGlass";
import { Typo } from "../../components/Typo";
import { dsClass } from "../../lib/internal";
import type { AttachmentListItem } from "./AttachmentList";
import styles from "./AttachmentTiles.module.css";

/** A video's length as m:ss, from the metadata the first frame already loads; none while unknown. */
function videoLength(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A cover picture that fades in once decoded; a cached one shows at once. Lazy and async decoded. */
function Picture({ src, onFailed }: { src: string; onFailed: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const known = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth) setLoaded(true);
  }, []);
  return (
    <img ref={known} className={styles.picture} data-loaded={loaded ? "true" : undefined} src={src} alt=""
      loading="lazy" decoding="async" draggable={false} onLoad={() => setLoaded(true)} onError={onFailed} />
  );
}

/** The first frame only: metadata preload, muted, never plays here. */
function VideoFrame({ src, onFailed }: { src: string; onFailed: () => void }) {
  const [length, setLength] = useState<string>();
  return (
    <>
      <video className={styles.picture} data-loaded={length !== undefined ? "true" : undefined} src={src} preload="metadata"
        muted playsInline aria-hidden="true" tabIndex={-1} onError={onFailed}
        onLoadedMetadata={(event) => setLength(videoLength(event.currentTarget.duration) ?? "")} />
      <TintedGlass className={dsClass(styles.badge)} radius="control" padding="none">
        <Play size="xs" />
        {length ? <Typo.Caption numeric="tabular">{length}</Typo.Caption> : null}
      </TintedGlass>
    </>
  );
}

function FileFace({ item, withMeta }: { item: AttachmentListItem; withMeta: boolean }) {
  return (
    <span className={styles.file}>
      <span className={styles.fileHead}>
        {item.icon ?? <FileText size="sm" />}
        {item.extension ? (
          <Typo.Caption className={dsClass(styles.fileType)} weight="semibold" tone="secondary" truncate>{item.extension}</Typo.Caption>
        ) : null}
      </span>
      <Typo.Caption className={dsClass(styles.fileName)} lineClamp={2} wrap="anywhere">{item.name}</Typo.Caption>
      {withMeta && item.meta ? (
        <Typo.Caption className={dsClass(styles.fileMeta)} tone="tertiary" numeric="tabular" truncate>{item.meta}</Typo.Caption>
      ) : null}
    </span>
  );
}

/** A tile's face: the cover picture, a video's first frame, or the file type; a broken picture shows the file face. */
export function AttachmentTileFace({ item, withMeta }: { item: AttachmentListItem; withMeta: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const video = item.video?.src;
  const picture = video ? undefined : item.thumbnail?.src;
  const source = video ?? picture;
  if (source && failed !== source) {
    const fail = () => setFailed(source);
    return video ? <VideoFrame key={video} src={video} onFailed={fail} /> : <Picture key={picture} src={picture!} onFailed={fail} />;
  }
  return <FileFace item={item} withMeta={withMeta} />;
}

/** A small glass ✕ on the tile's corner with a hit area past the dot: on hover or focus, always on touch. */
export function AttachmentTileRemove({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <TintedGlass className={dsClass(styles.remove)} radius="control" padding="none">
      <button type="button" className={styles.removeButton} aria-label={label} onClick={onRemove}>
        <X size="xs" />
      </button>
    </TintedGlass>
  );
}
