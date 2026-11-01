import { useState, type ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Stack } from "../../components/Stack";
import { SettingsField } from "../SettingsField";
import { SettingsPage, SettingsSection } from "../SettingsSection";
import { Wallpaper, WallpaperImageLoaderProvider } from "../Wallpaper";
import { showcaseImageLoader } from "../Wallpaper/Wallpaper.demo";
import styles from "../Wallpaper/Wallpaper.showcase.module.css";
import {
  CONVERSATION_COPY, INHERIT_LABEL, OverlayDemoControl, PICKER_LABELS, USER_DEMO_MODULES, USER_DEMO_REGISTRY, usePickerDemo,
} from "./WallpaperPicker.demo";
import { WallpaperPicker } from "./WallpaperPicker";

export const meta: ShowcaseMeta = {
  title: "WallpaperPicker",
  category: "Settings & Forms",
  tags: ["wallpaper", "picker", "background", "image", "upload", "import", "module", "settings"],
  status: "beta",
};

/** Settings > Appearance field labels as the App passes them. */
const FIELD_COPY = {
  "en-US": { homeScreen: "Home screen", conversationSection: "Conversation", wallpaper: "Wallpaper", wallpaperHint: "The new chat screen's background.", conversation: "Conversation background" },
  "ko-KR": { homeScreen: "홈 화면", conversationSection: "대화창", wallpaper: "월페이퍼", wallpaperHint: "새 채팅 화면의 배경입니다.", conversation: "대화창 배경" },
} as const;

/** The picker as Settings renders it: the control of a SettingsField in a form section. */
function InSettings({ locale, field = "wallpaper", children }: {
  locale: ShowcaseRenderContext["locale"]; field?: "wallpaper" | "conversation"; children: ReactNode;
}) {
  const copy = FIELD_COPY[locale];
  const home = field === "wallpaper";
  return (
    <SettingsPage>
      <SettingsSection id={home ? "home-screen" : "conversation"} kind="form" title={home ? copy.homeScreen : copy.conversationSection}>
        <SettingsField settingId={home ? "main-screen-wallpaper" : "conversation-background"} label={home ? copy.wallpaper : copy.conversation}
          description={home ? copy.wallpaperHint : undefined} control={<Stack gap="sm">{children}</Stack>} />
      </SettingsSection>
    </SettingsPage>
  );
}

/** The picker over a live preview of its value: every change crossfades. */
function HomeScreen({ locale }: ShowcaseRenderContext) {
  const demo = usePickerDemo({ kind: "live", module: "butler.bloom", params: { colors: "aurora" } });
  return (
    <WallpaperImageLoaderProvider loader={showcaseImageLoader}>
      <Stack gap="lg">
        <div className={styles.stage}>
          <Wallpaper scope="container" source={demo.source} />
        </div>
        <InSettings locale={locale}>
          <WallpaperPicker images={demo.images} labels={PICKER_LABELS[locale]} locale={locale} uploading={demo.uploading} value={demo.value}
            onChange={demo.setValue} onDeleteImage={demo.onDeleteImage} onUpload={demo.onUpload} />
        </InSettings>
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
    <InSettings locale={locale}>
      <WallpaperPicker imageLoader={showcaseImageLoader} images={demo.images} labels={PICKER_LABELS[locale]} locale={locale} value={demo.value}
        onChange={demo.setValue} onDeleteImage={demo.onDeleteImage} onUpload={demo.onUpload} />
    </InSettings>
  );
}

/**
 * The conversation background: the caller's overlay slider after the tile's
 * own options (live modules and images only), and photos picked with no dim.
 */
function ConversationBackground({ locale }: ShowcaseRenderContext) {
  const demo = usePickerDemo({ kind: "live", module: "butler.bloom", params: { colors: "aurora" } });
  const [overlay, setOverlay] = useState(70);
  const copy = CONVERSATION_COPY[locale];
  const overlaid = demo.value !== "inherit" && demo.value.kind !== "none";
  return (
    <InSettings locale={locale} field="conversation">
      <WallpaperPicker imageDefaults={{ dim: 0 }} imageLoader={showcaseImageLoader} images={demo.images} labels={{ ...PICKER_LABELS[locale], none: copy.none }}
        locale={locale} uploading={demo.uploading} value={demo.value} onChange={demo.setValue} onDeleteImage={demo.onDeleteImage} onUpload={demo.onUpload}
        extraControls={overlaid ? <OverlayDemoControl label={copy.overlay} value={overlay} onChange={setOverlay} /> : undefined} />
    </InSettings>
  );
}

/** The user's own modules after the built-ins, marked; one that fails to compile is disabled and names why on hover. Import installs another; delete removes one. */
function UserModules({ locale }: ShowcaseRenderContext) {
  const demo = usePickerDemo({ kind: "live", module: "me.dusk" }, USER_DEMO_MODULES);
  return (
    <InSettings locale={locale}>
      <WallpaperPicker importingModule={demo.importingModule} labels={PICKER_LABELS[locale]} locale={locale} registry={USER_DEMO_REGISTRY}
        userModules={demo.userModules} value={demo.value} onChange={demo.setValue} onDeleteModule={demo.onDeleteModule} onImportModule={demo.onImportModule} />
    </InSettings>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "User modules", render: (context) => <UserModules {...context} /> },
  { name: "Home screen with preview", render: (context) => <HomeScreen {...context} /> },
  { name: "Image with a filter", render: (context) => <ImageOptions {...context} /> },
  { name: "Project scope with inherit", render: (context) => <ProjectScope {...context} /> },
  { name: "Conversation background with an extra control", widths: ["375", "app", "wide"], render: (context) => <ConversationBackground {...context} /> },
];

const IMPORT_ERROR = { "en-US": "Not a wallpaper module.", "ko-KR": "배경 모듈이 아닙니다." } as const;

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "loading", "invalid"],
  render: ({ locale, state }) => (
    <InSettings locale={locale}>
      <WallpaperPicker labels={PICKER_LABELS[locale]} locale={locale} uploading={state === "loading"} value={{ kind: "none" }}
        importError={state === "invalid" ? IMPORT_ERROR[locale] : undefined}
        onChange={() => undefined} onImportModule={() => undefined} onUpload={() => undefined} />
    </InSettings>
  ),
};
