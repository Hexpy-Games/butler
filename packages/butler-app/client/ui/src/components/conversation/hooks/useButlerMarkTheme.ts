import { useAppearanceTheme } from "@/stores/appearanceStore.ts";
import { resolveButlerMarkTheme } from "../conversationUtils";

export function useButlerMarkTheme(): "dark" | "light" {
  return resolveButlerMarkTheme(useAppearanceTheme());
}
