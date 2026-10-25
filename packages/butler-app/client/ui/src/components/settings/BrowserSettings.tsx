import { BrowsingAgentField } from "./BrowsingAgentField";
import { BrowserHistorySection } from "./BrowserHistorySection";
import { memo } from "react";
import { SettingsPage } from "./SettingsFormComponents";
import { SecuritySignInsSections } from "./SecuritySignInsSection";
import { BrowserVaultSections } from "./BrowserVaultSections";
import { BrowserSiteDataSection } from "./BrowserSiteDataSection";

/** The in-app browser's history, cookies and cache, saved sign-ins and import, then payment methods and autofill details. */
export const BrowserSettings = memo(function BrowserSettings() {
  return <SettingsPage><BrowsingAgentField /><BrowserHistorySection /><BrowserSiteDataSection /><SecuritySignInsSections /><BrowserVaultSections /></SettingsPage>;
});
