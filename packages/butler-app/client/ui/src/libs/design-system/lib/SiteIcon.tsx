import { useState, type ReactNode } from "react";
import { IconSlot } from "../components/IconSlot";
import { Globe2 } from "../components/Icons";
import { dsClass } from "./internal";
import styles from "./siteIcon.module.css";

/**
 * A site favicon in a 16px IconSlot (it centers on the first text line of a row). A missing or
 * broken image shows the fallback glyph (a globe unless the row passes its kind glyph).
 */
export function SiteIcon({ src, fallback }: { src?: string; fallback?: ReactNode }) {
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const image = src && brokenSrc !== src;
  return (
    <IconSlot className={dsClass(styles.slot)} size="md" tone={image ? undefined : "tertiary"} aria-hidden="true" data-site-icon={image ? "image" : "glyph"}>
      {image ? <img src={src} alt="" width={16} height={16} draggable={false} onError={() => setBrokenSrc(src)} /> : fallback ?? <Globe2 size="md" />}
    </IconSlot>
  );
}
