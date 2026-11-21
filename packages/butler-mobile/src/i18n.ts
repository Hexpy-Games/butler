import { useLocales } from "expo-localization";
import { appLocaleFromLanguage, getAppCopy, type MobileCopy } from "../../butler-i18n/src/index.ts";
export function useAppLocale() {
  const [first] = useLocales();
  return appLocaleFromLanguage(first?.languageCode);
}

export function useMobileCopy(): MobileCopy {
  return getAppCopy(useAppLocale()).mobile;
}
