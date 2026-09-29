import { useRef } from "react";
import { FolderPlus } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./WallpaperPicker.module.css";

/** Zip archives the import tile's file chooser offers; the gateway validates the bytes regardless. */
export const WALLPAPER_MODULE_IMPORT_ACCEPT = ".zip,application/zip";

interface WallpaperPickerModuleImportProps {
  label: string;
  importing: boolean;
  onImportModule: (file: File) => void;
}

/** The import-module tile: opens the file chooser for a module `.zip`; same visual language as the upload tile. */
export function WallpaperPickerModuleImport({ label, importing, onImportModule }: WallpaperPickerModuleImportProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className={styles.tile} data-option="import-module">
      <button
        aria-busy={importing || undefined}
        className={styles.option}
        disabled={importing}
        type="button"
        onClick={() => inputRef.current?.click()}
      >
        <span className={cn(styles.thumbnail, styles.uploadField)}>
          {importing ? <Spinner label={label} size={16} /> : <FolderPlus size="md" />}
        </span>
        <Typo.Caption tone="secondary" truncate>{label}</Typo.Caption>
      </button>
      <input
        accept={WALLPAPER_MODULE_IMPORT_ACCEPT}
        hidden
        ref={inputRef}
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onImportModule(file);
        }}
      />
    </div>
  );
}
