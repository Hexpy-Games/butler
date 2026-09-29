import { ColorSwatchInput } from "../../components/ColorSwatchInput";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Stack } from "../../components/Stack";
import { wallpaperTitleCase, type WallpaperLocale } from "./labels";
import type { WallpaperPaletteParam, WallpaperParamValue } from "./types";

const CUSTOM = "custom";

interface WallpaperPaletteControlProps {
  locale: WallpaperLocale;
  label: string;
  spec: WallpaperPaletteParam;
  /** A preset name, a hex list (custom) or unset (the first preset, which matches the default). */
  value: WallpaperParamValue | undefined;
  /** The colors the value resolves to for the current tone. */
  colors: readonly string[];
  onChange: (value: string | string[]) => void;
}

function customLabel(locale: WallpaperLocale): string {
  return locale === "ko-KR" ? "직접 지정" : "Custom";
}

/** Palette presets plus "Custom", whose swatches edit a hex list (seeded with the colors on screen). */
export function WallpaperPaletteControl({ locale, label, spec, value, colors, onChange }: WallpaperPaletteControlProps) {
  const presets = Object.keys(spec.presets ?? {});
  const selected = Array.isArray(value) || presets.length === 0
    ? CUSTOM
    : typeof value === "string" && presets.includes(value) ? value : presets[0]!;
  const setColor = (index: number, color: string) => {
    const next = [...colors];
    next[index] = color.toLowerCase();
    onChange(next);
  };
  return (
    <Stack gap="sm">
      {presets.length > 0 ? (
        <SegmentedControl ariaLabel={label} size="sm" value={selected}
          onValueChange={(next) => onChange(next === CUSTOM ? [...colors] : next)}
          options={[...presets.map((preset) => ({ value: preset, label: wallpaperTitleCase(preset) })), { value: CUSTOM, label: customLabel(locale) }]} />
      ) : null}
      {selected === CUSTOM ? (
        <Stack align="row" gap="sm" wrap>
          {colors.map((color, index) => (
            <ColorSwatchInput key={index} aria-label={`${label} ${index + 1}`} value={color}
              onChange={(event) => setColor(index, event.currentTarget.value)} />
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}
