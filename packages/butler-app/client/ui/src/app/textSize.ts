import type { SettingsView } from "./types";

const factors = { default: 1, large: 1.15, larger: 1.3 } as const;

export function textSizeFactor(value: SettingsView["text_size"]): number {
  return factors[value];
}
