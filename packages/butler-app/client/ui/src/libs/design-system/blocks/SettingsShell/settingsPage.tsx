import { createContext, useContext, type ReactNode } from "react";

/** The page a settings section renders in: the title and description its header already shows. */
export interface SettingsPageCopy {
  title?: string;
  description?: string;
}

const SettingsPageContext = createContext<SettingsPageCopy | null>(null);

/** Provided by `SettingsShell` (`pageTitle` / `pageDescription`) around the detail content. */
export function SettingsPageProvider({ title, description, children }: SettingsPageCopy & { children: ReactNode }) {
  return <SettingsPageContext.Provider value={{ title, description }}>{children}</SettingsPageContext.Provider>;
}

export function useSettingsPage(): SettingsPageCopy | null {
  return useContext(SettingsPageContext);
}

/** Case, width (NFKC), whitespace and trailing sentence punctuation do not make copy distinct. */
function normalizeSettingsCopy(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\s.。!！?？:：…]+$/u, "")
    .toLocaleLowerCase();
}

/** A reference this many words or longer (a description) also repeats when a candidate only extends it. */
const PREFIX_MIN_WORDS = 3;

/**
 * Whether section copy repeats the page copy: equal after normalization, or,
 * for descriptions, the page description followed by more words. Short
 * titles only match exactly ("Model settings" is its own section on
 * "Models"), in every locale.
 */
export function repeatsSettingsCopy(candidate: string | null | undefined, reference: string | null | undefined): boolean {
  if (!candidate || !reference) return false;
  const value = normalizeSettingsCopy(candidate);
  const page = normalizeSettingsCopy(reference);
  if (!value || !page) return false;
  if (value === page) return true;
  return page.split(" ").length >= PREFIX_MIN_WORDS && value.startsWith(`${page} `);
}
