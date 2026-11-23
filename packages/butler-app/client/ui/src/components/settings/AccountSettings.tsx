import { ButlerAccountSection } from "./ButlerAccountSection";
import { PublishedPagesSection } from "./PublishedPagesSection";
import { SettingsPage } from "./SettingsFormComponents";

export function AccountSettings() {
  return <SettingsPage><ButlerAccountSection /><PublishedPagesSection /></SettingsPage>;
}
