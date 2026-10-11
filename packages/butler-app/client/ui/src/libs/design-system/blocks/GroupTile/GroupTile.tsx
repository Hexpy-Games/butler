import type { ReactNode } from "react";
import { Card } from "../../components/Card";
import { Clickable } from "../../components/Clickable";
import { Folder } from "../../components/Icons";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import styles from "./GroupTile.module.css";

/** One cell of the mosaic: a crop, a text scrap's words, a document, or a site (favicon and host) for a bookmark. */
export type GroupTilePreview =
  | { kind: "image"; src: string }
  | { kind: "quote"; text: string }
  | { kind: "document" }
  | { kind: "site"; host: string; icon?: string };

export interface GroupTileProps extends DsPrivateStyleProps {
  name: string;
  /** Count and latest date ("5 scraps · Oct 10"). */
  meta?: string;
  /** The group's most recent items, newest first; the first four are shown (1 · 2 · 3 · 2×2). None: `emptyLabel`. */
  previews: readonly GroupTilePreview[];
  emptyLabel: string;
  /** Accessible name of the tile ("Travel group, 5 scraps"); defaults to the name. */
  label?: string;
  /** An OverflowActionMenu (open, rename, ungroup). */
  menu?: ReactNode;
  onOpen?: () => void;
  /** A drag is over the tile: accent ring and `dropHint` ("Add to “Travel”"). */
  drop?: boolean;
  dropHint?: ReactNode;
  /** Stable id for the App's drag targeting (`data-group-tile`). */
  dropId?: string;
}

function Cell({ preview }: { preview: GroupTilePreview }) {
  if (preview.kind === "image") return <span className={styles.cell}><img className={styles.image} src={preview.src} alt="" draggable={false} /></span>;
  if (preview.kind === "quote") return <span className={styles.cell}><span className={styles.quote}>{preview.text}</span></span>;
  if (preview.kind === "site") {
    return (
      <span className={styles.cell}>
        <span className={styles.site}>
          {preview.icon ? <img className={styles.favicon} src={preview.icon} alt="" draggable={false} />
            : <span className={styles.favicon} data-letter="">{preview.host.slice(0, 1).toUpperCase()}</span>}
          <span className={styles.host}>{preview.host}</span>
        </span>
      </span>
    );
  }
  return <span className={styles.cell}><span className={styles.document}><span /><span /><span /></span></span>;
}

/** The mosaic of a group's newest items, or the empty folder. */
function Mosaic({ previews, emptyLabel }: { previews: readonly GroupTilePreview[]; emptyLabel: string }) {
  const shown = previews.slice(0, 4);
  if (!shown.length) {
    return <span className={styles.empty}><Folder size="xl" /><span>{emptyLabel}</span></span>;
  }
  return (
    <span className={styles.mosaic} data-count={shown.length} aria-hidden="true">
      {shown.map((preview, index) => <Cell key={index} preview={preview} />)}
    </span>
  );
}

/**
 * A group (a scrap group, a bookmark folder) as a folder card on the Library's grid: a mosaic of its newest
 * items in the 16:10 slot a LibraryCard uses, the name with a folder glyph, count and date, and a ⋯ menu.
 * Cards and picks dropped on it go into the group.
 */
export function GroupTile({ name, meta, previews, emptyLabel, label, menu, onOpen, drop = false, dropHint, dropId, className }: GroupTileProps) {
  const body = (
    <span className={styles.body}>
      <span className={styles.media}>
        <Mosaic previews={previews} emptyLabel={emptyLabel} />
        {drop && dropHint ? <span className={styles.hint}>{dropHint}</span> : null}
      </span>
      <span className={styles.name}><Folder size="sm" /><span className={styles.nameText}>{name}</span></span>
      {meta ? <span className={styles.meta}>{meta}</span> : null}
    </span>
  );
  return (
    <Card className={className} padding="sm" interactive={Boolean(onOpen)} selected={drop} data-group-tile={dropId ?? ""}>
      <div className={styles.layout} data-drop={drop ? "true" : undefined}>
        {onOpen ? <Clickable className={dsClass(styles.open)} variant="text" aria-label={label ?? name} onClick={onOpen}>{body}</Clickable> : body}
        {menu ? <span className={styles.menu}>{menu}</span> : null}
      </div>
    </Card>
  );
}

export interface GroupTileMoreProps extends DsPrivateStyleProps {
  /** How many groups the row leaves out. */
  count: number;
  /** "2 more groups". */
  label: string;
  /** "View all". */
  meta?: string;
  onOpen?: () => void;
}

/** The last tile of a full row: how many groups are left out, opening the kind's full view. */
export function GroupTileMore({ count, label, meta, onOpen, className }: GroupTileMoreProps) {
  const body = (
    <span className={styles.body}>
      <span className={styles.media}><span className={styles.empty}><Folder size="lg" /><span className={styles.more}>{`+${count}`}</span></span></span>
      <span className={styles.name}><span className={styles.nameText}>{label}</span></span>
      {meta ? <span className={styles.meta}>{meta}</span> : null}
    </span>
  );
  return (
    <Card className={className} padding="sm" interactive={Boolean(onOpen)} data-group-tile-more="">
      <div className={styles.layout}>
        {onOpen ? <Clickable className={dsClass(styles.open)} variant="text" aria-label={label} onClick={onOpen}>{body}</Clickable> : body}
      </div>
    </Card>
  );
}
