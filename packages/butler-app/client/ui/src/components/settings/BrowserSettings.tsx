import { memo } from "react";
import { SettingsPage } from "./SettingsFormComponents";
import { SecuritySignInsSections } from "./SecuritySignInsSection";
import { BrowserVaultSections } from "./BrowserVaultSections";

/** The in-app browser's saved sign-ins and import, then payment methods and traveler details. */
export const BrowserSettings = memo(function BrowserSettings() {
  return <SettingsPage><SecuritySignInsSections /><BrowserVaultSections /></SettingsPage>;
});
