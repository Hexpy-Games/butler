import { useLocales } from "expo-localization";
import { appLocaleFromLanguage, getAppCopy, type MobileCopy } from "../../butler-i18n/src/index.ts";
export function useMobileCopy(): MobileCopy {
  const [first] = useLocales();
  return getAppCopy(appLocaleFromLanguage(first?.languageCode)).mobile;
}
