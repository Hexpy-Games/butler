import type { Ref } from "react";
import { CircleAlert } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import type { AttachmentListItem } from "./AttachmentList";
import type { TriggerProps } from "./AttachmentTiles";
import styles from "./AttachmentList.module.css";

/** An upload's mark: the DS Spinner while it runs, the alert icon (danger tone from the slot) once it failed. */
export function AttachmentStatusIcon({ status, size }: { status: NonNullable<AttachmentListItem["upload"]>; size: "xs" | "sm" }) {
  return status === "uploading" ? <Spinner size={size === "xs" ? 12 : 14} /> : <CircleAlert size={size} />;
}

/**
 * The accessible name when the name alone does not say it all: a blocked item adds its reason; an upload
 * in progress or failed adds its `meta` (the container's "Uploading 40%", "Over 10 MB").
 */
export function attachmentLabel(item: AttachmentListItem): string | undefined {
  const extra = item.blockedReason ?? (item.upload ? item.meta : undefined);
  return extra ? `${item.name}, ${extra}` : undefined;
}

/** The name: a button with `onOpen`, else a link with `href`, else text. Tooltip's trigger props pass through. */
export function ItemName({ item, onOpen, ref, ...trigger }: { item: AttachmentListItem; onOpen?: (item: AttachmentListItem) => void } & TriggerProps) {
  const shared = { ...trigger, "aria-label": attachmentLabel(item), className: styles.name, "data-slot": "attachment-name" };
  if (onOpen) return <button {...shared} ref={ref as Ref<HTMLButtonElement>} type="button" onClick={() => onOpen(item)}>{item.name}</button>;
  if (item.href) return <a {...shared} ref={ref as Ref<HTMLAnchorElement>} href={item.href} target="_blank" rel="noreferrer">{item.name}</a>;
  return <span {...shared} ref={ref as Ref<HTMLSpanElement>}>{item.name}</span>;
}
