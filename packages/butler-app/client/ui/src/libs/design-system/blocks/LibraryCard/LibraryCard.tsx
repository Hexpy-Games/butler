import type { ReactNode } from "react";
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

function Media({ media }: { media: LibraryCardMedia }) {
  if (media.kind === "image") return <img className={styles.image} src={media.src} alt={media.alt ?? ""} draggable={false} />;
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
      <span className={styles.media} data-kind={media.kind}>
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
