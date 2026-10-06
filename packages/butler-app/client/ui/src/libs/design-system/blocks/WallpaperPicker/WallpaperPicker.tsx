import { useEffect, useRef, type ReactNode } from "react";
import {
  WallpaperParamControls,
  useWallpaperRegistry,
  useWallpaperUserModules,
  type WallpaperImageLoader,
  type WallpaperLocale,
  type WallpaperRegistry,
  type WallpaperTone,
  type WallpaperUserModule,
} from "../Wallpaper";
import { useWallpaperImageLoader } from "../Wallpaper/imageLoaderContext";
import { useWallpaperTone } from "../Wallpaper/wallpaperTone";
import {
  wallpaperParamBuckets,
  wallpaperPickerDefault,
  wallpaperPickerKey,
  wallpaperPickerOptions,
  type WallpaperPickerOption,
} from "./pickerModel";
import type { WallpaperPickerImage, WallpaperPickerInherit, WallpaperPickerLabels, WallpaperPickerValue } from "./types";
import { WallpaperImageControls } from "./WallpaperImageControls";
import { WallpaperPickerOptions } from "./WallpaperPickerOptions";
import styles from "./WallpaperPicker.module.css";

/** Image types the upload tile's file chooser offers. */
export const WALLPAPER_PICKER_ACCEPT = "image/jpeg,image/png,image/webp";

export interface WallpaperPickerProps {
  value: WallpaperPickerValue;
  /** Every choice and edit, as the next value (controlled). */
  onChange: (value: WallpaperPickerValue) => void;
  labels: WallpaperPickerLabels;
  /** Reads module and param names from the manifests. */
  locale: WallpaperLocale;
  /** Uploaded images, in display order. */
  images?: readonly WallpaperPickerImage[];
  /** Adds the upload tile (click or drop a file); the caller uploads, then selects the new image. */
  onUpload?: (file: File) => void;
  /** Adds a delete button to every image tile except the selected one. */
  onDeleteImage?: (id: string) => void;
  /** An upload is in flight: the upload tile shows a spinner and takes nothing. */
  uploading?: boolean;
  /** Adds an import-module tile (pick a `.zip`); the caller installs it, then selects the new module. */
  onImportModule?: (file: File) => void;
  /** An import is in flight: the import tile shows a spinner and takes nothing. */
  importingModule?: boolean;
  /** Localized import feedback immediately under the import tile. */
  importError?: ReactNode;
  /** Adds a delete button to every user module tile except the selected one (built-ins cannot be deleted). */
  onDeleteModule?: (id: string) => void;
  /** Offers an `inherit` tile first (e.g. a project following the global wallpaper). */
  inherit?: WallpaperPickerInherit;
  /** Modules to offer and filters to list; defaults to the nearest `WallpaperRegistryProvider`'s, else the built-ins. */
  registry?: WallpaperRegistry;
  /** The user's modules, listed last and marked `labels.mine`; failing ones are disabled tiles. Defaults to the provider's. */
  userModules?: readonly WallpaperUserModule[];
  /** Loads image thumbnails; defaults to the nearest `WallpaperImageLoaderProvider`. */
  imageLoader?: WallpaperImageLoader;
  /** Tone of the stills and of param edits; omit to follow the nearest theme scope. */
  tone?: WallpaperTone;
  /** File chooser `accept`; defaults to JPEG, PNG and WebP. */
  accept?: string;
  dataTestClass?: string;
}

function Params({ value, registry, labels, locale, tone, onChange }: Required<Pick<WallpaperPickerProps, "value" | "registry" | "labels" | "locale" | "onChange">> & { tone: WallpaperTone }) {
  if (value === "inherit" || value.kind === "none") return null;
  if (value.kind === "image") return <WallpaperImageControls labels={labels} locale={locale} registry={registry} source={value} tone={tone} onChange={onChange} />;
  const module = registry.get(value.module);
  if (!module) return null;
  return (
    <WallpaperParamControls input={value} locale={locale} manifest={module.manifest} tone={tone}
      onChange={(input) => onChange({ kind: "live", module: value.module, ...wallpaperParamBuckets(input) })} />
  );
}

/**
 * Chooses a wallpaper: a grid of still thumbnails (none, every live module
 * with the user's own last, uploaded images, an upload tile; optionally
 * `inherit`) and, below it, the selected choice's controls generated from its
 * manifest (images: fit, dim, blur, filter). Controlled and storage-agnostic:
 * uploads and deletes go to the caller. Re-picking a tile restores what it
 * had in this session.
 */
export function WallpaperPicker({
  value, onChange, labels, locale, images = [], onUpload, onDeleteImage, uploading = false, inherit,
  onImportModule, importingModule = false, onDeleteModule, importError,
  registry: explicitRegistry, userModules: explicitUserModules, imageLoader, tone: explicitTone, accept = WALLPAPER_PICKER_ACCEPT, dataTestClass,
}: WallpaperPickerProps) {
  const registry = useWallpaperRegistry(explicitRegistry);
  const providedUserModules = useWallpaperUserModules();
  const userModules = explicitUserModules ?? providedUserModules;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tone = useWallpaperTone(rootRef, explicitTone);
  const loader = useWallpaperImageLoader(imageLoader);
  const remembered = useRef(new Map<string, WallpaperPickerValue>());
  const selectedKey = wallpaperPickerKey(value);

  useEffect(() => {
    remembered.current.set(selectedKey, value);
  }, [selectedKey, value]);

  const choose = (option: WallpaperPickerOption) => onChange(remembered.current.get(option.key) ?? wallpaperPickerDefault(option));
  return (
    <div className={styles.root} data-slot="wallpaper-picker" data-test-class={dataTestClass ? `wallpaper-picker ${dataTestClass}` : "wallpaper-picker"} ref={rootRef}>
      <WallpaperPickerOptions importError={importError} accept={accept} importingModule={importingModule} labels={labels} loader={loader} locale={locale} registry={registry} selectedKey={selectedKey}
        options={wallpaperPickerOptions({ registry, images, inherit, value, userModules })} recall={(key) => remembered.current.get(key)} tone={tone}
        uploading={uploading} value={value} onChoose={choose} onDeleteImage={onDeleteImage} onDeleteModule={onDeleteModule}
        onImportModule={onImportModule} onUpload={onUpload} />
      <Params labels={labels} locale={locale} registry={registry} tone={tone} value={value} onChange={onChange} />
    </div>
  );
}
