import { useEffect, useState } from "react";
import { systemPrefersDark } from "@/app/utils.ts";

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export function useSystemThemePreference(): boolean {
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return undefined;
    }

    const media = window.matchMedia(SYSTEM_DARK_QUERY);
    const handleChange = () => setPrefersDark(media.matches);
    handleChange();
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  return prefersDark;
}
