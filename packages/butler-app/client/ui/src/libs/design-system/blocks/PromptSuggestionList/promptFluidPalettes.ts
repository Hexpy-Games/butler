export type FluidRgb = readonly [number, number, number];
export type FluidPalette = readonly [
  FluidRgb,
  FluidRgb,
  FluidRgb,
  FluidRgb,
  FluidRgb,
  FluidRgb,
];

export const PROMPT_FLUID_COLOR_COUNT = 6;
export const VIOLET_COLOR = [139, 92, 246] as const;
export const INDIGO_COLOR = [99, 102, 241] as const;
export const PROMPT_FLUID_PALETTE_PRESET_IDS = [
  "monochrome",
  "aurora",
  "bloom",
  "lavender",
  "morning",
] as const;
export const PROMPT_FLUID_PALETTES = {
  monochrome: [
    [50, 66, 77],
    [85, 93, 124],
    [72, 92, 112],
    [106, 125, 154],
    [83, 112, 141],
    [67, 77, 112],
  ],
  aurora: [
    VIOLET_COLOR,
    INDIGO_COLOR,
    [56, 189, 248],
    [45, 212, 191],
    [244, 114, 182],
    [251, 191, 36],
  ],
  bloom: [
    [217, 70, 239],
    [244, 114, 182],
    [251, 146, 60],
    [250, 204, 21],
    [52, 211, 153],
    [129, 140, 248],
  ],
  lavender: [
    VIOLET_COLOR,
    INDIGO_COLOR,
    [167, 139, 250],
    [129, 140, 248],
    [196, 181, 253],
    [147, 197, 253],
  ],
  morning: [
    [125, 211, 252],
    [96, 165, 250],
    [165, 180, 252],
    [251, 207, 232],
    [254, 215, 170],
    [187, 247, 208],
  ],
} as const satisfies Record<string, FluidPalette>;
export const DEFAULT_PROMPT_FLUID_PALETTE = PROMPT_FLUID_PALETTES.monochrome;
export type PromptFluidPalettePresetId =
  (typeof PROMPT_FLUID_PALETTE_PRESET_IDS)[number];

function toHexPart(value: number): string {
  return value.toString(16).padStart(2, "0");
}

export function fluidRgbToHex(color: FluidRgb): string {
  return `#${toHexPart(color[0])}${toHexPart(color[1])}${toHexPart(color[2])}`;
}

function hexToFluidRgb(value: string): FluidRgb | null {
  const normalized = value.trim();
  if (!/^#[0-9a-f]{6}$/iu.test(normalized)) return null;
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

export function fluidPaletteToHexColors(palette: FluidPalette): string[] {
  return palette.map(fluidRgbToHex);
}

export function fluidPaletteFromHexColors(
  colors: readonly string[] | null | undefined,
  fallback: FluidPalette = DEFAULT_PROMPT_FLUID_PALETTE,
): FluidPalette {
  const next = colors?.map(hexToFluidRgb).filter((color) => color !== null);
  if (next?.length !== PROMPT_FLUID_COLOR_COUNT) return fallback;
  return next as unknown as FluidPalette;
}
