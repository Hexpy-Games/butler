import { useButlerStore } from "@/app/store.ts";
import { resolveButlerMarkTheme } from "../conversationUtils";

export function useButlerMarkTheme(): "dark" | "light" {
  const appearanceTheme = useButlerStore(
    (state) => state.settings.appearance_theme,
  );
  return resolveButlerMarkTheme(appearanceTheme);
}
