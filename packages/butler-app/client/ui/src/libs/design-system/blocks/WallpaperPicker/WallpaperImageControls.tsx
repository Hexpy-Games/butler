import { Field, FieldTitle } from "../../components/Field";
import { Grid } from "../../components/Grid";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Slider } from "../../components/Slider";
import { Stack } from "../../components/Stack";
import {
  WallpaperParamControls,
  wallpaperLabelText,
  type WallpaperImageFit,
  type WallpaperLocale,
  type WallpaperRegistry,
  type WallpaperTone,
} from "../Wallpaper";
import { wallpaperImageFilters, wallpaperParamBuckets, withWallpaperImageFilter, type WallpaperImageSource } from "./pickerModel";
import type { WallpaperPickerLabels } from "./types";

const NO_FILTER = "none";
/** The dim and blur sliders' grid. */
const UNIT_STEP = 0.05;

interface WallpaperImageControlsProps {
  source: WallpaperImageSource;
  registry: WallpaperRegistry;
  labels: WallpaperPickerLabels;
  locale: WallpaperLocale;
  tone: WallpaperTone;
  onChange: (source: WallpaperImageSource) => void;
}

/** An image's options: fit (fill / whole), dim, blur, a filter (modules that take an image) and that filter's params. */
export function WallpaperImageControls({ source, registry, labels, locale, tone, onChange }: WallpaperImageControlsProps) {
  const filters = wallpaperImageFilters(registry);
  const filter = source.filter ? filters.find((module) => module.manifest.id === source.filter?.module) : undefined;
  const slider = (key: "dim" | "blur", label: string) => (
    <Field>
      <FieldTitle>{label}</FieldTitle>
      <Slider aria-label={label} max={1} min={0} step={UNIT_STEP} value={source[key]} onValueChange={(next) => onChange({ ...source, [key]: next })} />
    </Field>
  );
  return (
    <Stack gap="md">
      <Grid columns="auto-fit" gap="md">
        <Field>
          <FieldTitle>{labels.fit}</FieldTitle>
          <SegmentedControl ariaLabel={labels.fit} size="sm" value={source.fit}
            onValueChange={(fit) => onChange({ ...source, fit: fit as WallpaperImageFit })}
            options={[{ value: "cover", label: labels.fill }, { value: "contain", label: labels.fitWhole }]} />
        </Field>
        {filters.length > 0 ? (
          <Field>
            <FieldTitle>{labels.filter}</FieldTitle>
            <SegmentedControl ariaLabel={labels.filter} size="sm" value={filter?.manifest.id ?? NO_FILTER}
              onValueChange={(id) => onChange(withWallpaperImageFilter(source, id === NO_FILTER ? null : id))}
              options={[
                { value: NO_FILTER, label: labels.noFilter },
                ...filters.map((module) => ({ value: module.manifest.id, label: wallpaperLabelText(module.manifest.name, locale) })),
              ]} />
          </Field>
        ) : null}
        {slider("dim", labels.dim)}
        {slider("blur", labels.blur)}
      </Grid>
      {filter && source.filter ? (
        <WallpaperParamControls input={source.filter} locale={locale} manifest={filter.manifest} tone={tone}
          onChange={(input) => onChange({ ...source, filter: { module: filter.manifest.id, ...wallpaperParamBuckets(input) } })} />
      ) : null}
    </Stack>
  );
}
