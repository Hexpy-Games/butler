import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../../components/Card";
import { Typo } from "../../components/Typo";
import {
  Wallpaper,
  WallpaperImageLoaderProvider,
  WallpaperRegistryProvider,
  createWallpaperRegistry,
  defineWallpaperModule,
  BUILTIN_WALLPAPERS,
  type WallpaperSource,
} from "./index";
import { showcaseImageLoader } from "./Wallpaper.demo";

// #region recipe: Screen wallpaper
// Sources are data (settings, agent tools); keep the object stable across renders.
const APP_WALLPAPER: WallpaperSource = { kind: "live", module: "butler.bloom", params: { colors: "morning" } };

function ScreenWallpaper() {
  // `viewport` (default) is a fixed full-screen layer; paint containment here keeps it in the preview.
  return (
    <div style={{ position: "relative", height: 160, contain: "layout paint" }}>
      <Wallpaper source={APP_WALLPAPER} />
    </div>
  );
}
// #endregion

// #region recipe: Wallpaper inside a panel
const PANEL_WALLPAPER: WallpaperSource = { kind: "live", module: "butler.silk", paramsDark: { base: "#20242c" } };

function PanelWallpaper() {
  return (
    <div style={{ position: "relative", height: 160, overflow: "hidden" }}>
      <Wallpaper scope="container" source={PANEL_WALLPAPER} motion="paused" />
    </div>
  );
}
// #endregion

// #region recipe: Image wallpaper
// The app injects how asset bytes load (its authenticated fetch); the DS never knows where images live.
const IMAGE_WALLPAPER: WallpaperSource = { kind: "image", asset: "showcase-landscape", fit: "cover", dim: 0.2, blur: 0.1 };

function ImageWallpaper() {
  return (
    <WallpaperImageLoaderProvider loader={showcaseImageLoader}>
      <div style={{ position: "relative", height: 160, overflow: "hidden" }}>
        <Wallpaper scope="container" source={IMAGE_WALLPAPER} />
      </div>
    </WallpaperImageLoaderProvider>
  );
}
// #endregion

// #region recipe: Plug in a module
// wallpaper.json + shader.frag; user modules go through the same validation as built-ins.
const DUSK = defineWallpaperModule({
  manifest: {
    id: "example.dusk", name: { en: "Dusk", ko: "황혼" }, version: "1.0.0", engine: 1, motion: "static", image: "none",
    params: [{ key: "tint", label: { en: "Tint", ko: "색조" }, type: "color", default: "#f4a261", defaultDark: "#6d597a" }],
  },
  fragment: "void main(){vec2 uv=gl_FragCoord.xy/u_resolution;vec3 base=mix(vec3(.97),vec3(.08),u_dark);fragColor=vec4(mix(base,p_tint,uv.y*.4),1.);}",
});
const REGISTRY = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), DUSK]);
const DUSK_SOURCE: WallpaperSource = { kind: "live", module: "example.dusk" };

function PluggedModule() {
  return (
    <div style={{ position: "relative", height: 160, overflow: "hidden" }}>
      <Wallpaper registry={REGISTRY} scope="container" source={DUSK_SOURCE} />
    </div>
  );
}
// #endregion

// #region recipe: One registry for the app
// The app loads user modules, checks them (checkWallpaperModule) and provides one registry: every Wallpaper and
// WallpaperPicker below resolves against it, and onError hears failures to retire a broken user module.
const USER_MODULES = [{ id: "example.dusk", name: DUSK.manifest.name }];

function AppRegistry() {
  return (
    <WallpaperRegistryProvider registry={REGISTRY} userModules={USER_MODULES} onError={() => undefined}>
      <div style={{ position: "relative", height: 160, overflow: "hidden" }}>
        <Wallpaper scope="container" source={DUSK_SOURCE} />
      </div>
    </WallpaperRegistryProvider>
  );
}
// #endregion

function Note({ text }: { text: string }) {
  return <Card><Typo.Body>{text}</Typo.Body></Card>;
}

export const guidance: ShowcaseGuidance = {
  purpose: "The app wallpaper: a live WebGL2 shader module (built-in bloom and silk, or a user module), an image, or nothing, drawn behind a surface under one performance and motion policy.",
  whenToUse: [
    "Behind a whole screen (new chat, setup wizard) with the default viewport scope",
    "Behind a content area such as a dashboard with scope=\"container\"",
    "Whenever the background comes from settings or an agent as a WallpaperSource",
  ],
  whenNotToUse: [
    { when: "A translucent surface over the wallpaper", use: "TintedGlass" },
    { when: "Letting the user choose a wallpaper", use: "WallpaperPicker" },
    { when: "The new-chat prompt screen (pass its wallpaper prop instead)", use: "PromptSuggestionList" },
  ],
  recipes: [
    { name: "Screen wallpaper", description: "A live module with a preset palette as a fixed full-screen layer.", render: () => <ScreenWallpaper /> },
    { name: "Wallpaper inside a panel", description: "Container scope fills the nearest positioned parent; motion=\"paused\" holds a still frame.", render: () => <PanelWallpaper /> },
    { name: "Image wallpaper", description: "An image source with the app's imageLoader (prop or WallpaperImageLoaderProvider); fit, dim and blur are source fields.", render: () => <ImageWallpaper /> },
    { name: "Plug in a module", description: "defineWallpaperModule validates wallpaper.json + shader.frag; pass a registry that includes it.", render: () => <PluggedModule /> },
    { name: "One registry for the app", description: "WallpaperRegistryProvider hands built-ins plus user modules to every Wallpaper and picker below; a new registry hot-reloads a changed module.", render: () => <AppRegistry /> },
  ],
  doDont: [
    {
      do: { caption: "Keep the source stable: a module constant or memoized settings.", render: () => <Note text="const SOURCE = { kind: 'live', module: 'butler.bloom' }" /> },
      dont: { caption: "Build a new palette array for the source on every render.", render: () => <Note text="source={{ kind: 'live', module: 'butler.bloom', params: { colors: [...colors] } }}" /> },
    },
  ],
  content: [
    "Module names, param labels and enum option labels come from wallpaper.json ({ en, ko }); keep them short nouns.",
    "A composition seed is a number param with control \"shuffle\": the UI shows a shuffle button, not a slider.",
  ],
  accessibility: [
    "Decorative: the canvas is aria-hidden and never takes pointer events.",
    "Reduced motion holds a still frame and switches sources without a crossfade; motion=\"paused\" is the user's pause (WCAG 2.2.2).",
    "Keep text readable: wallpapers stay low-contrast behind text, and panels over them use TintedGlass.",
    "Image wallpapers: set dim from the asset's luminance (wallpaperImageDefaultDim); the dark theme dims one step more on its own.",
    "Pass contentRect (the text area's client rect) so modules can keep detail away from the text via u_contentRect.",
  ],
  tokens: ["--adaptive-viewport-block-size", "--radius-panel"],
};
