import { useCallback, useState, type ReactNode } from "react";
import { Card } from "../../components/Card";
import { Clickable } from "../../components/Clickable";
import { Tag } from "../../components/Tag";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import styles from "./LibraryCard.module.css";

/** What the card previews: a picture (element crop, page view), a quote (a text scrap) or a document. */
export type LibraryCardMedia =
  | { kind: "image"; src: string; alt?: string }
  | { kind: "quote"; text: string }
  | { kind: "document" };

export interface LibraryCardProps extends DsPrivateStyleProps {
  media: LibraryCardMedia;
  title: string;
  /** Source and date ("shop.example.com · Today"). */
  meta?: string;
  /** The kind, a word ("Element", "View"), on the media's corner. */
  tag?: string;
  /** An OverflowActionMenu (attach, open source, delete). */
  menu?: ReactNode;
  selected?: boolean;
  /** Opens the item; the media and title are the target (the menu stays its own button). */
  onOpen?: () => void;
}

/**
 * Width/height band that spans the 16:10 slot (contained, letterboxed on the matte): typical crops (a
 * product card, a square, a page view). Outside it (a heading strip, a tall column) a spanning picture is a
 * full-width band of page colour flush with the slot's edges, which reads as a spill, so it sits inset.
 */
const FILL_MIN_RATIO = 0.75;
const FILL_MAX_RATIO = 2.4;

/** `fill` (spans the slot) for typical shapes; `matte` (whole, inset on the matte) for extreme ones. */
export function libraryImageFit(width: number, height: number): "fill" | "matte" {
  if (!(width > 0 && height > 0)) return "matte";
  const ratio = width / height;
  return ratio >= FILL_MIN_RATIO && ratio <= FILL_MAX_RATIO ? "fill" : "matte";
}

/**
 * Every picture is whole (contain). A typical one spans the slot; an extreme one (a wide strip, a tall
 * column) sits inset on a neutral matte with a hairline frame. Hidden until its shape is known, so it
 * never shows the wrong fit for a frame.
 */
function ImageMedia({ src, alt }: { src: string; alt?: string }) {
  const [fit, setFit] = useState<{ src: string; fit: "fill" | "matte" } | null>(null);
  const measure = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth) setFit({ src, fit: libraryImageFit(image.naturalWidth, image.naturalHeight) });
  }, [src]);
  return (
    <span className={styles.frame} data-fit={fit?.src === src ? fit.fit : "pending"}>
      <img ref={measure} className={styles.image} src={src} alt={alt ?? ""} draggable={false} onLoad={(event) => measure(event.currentTarget)} />
    </span>
  );
}

function Media({ media }: { media: LibraryCardMedia }) {
  if (media.kind === "image") return <ImageMedia src={media.src} alt={media.alt} />;
  if (media.kind === "quote") return <span className={styles.quote}>{media.text}</span>;
  return (
    <span className={styles.document} aria-hidden="true">
      <span /><span /><span /><span />
    </span>
  );
}

/**
 * One library item (서랍: scraps, picks, saved views) on a Card with a media slot: a 16:10 preview, a kind
 * tag, the title with its source, and a ⋯ menu. Lay several out in a 3- or 4-column Grid.
 */
export function LibraryCard({ media, title, meta, tag, menu, selected = false, onOpen, className }: LibraryCardProps) {
  const body = (
    <span className={styles.body}>
      <span className={styles.media} data-kind={media.kind} data-tagged={tag ? "true" : undefined}>
        <Media media={media} />
        {tag ? <span className={styles.tag}><Tag size="sm">{tag}</Tag></span> : null}
      </span>
      <span className={styles.title}>{title}</span>
      {meta ? <span className={styles.meta}>{meta}</span> : null}
    </span>
  );
  return (
    <Card className={className} padding="sm" interactive={Boolean(onOpen)} selected={selected} data-library-card="">
      <div className={styles.layout}>
        {onOpen ? <Clickable className={dsClass(styles.open)} variant="text" aria-label={title} onClick={onOpen}>{body}</Clickable> : body}
        {menu ? <span className={styles.menu}>{menu}</span> : null}
      </div>
    </Card>
  );
}
