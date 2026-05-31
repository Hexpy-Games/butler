import type { SettingsView } from "@/app/types.ts";
import {
  DEFAULT_PROMPT_FLUID_PALETTE,
  PROMPT_FLUID_PALETTES,
  fluidPaletteFromHexColors,
  type FluidPalette,
  type FluidTone,
  type FluidVariant,
} from "@/butler-ds";

const SYSTEM_BACKGROUND_PALETTES = {
  light: [
    [255, 255, 255],
    [255, 255, 255],
    [255, 255, 255],
    [255, 255, 255],
    [255, 255, 255],
    [255, 255, 255],
  ],
  dark: [
    [26, 27, 30],
    [26, 27, 30],
    [26, 27, 30],
    [26, 27, 30],
    [26, 27, 30],
    [26, 27, 30],
  ],
} as const satisfies Record<FluidTone, FluidPalette>;

export function mainScreenFluidEnabled(settings: SettingsView): boolean {
  return settings.main_screen_theme !== "none";
}

export function mainScreenFluidVariant(settings: SettingsView): FluidVariant {
  return settings.main_screen_theme === "silk" ? "silk" : "bloom";
}

export function mainScreenFluidPalette(
  settings: SettingsView,
  tone: FluidTone = "light",
): FluidPalette {
  if (settings.main_screen_theme === "silk") {
    return SYSTEM_BACKGROUND_PALETTES[tone];
  }
  if (settings.main_screen_theme_preset === "custom") {
    return fluidPaletteFromHexColors(settings.main_screen_theme_custom_colors);
  }
  const preset = settings.main_screen_theme_preset;
  if (
    preset === "monochrome" ||
    preset === "aurora" ||
    preset === "bloom" ||
    preset === "lavender"
  ) {
    return PROMPT_FLUID_PALETTES[preset];
  }
  if (preset === "morning") return PROMPT_FLUID_PALETTES.morning;
  return DEFAULT_PROMPT_FLUID_PALETTE;
}
