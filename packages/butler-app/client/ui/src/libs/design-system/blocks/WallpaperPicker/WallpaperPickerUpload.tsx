import { useRef } from "react";
import { Plus } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./WallpaperPicker.module.css";

interface WallpaperPickerUploadProps {
  label: string;
  accept: string;
  uploading: boolean;
  /** Files are dragged over the picker. */
  dropping: boolean;
  onUpload: (file: File) => void;
}

/** The add-image tile: opens the file chooser; the picker around it takes dropped files. */
export function WallpaperPickerUpload({ label, accept, uploading, dropping, onUpload }: WallpaperPickerUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className={styles.tile} data-option="upload">
      <button
        aria-busy={uploading || undefined}
        className={styles.option}
        data-drop-active={dropping ? "true" : undefined}
        disabled={uploading}
        type="button"
        onClick={() => inputRef.current?.click()}
      >
        <span className={cn(styles.thumbnail, styles.uploadField)}>
          {uploading ? <Spinner label={label} size={16} /> : <Plus size="md" />}
        </span>
        <Typo.Caption tone="secondary" truncate>{label}</Typo.Caption>
      </button>
      <input
        accept={accept}
        hidden
        ref={inputRef}
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onUpload(file);
        }}
      />
    </div>
  );
}
