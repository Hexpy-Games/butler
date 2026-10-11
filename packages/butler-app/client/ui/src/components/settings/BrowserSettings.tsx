import { BrowserHistorySection } from "./BrowserHistorySection";
import { memo } from "react";
import { SettingsPage } from "./SettingsFormComponents";
import { SecuritySignInsSections } from "./SecuritySignInsSection";
import { BrowserVaultSections } from "./BrowserVaultSections";

/** The in-app browser's history, saved sign-ins and import, then payment methods and autofill details. */
export const BrowserSettings = memo(function BrowserSettings() {
  return <SettingsPage><BrowserHistorySection /><SecuritySignInsSections /><BrowserVaultSections /></SettingsPage>;
});
