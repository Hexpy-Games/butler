import { memo } from "react";
import { SettingsPage } from "./SettingsFormComponents";
import { SecuritySignInsSections } from "./SecuritySignInsSection";

/** The in-app browser's saved sign-ins and import, in their existing order. */
export const BrowserSettings = memo(function BrowserSettings() {
  return <SettingsPage><SecuritySignInsSections /></SettingsPage>;
});
