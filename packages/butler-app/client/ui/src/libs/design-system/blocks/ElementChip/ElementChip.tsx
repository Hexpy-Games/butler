import { useState } from "react";
import { IconButton } from "../../components/IconButton";
import { Pick, X } from "../../components/Icons";
import { Tooltip } from "../../components/Tooltip";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";
import styles from "./ElementChip.module.css";

export interface ElementChipProps extends DsPrivateStyleProps {
  /** The picked element's crop. Empty or failing to load: a pick glyph on the matte. */
  src?: string;
  /** A short title for the element (product name, heading). */
  title: string;
  /** Where it came from (host). */
  site: string;
  /** Composer: removes the chip. Omit in sent messages (read-only). */
  onRemove?: () => void;
  /** "Remove" (the chip's title is appended for screen readers). */
  removeLabel?: string;
}

/** The crop, whole on a neutral matte (contain): a wide heading is a strip, never its blank middle. */
function Crop({ src }: { src?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const shown = src && failed !== src;
  return (
    <span className={styles.crop} data-slot="element-chip-crop" data-empty={shown ? undefined : "true"}>
      {shown ? <img className={styles.cropImage} src={src} alt="" draggable={false} onError={() => setFailed(src)} /> : <Pick size="sm" />}
    </span>
  );
}

/**
 * A picked page element as an attachment: crop, title and site, plus remove in the composer. Rendered by
 * AttachmentList for items with `element`, read-only inside sent messages.
 */
export function ElementChip({ src, title, site, onRemove, removeLabel = "Remove", className }: ElementChipProps) {
  return (
    <span className={cn(styles.chip, className)} data-slot="element-chip" data-removable={onRemove ? "true" : undefined}>
      <Crop src={src} />
      <Tooltip label={`${title} · ${site}`}>
        <span className={styles.text}>
          <span className={styles.title}>{title}</span>
          <span className={styles.site}>{site}</span>
        </span>
      </Tooltip>
      {onRemove ? (
        <IconButton className={dsClass(styles.remove)} label={`${removeLabel}: ${title}`} onClick={onRemove}><X size="sm" /></IconButton>
      ) : null}
    </span>
  );
}
