import { appCopy, useAppLocale } from "@/app/copy.ts";
import { SettingsPage as DsSettingsPage, type SettingsPageProps } from "@/butler-ds";

/** The DS settings page with the app's section state copy. */
export function SettingsPage(props: Omit<SettingsPageProps, "labels">) {
  useAppLocale();
  return <DsSettingsPage labels={appCopy.settings.sectionState} {...props} />;
}
