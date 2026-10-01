import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Wallpaper, WallpaperImageLoaderProvider } from "../Wallpaper";
import { showcaseImageLoader } from "../Wallpaper/Wallpaper.demo";
import styles from "../Wallpaper/Wallpaper.showcase.module.css";
import { INHERIT_LABEL, PICKER_LABELS, USER_DEMO_MODULES, USER_DEMO_REGISTRY, usePickerDemo } from "./WallpaperPicker.demo";
import { WallpaperPicker } from "./WallpaperPicker";

export const meta: ShowcaseMeta = {
  title: "WallpaperPicker",
  category: "Settings & Forms",
  tags: ["wallpaper", "picker", "background", "image", "upload", "import", "module", "settings"],
  status: "beta",
};

/** The picker over a live preview of its value: every change crossfades. */
function HomeScreen({ locale }: ShowcaseRenderContext) {
  const demo = usePickerDemo({ kind: "live", module: "butler.bloom", params: { colors: "aurora" } });
  return (
    <WallpaperImageLoaderProvider loader={showcaseImageLoader}>
      <Stack gap="lg">
        <div className={styles.stage}>
          <Wallpaper scope="container" source={demo.source} />
        </div>
        <WallpaperPicker images={demo.images} labels={PICKER_LABELS[locale]} locale={locale} uploading={demo.uploading} value={demo.value}
          onChange={demo.setValue} onDeleteImage={demo.onDeleteImage} onUpload={demo.onUpload} />
      </Stack>
    </WallpaperImageLoaderProvider>
  );
}

/** A project following the global wallpaper until it picks its own. */
function ProjectScope({ locale }: ShowcaseRenderContext) {
  const demo = usePickerDemo("inherit");
  return (
    <WallpaperPicker imageLoader={showcaseImageLoader} images={demo.images} inherit={{ label: INHERIT_LABEL[locale], source: { kind: "live", module: "butler.silk" } }}
      labels={PICKER_LABELS[locale]} locale={locale} value={demo.value} onChange={demo.setValue} />
  );
}

function ImageOptions({ locale }: ShowcaseRenderContext) {
  const demo = usePickerDemo({ kind: "image", asset: "landscape", fit: "cover", dim: 0.2, blur: 0.1, filter: { module: "butler.grain" } });
  return (
    <WallpaperPicker imageLoader={showcaseImageLoader} images={demo.images} labels={PICKER_LABELS[locale]} locale={locale} value={demo.value}
      onChange={demo.setValue} onDeleteImage={demo.onDeleteImage} onUpload={demo.onUpload} />
  );
}

/** The user's own modules after the built-ins, marked; one that fails to compile is disabled and names why on hover. Import installs another; delete removes one. */
function UserModules({ locale }: ShowcaseRenderContext) {
  const demo = usePickerDemo({ kind: "live", module: "me.dusk" }, USER_DEMO_MODULES);
  return (
    <WallpaperPicker importingModule={demo.importingModule} labels={PICKER_LABELS[locale]} locale={locale} registry={USER_DEMO_REGISTRY}
      userModules={demo.userModules} value={demo.value} onChange={demo.setValue} onDeleteModule={demo.onDeleteModule} onImportModule={demo.onImportModule} />
  );
}

export const stories: ShowcaseStory[] = [
  { name: "User modules", render: (context) => <UserModules {...context} /> },
  { name: "Home screen with preview", render: (context) => <HomeScreen {...context} /> },
  { name: "Image with a filter", render: (context) => <ImageOptions {...context} /> },
  { name: "Project scope with inherit", render: (context) => <ProjectScope {...context} /> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "loading"],
  render: ({ locale, state }) => (
    <WallpaperPicker labels={PICKER_LABELS[locale]} locale={locale} uploading={state === "loading"} value={{ kind: "none" }}
      onChange={() => undefined} onUpload={() => undefined} />
  ),
};
