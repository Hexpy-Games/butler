/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import type { WallpaperParamSpec } from "./types";
import { WallpaperParamControl } from "./WallpaperParamControl";
import { SHORELINE_WALLPAPER } from "./modules";
import { WallpaperParamControls, withWallpaperParam } from "./WallpaperParamControls";

const label = { en: "Mode", ko: "방식" };

function documentOf(spec: WallpaperParamSpec, locale: "en-US" | "ko-KR" = "en-US") {
  const markup = renderToStaticMarkup(<WallpaperParamControl locale={locale} spec={spec} value={undefined} onChange={() => undefined} />);
  return new JSDOM(markup).window.document;
}

test("enum options show their manifest labels in the viewer locale; bare options fall back to the value", () => {
  const spec: WallpaperParamSpec = {
    key: "mode", label, type: "enum", options: ["soft", "sharp"], optionLabels: { soft: { en: "Gentle", ko: "부드럽게" } }, default: "soft",
  };
  const names = (locale: "en-US" | "ko-KR") => [...documentOf(spec, locale).querySelectorAll("button")].map((button) => button.textContent);
  expect(names("en-US")).toEqual(["Gentle", "Sharp"]);
  expect(names("ko-KR")).toEqual(["부드럽게", "Sharp"]);
});

test("a shuffle number renders a shuffle button instead of a slider", () => {
  const spec: WallpaperParamSpec = {
    key: "seed", label: { en: "Composition", ko: "구도" }, type: "number", min: 0, max: 1, step: 0.0001, default: 0.23, control: "shuffle",
  };
  const document = documentOf(spec);
  expect(document.querySelector("input[type=range]")).toBeNull();
  expect(document.querySelector("button")?.getAttribute("aria-label")).toBe("Shuffle composition");
  expect(documentOf(spec, "ko-KR").querySelector("button")?.getAttribute("aria-label")).toBe("구도 섞기");
  const slider = documentOf({ ...spec, control: undefined });
  expect(slider.querySelector("input[type=range]")?.getAttribute("aria-label")).toBe("Composition");
});

test("edits land where the tone reads them", () => {
  const tint: WallpaperParamSpec = { key: "tint", label, type: "color", default: "#ffffff", defaultDark: "#101010" };
  const speed: WallpaperParamSpec = { key: "speed", label, type: "number", min: 0, max: 1, step: 0.1, default: 0.5 };
  const inks: WallpaperParamSpec = { key: "inks", label, type: "palette", size: 2, default: ["#000000", "#ffffff"], presets: {} };
  expect(withWallpaperParam({}, tint, "#ff0000", "light")).toEqual({ params: { tint: "#ff0000" } });
  expect(withWallpaperParam({ params: { speed: 0.2 } }, tint, "#220000", "dark")).toEqual({ params: { speed: 0.2 }, paramsDark: { tint: "#220000" } });
  expect(withWallpaperParam({}, speed, 0.9, "dark")).toEqual({ params: { speed: 0.9 } });
  expect(withWallpaperParam({}, inks, "dusk", "light")).toEqual({ params: { inks: "dusk" }, paramsDark: { inks: "dusk" } });
});

const PALETTE: WallpaperParamSpec = {
  key: "colors", label: { en: "Colors", ko: "색상" }, type: "palette", size: 2, default: ["#111111", "#222222"],
  presets: { dusk: { light: ["#111111", "#222222"], dark: ["#111111", "#222222"] }, dawn: { light: ["#eeeeee", "#dddddd"], dark: ["#eeeeee", "#dddddd"] } },
};

function paletteDocument(value: string | string[] | undefined, colors: string[]) {
  const markup = renderToStaticMarkup(
    <WallpaperParamControl colors={colors} locale="en-US" spec={PALETTE} value={value} onChange={() => undefined} />,
  );
  return new JSDOM(markup).window.document;
}

test("palettes offer their presets plus Custom; a hex list shows editable swatches", () => {
  const preset = paletteDocument("dawn", ["#eeeeee", "#dddddd"]);
  const names = [...preset.querySelectorAll('[role="radio"]')].map((radio) => [radio.textContent, radio.getAttribute("aria-checked")]);
  expect(names).toEqual([["Dusk", "false"], ["Dawn", "true"], ["Custom", "false"]]);
  expect(preset.querySelectorAll('input[type="color"]')).toHaveLength(0);
  // Unset reads as the first preset (it matches the default).
  expect(paletteDocument(undefined, ["#111111", "#222222"]).querySelector('[aria-checked="true"]')?.textContent).toBe("Dusk");
  const custom = paletteDocument(["#123456", "#abcdef"], ["#123456", "#abcdef"]);
  expect(custom.querySelector('[aria-checked="true"]')?.textContent).toBe("Custom");
  expect([...custom.querySelectorAll<HTMLInputElement>('input[type="color"]')].map((input) => [input.value, input.getAttribute("aria-label")]))
    .toEqual([["#123456", "Colors 1"], ["#abcdef", "Colors 2"]]);
});

test("hidden params are never listed: shoreline shows the same controls as before dayClouds", () => {
  const markup = renderToStaticMarkup(
    <WallpaperParamControls input={{}} locale="en-US" manifest={SHORELINE_WALLPAPER.manifest} tone="light" onChange={() => undefined} />,
  );
  const listed = SHORELINE_WALLPAPER.manifest.params.filter((spec) => !spec.hidden).map((spec) => spec.key);
  expect(listed).toEqual(["water", "waveFrequency", "shorePosition", "foamAmount", "realtime"]);
  expect(markup).toContain("Real time");
  expect(markup).not.toContain("Cloud shadows by day");
});
