import { useRef, useState } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import type { ShowcaseRenderContext } from "../../showcase";
import { defineWallpaperModule, validateWallpaperManifest } from "./manifest";
import { BUILTIN_WALLPAPERS, createWallpaperRegistry } from "./registry";
import type { WallpaperImageFit, WallpaperImageLoader, WallpaperSource } from "./types";
import { resolveWallpaperValues, type WallpaperParamInput } from "./values";
import { Wallpaper } from "./Wallpaper";
import { WallpaperParamControls } from "./WallpaperParamControls";
import { useWallpaperTone } from "./wallpaperTone";
import styles from "./Wallpaper.showcase.module.css";

/** An evening landscape drawn locally (no external assets), encoded like an uploaded asset. */
function drawLandscape(width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("No 2D canvas"));
  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#f6c28b");
  sky.addColorStop(0.55, "#e07a5f");
  sky.addColorStop(1, "#3d405b");
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#fff1c1";
  context.beginPath();
  context.arc(width * 0.68, height * 0.42, height * 0.12, 0, Math.PI * 2);
  context.fill();
  ["#81b29a", "#4d7c6b", "#2f4f4f"].forEach((color, ridge) => {
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(0, height);
    for (let x = 0; x <= width; x += width / 32) {
      context.lineTo(x, height * (0.62 + ridge * 0.1) - Math.sin((x / width) * Math.PI * (2 + ridge) + ridge) * height * 0.06);
    }
    context.lineTo(width, height);
    context.fill();
  });
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png"));
}

const LANDSCAPES = new Map<string, Promise<Blob>>();

/** Stands in for the app's authenticated fetch: a 1600×1000 image, or its 480×300 thumbnail. */
export const showcaseImageLoader: WallpaperImageLoader = (_asset, variant) => {
  const landscape = LANDSCAPES.get(variant) ?? (variant === "full" ? drawLandscape(1600, 1000) : drawLandscape(480, 300));
  LANDSCAPES.set(variant, landscape);
  return landscape;
};

// A filter module: `image: required`, so it draws over the pre-fitted image.
const RISO = defineWallpaperModule({
  manifest: {
    id: "example.riso", name: { en: "Riso", ko: "리소" }, version: "1.0.0", engine: 1, motion: "static", image: "required",
    params: [
      { key: "ink", label: { en: "Ink", ko: "잉크" }, type: "color", default: "#2b50aa" },
      { key: "paper", label: { en: "Paper", ko: "종이" }, type: "color", default: "#f4efe6" },
    ],
  },
  fragment: [
    "// Two-ink print of the fitted image with paper grain.",
    "void main(){",
    "  float tone=dot(texture(u_image,gl_FragCoord.xy/u_resolution).rgb,vec3(.299,.587,.114));",
    "  float grain=texture(u_noiseTexture,gl_FragCoord.xy/256.).r-.5;",
    "  fragColor=vec4(mix(p_ink,p_paper,clamp(tone+grain*.08,0.,1.)),1.);",
    "}",
  ].join("\n"),
});
const REGISTRY = createWallpaperRegistry([...BUILTIN_WALLPAPERS.list(), RISO]);

// The image source's options as a manifest, so the generated param controls edit them.
const OPTIONS = validateWallpaperManifest({
  id: "example.image-options", name: { en: "Image", ko: "이미지" }, version: "1.0.0", engine: 1, motion: "static", image: "none",
  params: [
    {
      key: "fit", label: { en: "Fit", ko: "맞춤" }, type: "enum", default: "cover",
      options: [{ value: "cover", label: { en: "Fill", ko: "채우기" } }, { value: "contain", label: { en: "Fit", ko: "맞추기" } }],
    },
    { key: "dim", label: { en: "Dim", ko: "어둡게" }, type: "number", min: 0, max: 1, step: 0.05, default: 0.1 },
    { key: "blur", label: { en: "Blur", ko: "흐림" }, type: "number", min: 0, max: 1, step: 0.05, default: 0 },
    {
      key: "filter", label: { en: "Filter", ko: "필터" }, type: "enum", default: "none",
      options: [
        { value: "none", label: { en: "None", ko: "없음" } },
        { value: "butler.grain", label: { en: "Grain", ko: "그레인" } },
        { value: "example.riso", label: { en: "Riso", ko: "리소" } },
        { value: "butler.silk", label: { en: "Silk (no image input)", ko: "실크 (이미지 입력 없음)" } },
      ],
    },
  ],
});

function imageSource(values: Record<string, unknown>): WallpaperSource {
  const filter = values.filter === "none" ? {} : { filter: { module: String(values.filter) } };
  return { kind: "image", asset: "showcase-landscape", fit: values.fit as WallpaperImageFit, dim: Number(values.dim), blur: Number(values.blur), ...filter };
}

/** An image wallpaper with fit, dim, blur and filter controls; errors (a filter without image input) show below. */
export function ImageWallpaperDemo({ locale }: ShowcaseRenderContext) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const tone = useWallpaperTone(stageRef);
  const [input, setInput] = useState<WallpaperParamInput>({});
  const [error, setError] = useState("");
  if (!OPTIONS.ok) return null;
  const source = imageSource(resolveWallpaperValues(OPTIONS.manifest, input, tone));
  return (
    <Stack gap="md">
      <div className={styles.stage} ref={stageRef}>
        <Wallpaper imageLoader={showcaseImageLoader} registry={REGISTRY} scope="container" source={source}
          onError={(next) => setError(next.message)} />
      </div>
      <WallpaperParamControls input={input} locale={locale} manifest={OPTIONS.manifest} tone={tone}
        onChange={(next) => {
          setError("");
          setInput(next);
        }} />
      {error ? <Typo.Caption tone="secondary">{error}</Typo.Caption> : null}
    </Stack>
  );
}
