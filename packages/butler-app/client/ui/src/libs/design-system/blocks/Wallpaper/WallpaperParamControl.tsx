import { ColorSwatchInput } from "../../components/ColorSwatchInput";
import { IconButton } from "../../components/IconButton";
import { RefreshCcw } from "../../components/Icons";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Slider } from "../../components/Slider";
import { Switch } from "../../components/Switch";
import { wallpaperLabelText, wallpaperTitleCase, type WallpaperLocale } from "./labels";
import type { WallpaperNumberParam, WallpaperParamSpec, WallpaperParamValue } from "./types";
import { shuffledWallpaperNumber } from "./values";
import { WallpaperPaletteControl } from "./WallpaperPaletteControl";

export interface WallpaperParamControlProps {
  locale: WallpaperLocale;
  spec: WallpaperParamSpec;
  /** The value for the current tone (a preset name or hex list for palettes); the spec default when unset. */
  value: WallpaperParamValue | undefined;
  /** Palettes: the colors the value resolves to (edited as swatches when custom). */
  colors?: readonly string[];
  onChange: (value: WallpaperParamValue) => void;
}

function shuffleLabel(label: string, locale: WallpaperLocale): string {
  return locale === "ko-KR" ? `${label} 섞기` : `Shuffle ${label.toLowerCase()}`;
}

function NumberControl({ locale, spec, value, onChange }: { locale: WallpaperLocale; spec: WallpaperNumberParam; value: number; onChange: (value: number) => void }) {
  const label = wallpaperLabelText(spec.label, locale);
  if (spec.control === "shuffle") {
    return (
      <IconButton label={shuffleLabel(label, locale)} onClick={() => onChange(shuffledWallpaperNumber(spec))}>
        <RefreshCcw size="md" />
      </IconButton>
    );
  }
  return <Slider aria-label={label} max={spec.max} min={spec.min} step={spec.step} value={value} onValueChange={onChange} />;
}

/**
 * One control per manifest param type: number → slider (or a shuffle button),
 * boolean → switch, enum → segmented options with their manifest labels,
 * color → swatch, palette → presets plus custom swatches.
 */
export function WallpaperParamControl({ locale, spec, value, colors = [], onChange }: WallpaperParamControlProps) {
  const label = wallpaperLabelText(spec.label, locale);
  switch (spec.type) {
    case "number":
      return <NumberControl locale={locale} spec={spec} value={typeof value === "number" ? value : spec.default} onChange={onChange} />;
    case "boolean":
      return <Switch aria-label={label} checked={typeof value === "boolean" ? value : spec.default} onCheckedChange={onChange} />;
    case "enum":
      return (
        <SegmentedControl ariaLabel={label} size="sm" value={typeof value === "string" ? value : spec.default} onValueChange={onChange}
          options={spec.options.map((option) => {
            const optionLabel = spec.optionLabels?.[option];
            return { value: option, label: optionLabel ? wallpaperLabelText(optionLabel, locale) : wallpaperTitleCase(option) };
          })} />
      );
    case "color":
      return (
        <ColorSwatchInput aria-label={label} value={typeof value === "string" ? value : spec.default}
          onChange={(event) => onChange(event.currentTarget.value.toLowerCase())} />
      );
    case "palette":
      return <WallpaperPaletteControl colors={colors} label={label} locale={locale} spec={spec} value={value} onChange={onChange} />;
  }
}
