import { useCallback, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { Tooltip } from "../../components/Tooltip";
import { animateMotion } from "../../lib/motion";
import { useScrollEdges } from "../../lib/useScrollEdges";
import { windowDragClassName, type WindowDragProps } from "../../lib/windowDrag";
import { cn } from "../../lib/utils";
import type { AttachmentListItem } from "./AttachmentList";
import { AttachmentTileFace, AttachmentTileRemove } from "./AttachmentTileFace";
import { attachmentLabel } from "./attachmentStatus";
import styles from "./AttachmentTiles.module.css";

export interface AttachmentTilesProps extends WindowDragProps {
  items: AttachmentListItem[];
  layout: "row" | "wrap";
  align?: "start" | "end";
  onOpen?: (item: AttachmentListItem) => void;
  onMediaError?: (item: AttachmentListItem) => void;
  onRemove?: (id: string) => void;
  removeLabel: (name: string) => string;
  className?: string;
}

type Register = (id: string, node: HTMLDivElement | null) => void;

/** What Tooltip's trigger clone passes: its ref, description and focus/pointer handlers. */
export type TriggerProps = Omit<HTMLAttributes<HTMLElement>, "children" | "className" | "style"> & { ref?: Ref<HTMLElement> };

/** The face: a button with `onOpen`, else a link with `href`, else a picture. Tooltip's trigger props pass through. */
function TileTarget({ item, onOpen, children, ref, ...trigger }: { item: AttachmentListItem; onOpen?: AttachmentTilesProps["onOpen"]; children: ReactNode } & TriggerProps) {
  const label = attachmentLabel(item) ?? item.name;
  const shared = { ...trigger, className: styles.face, "aria-label": label };
  if (onOpen) {
    return <button {...shared} ref={ref as Ref<HTMLButtonElement>} type="button" onClick={() => onOpen(item)}>{children}</button>;
  }
  if (item.href) {
    return <a {...shared} ref={ref as Ref<HTMLAnchorElement>} href={item.href} target="_blank" rel="noreferrer">{children}</a>;
  }
  return <span {...shared} ref={ref as Ref<HTMLSpanElement>} role="img">{children}</span>;
}

function Tile({ item, layout, onOpen, onMediaError, onRemove, removeLabel, register }: Omit<AttachmentTilesProps, "items" | "windowDrag" | "align"> & {
  item: AttachmentListItem; register: Register;
}) {
  const node = useRef<HTMLDivElement | null>(null);
  const [leaving, setLeaving] = useState(false);
  // The exit runs on the CSS keyframes; the tile leaves the list once they finish (at once without any).
  useLayoutEffect(() => {
    const tile = node.current;
    if (!leaving || !tile) return;
    const done = () => onRemove?.(item.id);
    const running = tile.getAnimations().map((animation) => animation.finished);
    if (running.length === 0) done();
    else void Promise.all(running).then(done, done);
  }, [leaving, item.id, onRemove]);
  const ref = (element: HTMLDivElement | null) => { node.current = element; register(item.id, element); };
  return (
    <div ref={ref} className={styles.tile} data-slot="attachment-tile" data-kind={item.video ? "video" : item.thumbnail ? "image" : "file"}
      data-blocked={item.blockedReason ? "true" : undefined} data-upload={item.upload}
      aria-busy={item.upload === "uploading" ? true : undefined} data-leaving={leaving ? "true" : undefined}>
      <Tooltip label={item.blockedReason ?? item.name}>
        <TileTarget item={item} onOpen={onOpen}><AttachmentTileFace item={item} withMeta={layout === "wrap"} onMediaError={onMediaError} /></TileTarget>
      </Tooltip>
      {onRemove ? <AttachmentTileRemove label={removeLabel(item.name)} onRemove={() => setLeaving(true)} /> : null}
    </div>
  );
}

/** The remaining tiles slide into the gap a removed one leaves (FLIP on transform; none under reduced motion). */
function useSlideClosed(order: string): Register {
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const last = useRef(new Map<string, DOMRect>());
  const register = useCallback<Register>((id, element) => {
    if (element) nodes.current.set(id, element);
    else nodes.current.delete(id);
  }, []);
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    for (const [id, element] of nodes.current) {
      const rect = element.getBoundingClientRect();
      next.set(id, rect);
      const before = last.current.get(id);
      if (!before) continue;
      const dx = before.left - rect.left;
      const dy = before.top - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      animateMotion(element, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: "base", easing: "standard" });
    }
    last.current = next;
  }, [order]);
  return register;
}

/**
 * Square attachment tiles: `row` 64px in one sideways-scrolling row with the shared edge fade (composer),
 * `wrap` 96px wrapping (end-aligned in a sent message, `align="start"` in a document), with the size line. Every item shows.
 */
export function AttachmentTiles({ items, layout, align, onOpen, onMediaError, onRemove, removeLabel, windowDrag, className }: AttachmentTilesProps) {
  const edges = useScrollEdges("x", layout === "row");
  const register = useSlideClosed(items.map((item) => item.id).join("\n"));
  const tiles = items.map((item) => (
    <Tile key={item.id} item={item} layout={layout} onOpen={onOpen} onMediaError={onMediaError} onRemove={onRemove} removeLabel={removeLabel} register={register} />
  ));
  if (layout === "wrap") {
    return <div className={cn(styles.wrap, windowDragClassName(windowDrag), className)} data-slot="attachment-list" data-variant="tiles" data-layout="wrap" data-align={align}>{tiles}</div>;
  }
  return (
    <div ref={edges} className={cn(styles.row, windowDragClassName(windowDrag), className)} data-slot="attachment-list" data-variant="tiles" data-layout="row">
      <div className={styles.track}>{tiles}</div>
    </div>
  );
}
