import type { KeyboardEvent, ReactNode } from "react";
import { IconButton } from "../../components/IconButton";
import { X } from "../../components/Icons";
import { Tooltip } from "../../components/Tooltip";
import { Typo } from "../../components/Typo";
import { dsClass } from "../../lib/internal";
import { useWallpaperThumbnail, type WallpaperThumbnailRequest } from "./useWallpaperThumbnail";
import styles from "./WallpaperPicker.module.css";

interface WallpaperPickerTileProps {
  label: string;
  selected: boolean;
  /** The one tile in the tab order (roving tabindex). */
  focusable: boolean;
  preview: WallpaperThumbnailRequest | null;
  /** Shown instead of a preview (e.g. the upload plus). */
  placeholder?: ReactNode;
  optionRef: (node: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** Adds a delete button over the thumbnail. */
  onDelete?: () => void;
  deleteLabel?: string;
  /** A subtle marker after the caption, e.g. `Mine` on the user's own modules. */
  mine?: string;
  /** The tile cannot be chosen: it stays focusable and names why in a tooltip. */
  disabledReason?: string;
  dataKey: string;
}

/** One option of the picker: a still thumbnail (16:10) with a caption, as a radio (aria-disabled with a tooltip when it cannot be chosen). */
export function WallpaperPickerTile({
  label, selected, focusable, preview, placeholder, optionRef, onSelect, onKeyDown, onDelete, deleteLabel, mine, disabledReason, dataKey,
}: WallpaperPickerTileProps) {
  const url = useWallpaperThumbnail(preview);
  const disabled = disabledReason !== undefined;
  const option = (
    <button
      aria-checked={selected}
      aria-disabled={disabled ? "true" : undefined}
      className={styles.option}
      data-state={selected ? "on" : "off"}
      ref={optionRef}
      role="radio"
      tabIndex={focusable ? 0 : -1}
      type="button"
      onClick={() => {
        if (!selected && !disabled) onSelect();
      }}
      onKeyDown={onKeyDown}
    >
      <span className={styles.thumbnail}>
        {url ? <img alt="" className={styles.image} decoding="async" draggable={false} height={200} src={url} width={320} /> : placeholder}
      </span>
      <span className={styles.caption}>
        <Typo.Caption tone={disabled ? "disabled" : selected ? "primary" : "secondary"} truncate>{label}</Typo.Caption>
        {mine ? <Typo.Caption className={dsClass(styles.mine)} data-slot="wallpaper-picker-mine" tone="tertiary">{mine}</Typo.Caption> : null}
      </span>
    </button>
  );
  return (
    <div className={styles.tile} data-option={dataKey}>
      {disabled ? <Tooltip label={disabledReason} wrap>{option}</Tooltip> : option}
      {onDelete && deleteLabel ? (
        <span className={styles.delete}>
          <IconButton label={deleteLabel} onClick={onDelete}>
            <X size="sm" />
          </IconButton>
        </span>
      ) : null}
    </div>
  );
}
