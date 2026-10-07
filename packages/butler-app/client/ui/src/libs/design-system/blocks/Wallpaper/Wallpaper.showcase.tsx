import { useMemo, useRef, useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { NativeSelect, NativeSelectOption } from "../../components/NativeSelect";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { validateWallpaperManifest } from "./manifest";
import { BUILTIN_WALLPAPERS } from "./registry";
import type { WallpaperMotion, WallpaperSource } from "./types";
import type { WallpaperParamInput } from "./values";
import { Wallpaper } from "./Wallpaper";
import { TransparentDecorationDemo } from "./Wallpaper.decoration";
import { ImageWallpaperDemo, showcaseImageLoader } from "./Wallpaper.demo";
import { WallpaperParamControls } from "./WallpaperParamControls";
import { useWallpaperTone } from "./wallpaperTone";
import styles from "./Wallpaper.showcase.module.css";

export const meta: ShowcaseMeta = {
  title: "Wallpaper",
  category: "Shell",
  tags: ["wallpaper", "background", "shader", "webgl", "theme"],
  status: "beta",
};

const copy = {
  "en-US": {
    wallpaper: "Wallpaper", motion: "Motion", auto: "Auto", paused: "Paused", image: "Image", none: "None",
    caption: "Fixed full-screen layer; this stage contains it.", values: "Values",
  },
  "ko-KR": {
    wallpaper: "월페이퍼", motion: "움직임", auto: "자동", paused: "일시정지", image: "이미지", none: "없음",
    caption: "화면 전체에 고정되는 층이며, 이 무대가 그 범위를 가둡니다.", values: "값",
  },
} as const;

const IMAGE_SOURCE: WallpaperSource = { kind: "image", asset: "showcase", fit: "cover", dim: 0.1, blur: 0 };
const SILK_SOURCE: WallpaperSource = { kind: "live", module: "butler.silk" };

function sourceFor(choice: string, input: WallpaperParamInput | undefined): WallpaperSource {
  if (choice === "none") return { kind: "none" };
  if (choice === "image") return IMAGE_SOURCE;
  return { kind: "live", module: choice, ...input };
}

/** Every registered module, with controls generated from its manifest. */
function Playground({ locale }: ShowcaseRenderContext) {
  const text = copy[locale];
  const stageRef = useRef<HTMLDivElement | null>(null);
  const tone = useWallpaperTone(stageRef);
  const [choice, setChoice] = useState("butler.bloom");
  const [inputs, setInputs] = useState<Record<string, WallpaperParamInput>>({});
  const [motion, setMotion] = useState<WallpaperMotion>("auto");
  const module = BUILTIN_WALLPAPERS.get(choice);
  const source = useMemo(() => sourceFor(choice, inputs[choice]), [choice, inputs]);
  // Filters (modules that require an image) draw over image sources, not on their own; living photos bring their own.
  // Decorations have their own story: they draw on a card, not a screen.
  const modules = BUILTIN_WALLPAPERS.list().filter(({ manifest, defaultImage }) => !manifest.decoration && (manifest.image !== "required" || defaultImage)).map(({ manifest }) => ({
    value: manifest.id,
    label: locale === "ko-KR" ? manifest.name.ko : manifest.name.en,
  }));

  return (
    <Stack gap="md">
      <div className={styles.stage} ref={stageRef}>
        <Wallpaper imageLoader={showcaseImageLoader} motion={motion} scope="container" source={source} />
      </div>
      <Stack align="row" cross="center" gap="md" wrap>
        <NativeSelect aria-label={text.wallpaper} size="sm" value={choice} onChange={(event) => setChoice(event.currentTarget.value)}>
          {[...modules, { value: "image", label: text.image }, { value: "none", label: text.none }].map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>
          ))}
        </NativeSelect>
        <SegmentedControl ariaLabel={text.motion} size="sm" value={motion} onValueChange={(value) => setMotion(value as WallpaperMotion)}
          options={[{ value: "auto", label: text.auto }, { value: "paused", label: text.paused }]} />
      </Stack>
      {module ? (
        <WallpaperParamControls input={inputs[choice] ?? {}} locale={locale} manifest={module.manifest} tone={tone}
          onChange={(input) => setInputs((current) => ({ ...current, [choice]: input }))} />
      ) : null}
    </Stack>
  );
}

// A sample wallpaper.json using every param type, labeled enum options and a shuffle seed.
const SAMPLE = validateWallpaperManifest({
  id: "example.paper", name: { en: "Paper", ko: "종이" }, version: "1.0.0", engine: 1, motion: "animated", image: "none", timePeriod: 3600,
  params: [
    { key: "tone", label: { en: "Paper tone", ko: "종이 색" }, type: "color", default: "#eeebe4", defaultDark: "#2a2723" },
    { key: "grain", label: { en: "Grain", ko: "그레인" }, type: "number", min: 0, max: 1, step: 0.01, default: 0.4 },
    {
      key: "ink", label: { en: "Ink", ko: "먹빛" }, type: "enum", default: "blueBlack",
      options: [{ value: "blueBlack", label: { en: "Blue-black", ko: "청묵" } }, { value: "pineSoot", label: { en: "Pine soot", ko: "송연묵" } }],
    },
    { key: "seed", label: { en: "Composition", ko: "구도" }, type: "number", min: 0, max: 1, step: 0.0001, default: 0.23, control: "shuffle" },
    { key: "folds", label: { en: "Folds", ko: "접힘" }, type: "boolean", default: true },
  ],
});

function GeneratedControls({ locale }: ShowcaseRenderContext) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const tone = useWallpaperTone(stageRef);
  const [input, setInput] = useState<WallpaperParamInput>({});
  if (!SAMPLE.ok) return null;
  return (
    <div ref={stageRef}>
      <Stack gap="md">
        <WallpaperParamControls input={input} locale={locale} manifest={SAMPLE.manifest} tone={tone} onChange={setInput} />
        <Typo.Caption tone="secondary">{`${copy[locale].values}: ${JSON.stringify(input)}`}</Typo.Caption>
      </Stack>
    </div>
  );
}

function ViewportScope({ locale }: ShowcaseRenderContext) {
  return (
    <div className={styles.viewportStage}>
      <Wallpaper source={SILK_SOURCE} />
      <div className={styles.caption}>
        <Typo.Caption tone="secondary">{copy[locale].caption}</Typo.Caption>
      </div>
    </div>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Module playground", render: (context) => <Playground {...context} /> },
  { name: "Image wallpaper", render: (context) => <ImageWallpaperDemo {...context} /> },
  { name: "Transparent decoration", render: (context) => <TransparentDecorationDemo {...context} /> },
  { name: "Generated param controls", render: (context) => <GeneratedControls {...context} /> },
  { name: "Viewport scope", render: (context) => <ViewportScope {...context} /> },
];
