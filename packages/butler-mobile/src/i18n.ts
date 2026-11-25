import { getLocales, useLocales } from "expo-localization";
import { appLocaleFromLanguage, getAppCopy, type MobileCopy } from "../../butler-i18n/src/index.ts";
export function useAppLocale() {
  const [first] = useLocales();
  return appLocaleFromLanguage(first?.languageCode);
}

export function pushLang(): "ko" | "en" {
  return appLocaleFromLanguage(getLocales()[0]?.languageCode) === "ko-KR" ? "ko" : "en";
}

export function useMobileCopy(): MobileCopy {
  return getAppCopy(useAppLocale()).mobile;
}
