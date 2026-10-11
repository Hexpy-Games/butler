import { useCallback, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { Card } from "../../components/Card";
import { Clickable } from "../../components/Clickable";
import { CheckIcon } from "../../components/Icons";
import { Tag } from "../../components/Tag";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { LibraryTitleInput, type LibraryCardEditing } from "./LibraryTitleInput";
import styles from "./LibraryCard.module.css";

export type { LibraryCardEditing } from "./LibraryTitleInput";

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
  /** The item's tags, one line under the meta: the first `maxTags`, then "+N". None: no line. */
  tags?: readonly string[];
  maxTags?: number;
  /** An OverflowActionMenu (attach, open source, delete). */
  menu?: ReactNode;
  selected?: boolean;
  /**
   * With `selectLabel`, a selection checkbox on the media's corner (on hover, always in `selectionMode`).
   * In `selectionMode` a click on the card toggles selection instead of opening.
   */
  onSelectedChange?: (selected: boolean, event: MouseEvent) => void;
  selectLabel?: string;
  selectionMode?: boolean;
  /** Renders the title as a name field (rename in place). */
  editing?: LibraryCardEditing;
  /** Lifted out for a drag: dimmed in place. */
  dragging?: boolean;
  /** Starts the App's own drag (cards onto a group tile, a chip or a conversation). */
  onDragPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  /** Opens the item; the media and title are the target (the menu stays its own button). */
  onOpen?: (event: MouseEvent) => void;
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

function TagRow({ tags, max }: { tags: readonly string[]; max: number }) {
  if (!tags.length) return null;
  const rest = tags.length - max;
  return (
    <span className={styles.tags} data-slot="library-card-tags">
      {tags.slice(0, max).map((tag) => <Tag key={tag} size="sm">{tag}</Tag>)}
      {rest > 0 ? <Tag size="sm">{`+${rest}`}</Tag> : null}
    </span>
  );
}

/**
 * One library item (서랍: scraps, picks, saved views) on a Card with a media slot: a 16:10 preview, a kind
 * tag, the title with its source, its tags and a ⋯ menu. Lay several out in a Grid (2 · 3 · 4 columns).
 */
export function LibraryCard({
  media, title, meta, tag, tags = [], maxTags = 2, menu, selected = false, onSelectedChange, selectLabel,
  selectionMode = false, editing, dragging = false, onDragPointerDown, onOpen, className,
}: LibraryCardProps) {
  const selectable = Boolean(onSelectedChange && selectLabel);
  const open = (event: MouseEvent) => {
    if (selectionMode && onSelectedChange) onSelectedChange(!selected, event);
    else onOpen?.(event);
  };
  const body = (
    <span className={styles.body}>
      <span className={styles.media} data-kind={media.kind} data-tagged={tag ? "true" : undefined}>
        <Media media={media} />
        {tag ? <span className={styles.tag}><Tag size="sm">{tag}</Tag></span> : null}
      </span>
      {editing ? <LibraryTitleInput editing={editing} /> : <span className={styles.title}>{title}</span>}
      {meta ? <span className={styles.meta}>{meta}</span> : null}
      <TagRow tags={tags} max={maxTags} />
    </span>
  );
  return (
    <Card className={className} padding="sm" interactive={Boolean(onOpen) && !editing} selected={selected}
      data-library-card="" onPointerDown={onDragPointerDown}>
      <div className={styles.layout} data-selection={selectionMode ? "active" : undefined} data-dragging={dragging ? "true" : undefined}>
        {onOpen && !editing ? <Clickable className={dsClass(styles.open)} variant="text" aria-label={title} onClick={open}>{body}</Clickable> : body}
        {selectable ? (
          <button type="button" role="checkbox" aria-checked={selected} aria-label={selectLabel} className={styles.check}
            data-checked={selected ? "true" : undefined} onClick={(event) => onSelectedChange?.(!selected, event)}>
            {selected ? <CheckIcon size="xs" /> : null}
          </button>
        ) : null}
        {menu ? <span className={styles.menu}>{menu}</span> : null}
      </div>
    </Card>
  );
}
