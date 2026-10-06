import { useRef, useState, type ReactNode, type DragEvent, type KeyboardEvent } from "react";
import { AlertCircle } from "../../components/Icons";
import type { WallpaperLocale } from "../Wallpaper";
import { wallpaperPickerReason, type WallpaperPickerOption } from "./pickerModel";
import { wallpaperOptionCaption, wallpaperOptionDeleteId, wallpaperOptionPreview, wallpaperOptionTarget, type WallpaperPreviewContext } from "./pickerTiles";
import type { WallpaperPickerLabels, WallpaperPickerValue } from "./types";
import { WallpaperPickerModuleImport } from "./WallpaperPickerModuleImport";
import { WallpaperPickerTile } from "./WallpaperPickerTile";
import { WallpaperPickerUpload } from "./WallpaperPickerUpload";
import styles from "./WallpaperPicker.module.css";

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

interface WallpaperPickerOptionsProps extends WallpaperPreviewContext {
  options: WallpaperPickerOption[];
  value: WallpaperPickerValue;
  selectedKey: string;
  labels: WallpaperPickerLabels;
  locale: WallpaperLocale;
  accept: string;
  uploading: boolean;
  /** An import is in flight: the import tile shows a spinner and takes no files. */
  importingModule: boolean;
  importError?: ReactNode;
  /** What a tile had earlier in the session (its preview shows it). */
  recall: (key: string) => WallpaperPickerValue | undefined;
  onChoose: (option: WallpaperPickerOption) => void;
  onUpload?: (file: File) => void;
  onDeleteImage?: (id: string) => void;
  onImportModule?: (file: File) => void;
  onDeleteModule?: (id: string) => void;
}

/** The tile grid: a radiogroup (arrow keys move and select) plus the upload and import-module tiles; the whole grid takes dropped files. */
export function WallpaperPickerOptions(props: WallpaperPickerOptionsProps) {
  const {
    options, value, selectedKey, labels, locale, accept, uploading, importingModule, recall, onChoose, onUpload, onDeleteImage, onImportModule, onDeleteModule,
  } = props;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const [dropping, setDropping] = useState(false);
  const selectedIndex = options.findIndex((option) => option.key === selectedKey);
  const focusIndex = Math.max(0, selectedIndex);

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = wallpaperOptionTarget(options, index, event.key);
    if (target === null) return;
    event.preventDefault();
    refs.current[target]?.focus();
    const option = options[target];
    if (option && option.key !== selectedKey) onChoose(option);
  };

  const accepting = Boolean(onUpload) && !uploading;
  return (
    <div
      className={styles.grid}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDragOver={(event) => {
        if (!accepting || !hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDropping(false);
        const file = event.dataTransfer.files[0];
        if (accepting && file) onUpload?.(file);
      }}
    >
      <div aria-label={labels.options} className={styles.options} role="radiogroup">
        {options.map((option, index) => {
          const selected = option.key === selectedKey;
          // The selected tile is in use: it cannot be deleted from here.
          const deleteId = selected ? null : wallpaperOptionDeleteId(option);
          const deleteHandler = option.kind === "image" ? onDeleteImage : onDeleteModule;
          const onDelete = deleteId !== null && deleteHandler ? () => deleteHandler(deleteId) : undefined;
          const unavailable = option.kind === "unavailable";
          return (
            <WallpaperPickerTile key={option.key} dataKey={option.key} deleteLabel={option.kind === "image" ? labels.deleteImage : labels.deleteModule}
              focusable={index === focusIndex}
              label={wallpaperOptionCaption(option, labels, locale)} optionRef={(node) => { refs.current[index] = node; }}
              preview={wallpaperOptionPreview(option, selected ? value : recall(option.key), props)} selected={selected} onDelete={onDelete}
              mine={"mine" in option && option.mine ? labels.mine : undefined}
              disabledReason={unavailable ? wallpaperPickerReason(option.reason) : undefined}
              placeholder={unavailable ? <AlertCircle size="sm" /> : undefined}
              onKeyDown={(event) => move(event, index)} onSelect={() => onChoose(option)} />
          );
        })}
      </div>
      {onImportModule ? (
        <WallpaperPickerModuleImport error={props.importError} importing={importingModule} label={labels.importModule} onImportModule={onImportModule} />
      ) : null}
      {onUpload ? <WallpaperPickerUpload accept={accept} dropping={dropping} label={labels.addImage} uploading={uploading} onUpload={onUpload} /> : null}
    </div>
  );
}
