import type { ShowcaseGuidance } from "../../showcase";
import { Switch } from "../../components/Switch";
import { FormSection } from "../FormSection";
import { SettingsField } from "../SettingsField";
import { SettingsHeader } from "../SettingsHeader";
import { SettingsNav } from "../SettingsNav";
import { SettingsPageProvider, SettingsShell } from "./index";

// #region recipe: Settings page in the shell
function NotificationsPage() {
  return (
    <SettingsShell pageTitle="Notifications" pageDescription="Choose what Butler tells you about."
      sidebar={<SettingsNav items={[{ id: "general", label: "General" }, { id: "notifications", label: "Notifications", active: true }]} />}
      detailHeader={<SettingsHeader title="Notifications" description="Choose what Butler tells you about." />}
      detail={(
        <FormSection title="Replies">
          <SettingsField id="replies" label="New replies" control={<Switch id="replies" defaultChecked />} />
        </FormSection>
      )} />
  );
}
// #endregion

// #region recipe: Page copy for sections outside the shell
function SectionWithPageCopy() {
  return (
    <SettingsPageProvider title="General" description="Language and search defaults.">
      {/* The description repeats the page description, so FormSection drops it; a title never repeats the page. */}
      <FormSection title="Sidebar" description="Language and search defaults.">
        <SettingsField id="groups" label="Smart groups" control={<Switch id="groups" />} />
      </FormSection>
    </SettingsPageProvider>
  );
}
// #endregion

/** Viewer frame only: the shell fills its parent's height. */
function Framed() {
  return <div style={{ height: 320 }}><NotificationsPage /></div>;
}

export const guidance: ShowcaseGuidance = {
  purpose: "The settings layout: navigation master, detail header and detail pane, single-pane on compact widths.",
  whenToUse: ["The settings screen and settings-like editors"],
  whenNotToUse: [
    { when: "A management page (automations, dashboards)", use: "ManagementPage" },
    { when: "A setup flow", use: "SetupWizardShell" },
  ],
  recipes: [
    { name: "Settings page in the shell", description: "pageTitle and pageDescription let sections drop a description that repeats the page; a section title that repeats the page title throws in dev builds.", render: () => <Framed /> },
    { name: "Page copy for sections outside the shell", description: "SettingsPageProvider supplies the page copy when sections render on their own.", render: () => <SectionWithPageCopy /> },
  ],
  doDont: [
    {
      do: { caption: "Section headers sit above cards and name what the card holds; a description that repeats the page is dropped.", render: () => <SectionWithPageCopy /> },
      dont: { caption: "A card titled like the page it is on repeats itself.", render: () => <FormSection title="General" description="General"><SettingsField id="x" label="Smart groups" control={<Switch id="x" />} /></FormSection> },
    },
  ],
  content: [
    "Page titles are single nouns (General, Models); descriptions say what the page configures.",
    "In AdaptiveShell frame=\"cards\" (docked) the nav sits on the shell, so its rows take the shell's fills (--sidebar-hover-bg / --sidebar-selected-bg, see NavRow); other layouts keep the shades.",
  ],
  accessibility: ["The navigation is a nav landmark; compact mode keeps a back button in the detail header."],
  tokens: ["--settings-bg", "--sidebar-hover-bg", "--sidebar-selected-bg", "--settings-section-gap", "--settings-section-header-gap", "--page-max-width-reading"],
};
