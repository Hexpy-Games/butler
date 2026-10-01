import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { BUILTIN_WALLPAPERS, createWallpaperRegistry, defineWallpaperModule, type WallpaperSource, type WallpaperUserModule } from "../Wallpaper";
import type { WallpaperPickerImage, WallpaperPickerLabels, WallpaperPickerValue } from "./types";

/** Picker copy as a product container would pass it. */
export const PICKER_LABELS: Record<ShowcaseRenderContext["locale"], WallpaperPickerLabels> = {
  "en-US": {
    options: "Wallpaper", none: "None", image: (index) => `Image ${index}`, addImage: "Add image", deleteImage: "Delete image",
    fit: "Fit", fill: "Fill", fitWhole: "Whole image", dim: "Dim", blur: "Blur", filter: "Filter", noFilter: "None", mine: "Mine",
    importModule: "Import module", deleteModule: "Delete module",
  },
  "ko-KR": {
    options: "월페이퍼", none: "없음", image: (index) => `이미지 ${index}`, addImage: "이미지 추가", deleteImage: "이미지 삭제",
    fit: "맞춤", fill: "채우기", fitWhole: "맞추기", dim: "어둡게", blur: "흐림", filter: "필터", noFilter: "없음", mine: "내 모듈",
    importModule: "모듈 가져오기", deleteModule: "모듈 삭제",
  },
};

export const INHERIT_LABEL: Record<ShowcaseRenderContext["locale"], string> = { "en-US": "Same as Home", "ko-KR": "홈과 같게" };

const START_IMAGES: WallpaperPickerImage[] = [{ id: "landscape", luminance: 0.55 }];
/** The module `onImportModule` "installs" (already in `USER_DEMO_REGISTRY`, held back from the initial `userModules`). */
const IMPORTED_MODULE: WallpaperUserModule = { id: "me.mist", name: { en: "Mist", ko: "안개" } };

/**
 * A picker container stand-in: uploads become new images, and a module
 * import installs `IMPORTED_MODULE` (after a short wait, as a gateway round
 * trip would); either is selected once it lands. Deletes drop an image or a
 * module from their lists.
 */
export function usePickerDemo(initial: WallpaperPickerValue, initialModules: readonly WallpaperUserModule[] = []) {
  const [value, setValue] = useState<WallpaperPickerValue>(initial);
  const [images, setImages] = useState<WallpaperPickerImage[]>(START_IMAGES);
  const [uploading, setUploading] = useState(false);
  const [userModules, setUserModules] = useState<readonly WallpaperUserModule[]>(initialModules);
  const [importingModule, setImportingModule] = useState(false);
  const onUpload = () => {
    setUploading(true);
    window.setTimeout(() => {
      const image = { id: `upload-${Date.now()}`, luminance: 0.8 };
      setImages((current) => [...current, image]);
      setValue({ kind: "image", asset: image.id, fit: "cover", dim: 0.35, blur: 0 });
      setUploading(false);
    }, 600);
  };
  const onDeleteImage = (id: string) => setImages((current) => current.filter((image) => image.id !== id));
  const onImportModule = () => {
    setImportingModule(true);
    window.setTimeout(() => {
      setUserModules((current) => (current.some((module) => module.id === IMPORTED_MODULE.id) ? current : [...current, IMPORTED_MODULE]));
      setValue({ kind: "live", module: IMPORTED_MODULE.id });
      setImportingModule(false);
    }, 600);
  };
  const onDeleteModule = (id: string) => setUserModules((current) => current.filter((module) => module.id !== id));
  const source: WallpaperSource = value === "inherit" ? { kind: "live", module: "butler.silk" } : value;
  return { value, setValue, images, uploading, onUpload, onDeleteImage, userModules, importingModule, onImportModule, onDeleteModule, source };
}

// A user-authored module (as the app loads one from <BUTLER_HOME>/wallpapers/), one whose shader failed to compile,
// and one held back so the "Import module" tile has something new to add.
const DUSK = defineWallpaperModule({
  manifest: { id: "me.dusk", name: { en: "Dusk", ko: "황혼" }, version: "0.1.0", engine: 1, motion: "static", image: "none", params: [] },
  fragment: "void main(){vec2 uv=gl_FragCoord.xy/u_resolution;fragColor=vec4(mix(vec3(.96,.72,.55),vec3(.36,.38,.62),uv.y),1.);}",
});
const MIST = defineWallpaperModule({
  manifest: { id: "me.mist", name: IMPORTED_MODULE.name, version: "0.1.0", engine: 1, motion: "static", image: "none", params: [] },
  fragment: "void main(){vec2 uv=gl_FragCoord.xy/u_resolution;fragColor=vec4(mix(vec3(.82,.85,.88),vec3(.62,.66,.7),uv.y),1.);}",
});
export const USER_DEMO_REGISTRY = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), DUSK, MIST]);
export const USER_DEMO_MODULES: WallpaperUserModule[] = [
  { id: "me.dusk", name: DUSK.manifest.name },
  { id: "me.rain", name: { en: "Rain", ko: "비" }, error: "ERROR: 0:14: 'drops' : undeclared identifier\nERROR: 1 compilation errors." },
];
