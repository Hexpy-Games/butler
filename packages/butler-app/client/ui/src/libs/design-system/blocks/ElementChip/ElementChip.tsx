import { IconButton } from "../../components/IconButton";
import { X } from "../../components/Icons";
import { Tooltip } from "../../components/Tooltip";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { dsClass } from "../../lib/internal";
import { cn } from "../../lib/utils";
import styles from "./ElementChip.module.css";

export interface ElementChipProps extends DsPrivateStyleProps {
  /** The picked element's crop. */
  src: string;
  /** A short title for the element (product name, heading). */
  title: string;
  /** Where it came from (host). */
  site: string;
  /** Composer: removes the chip. Omit in sent messages (read-only). */
  onRemove?: () => void;
  /** "Remove" (the chip's title is appended for screen readers). */
  removeLabel?: string;
}

/**
 * A picked page element as an attachment: crop, title and site, plus remove in the composer. Rendered by
 * AttachmentList for items with `element`, read-only inside sent messages.
 */
export function ElementChip({ src, title, site, onRemove, removeLabel = "Remove", className }: ElementChipProps) {
  return (
    <span className={cn(styles.chip, className)} data-slot="element-chip" data-removable={onRemove ? "true" : undefined}>
      <img className={styles.crop} src={src} alt="" draggable={false} />
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
