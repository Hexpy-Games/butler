import { Field, FieldTitle } from "../../components/Field";
import { Grid } from "../../components/Grid";
import { wallpaperLabelText, type WallpaperLocale } from "./labels";
import type { ResolvedWallpaperValues, WallpaperManifest, WallpaperParamSpec, WallpaperParamValue, WallpaperTone } from "./types";
import { resolveWallpaperValues, type WallpaperParamInput } from "./values";
import { WallpaperParamControl } from "./WallpaperParamControl";

/**
 * Stores an edit where the tone reads it: palettes (a preset resolves per
 * tone) in both tones; params with a dark default in the current tone's
 * bucket; everything else in `params`, which both tones fall back to.
 */
export function withWallpaperParam(
  input: WallpaperParamInput,
  spec: WallpaperParamSpec,
  value: WallpaperParamValue,
  tone: WallpaperTone,
): WallpaperParamInput {
  const params = { ...input.params, [spec.key]: value };
  const paramsDark = { ...input.paramsDark, [spec.key]: value };
  if (spec.type === "palette") return { params, paramsDark };
  if (tone === "dark" && spec.defaultDark !== undefined) return { ...input, paramsDark };
  return { ...input, params };
}

/** The control's value: the stored preset name or hex list for palettes, else the value resolved for the tone. */
function controlValue(spec: WallpaperParamSpec, input: WallpaperParamInput, values: ResolvedWallpaperValues): WallpaperParamValue | undefined {
  if (spec.type === "palette") return input.params?.[spec.key];
  const value = values[spec.key];
  return typeof value === "object" ? undefined : value;
}

export interface WallpaperParamControlsProps {
  /** Reads the manifest's `{ en, ko }` labels. */
  locale: WallpaperLocale;
  manifest: WallpaperManifest;
  /** The source's `params` / `paramsDark` (a live source, or an image's filter). */
  input: WallpaperParamInput;
  /** Edits land in the bucket this tone reads (`withWallpaperParam`). */
  tone: WallpaperTone;
  onChange: (input: WallpaperParamInput) => void;
}

/**
 * Labeled controls generated from a module's manifest params (label above
 * control): sliders, shuffle buttons, switches, labeled enum options, color
 * swatches and palette presets. `hidden` params are never listed; renders
 * nothing for a module without listed params.
 */
export function WallpaperParamControls({ locale, manifest, input, tone, onChange }: WallpaperParamControlsProps) {
  const listed = manifest.params.filter((spec) => !spec.hidden);
  if (listed.length === 0) return null;
  const values = resolveWallpaperValues(manifest, input, tone);
  return (
    <Grid columns="auto-fit" gap="md">
      {listed.map((spec) => {
        const resolved = values[spec.key];
        return (
          <Field key={spec.key}>
            <FieldTitle>{wallpaperLabelText(spec.label, locale)}</FieldTitle>
            <WallpaperParamControl colors={Array.isArray(resolved) ? resolved : undefined} locale={locale} spec={spec}
              value={controlValue(spec, input, values)} onChange={(value) => onChange(withWallpaperParam(input, spec, value, tone))} />
          </Field>
        );
      })}
    </Grid>
  );
}
