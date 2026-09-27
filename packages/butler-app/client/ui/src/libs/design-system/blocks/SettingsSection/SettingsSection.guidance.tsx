import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { Input } from "../../components/Input";
import { Switch } from "../../components/Switch";
import { Typo } from "../../components/Typo";
import { EmptyLine } from "../EmptyLine";
import { KeyValueRow } from "../KeyValueRow";
import { SettingsField } from "../SettingsField";
import { SettingsPage } from "./SettingsPage";
import { SettingsSection } from "./SettingsSection";

// #region recipe: Settings page of sections
function GeneralPage() {
  return (
    <SettingsPage>
      <SettingsSection id="language-region" kind="form" title="Language & region">
        <SettingsField id="g-language" settingId="language" label="Language" control={<Input id="g-language" defaultValue="English" />} />
        <SettingsField id="g-timezone" settingId="timezone" label="Time zone" control={<Input id="g-timezone" defaultValue="Asia/Seoul" />} />
      </SettingsSection>
      <SettingsSection id="notifications" kind="form" title="Notifications">
        <SettingsField id="g-replies" settingId="replies" label="New replies" control={<Switch id="g-replies" defaultChecked />} />
      </SettingsSection>
    </SettingsPage>
  );
}
// #endregion

// #region recipe: Section fetch states
function FetchedSections() {
  return (
    <SettingsPage labels={{ loading: "Loading updates", retry: "Retry" }}>
      <SettingsSection id="updates" kind="list" title="Updates" actions={<Button size="sm" variant="outline">Check for updates</Button>}>
        <KeyValueRow label="App" value="Up to date" />
      </SettingsSection>
      <SettingsSection id="servers" kind="list" title="MCP servers" state="loading" />
      <SettingsSection id="usage" kind="status" title="Usage" state="error" onRetry={() => undefined} />
      <SettingsSection id="archive" kind="list" title="Archived" state="empty" emptyMessage="No archived conversations." />
    </SettingsPage>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The structure of a settings page: SettingsPage holds only SettingsSections, each one header above one card that owns its loading, error and empty states.",
  whenToUse: [
    "Every settings page and settings subpage",
    "A settings list that loads, can fail or can be empty (kind list or status)",
    "Read-only app information (kind info with KeyValueRow)",
  ],
  whenNotToUse: [
    { when: "A titled form outside the settings window", use: "FormSection" },
    { when: "A form inside a dialog", use: "DialogForm" },
    { when: "A standalone panel with its own action", use: "SurfacePanel" },
  ],
  recipes: [
    { name: "Settings page of sections", description: "Pick kind by content; SettingsField only ever renders inside a section.", render: () => <GeneralPage /> },
    { name: "Section fetch states", description: "Map the fetch result to state; the section draws skeleton rows, a Notice with Retry or an EmptyLine.", render: () => <FetchedSections /> },
  ],
  doDont: [
    {
      do: { caption: "Let the section own loading: skeleton rows shaped like its kind.", render: () => <SettingsPage><SettingsSection id="d-servers" kind="list" title="MCP servers" state="loading" /></SettingsPage> },
      dont: {
        caption: "An empty message while the list is still loading reads as \"you have none\".",
        render: () => <SettingsPage><SettingsSection id="d-servers-2" kind="list" title="MCP servers"><EmptyLine message="No MCP servers yet." /></SettingsSection></SettingsPage>,
      },
    },
    {
      do: { caption: "Section titles are distinct nouns below the page title.", render: () => <GeneralPage /> },
      dont: {
        caption: "Loose headings between cards break the page into floating fragments.",
        render: () => <><Typo.PanelTitle>General</Typo.PanelTitle><SettingsPage><SettingsSection id="d-general" kind="form"><SettingsField id="d-lang" label="Language" control={<Input id="d-lang" defaultValue="English" />} /></SettingsSection></SettingsPage></>,
      },
    },
  ],
  content: [
    "Section titles are nouns (Notifications, Language & region); omit the title when it would repeat the page title.",
    "State copy comes from SettingsPage labels (Loading, Could not load this section., Retry); override per section only with emptyMessage or errorMessage.",
  ],
  accessibility: [
    "Each section is a section element labelled by its title heading.",
    "Loading sets aria-busy on the section and the skeleton group carries the loading label.",
    "The error state renders with role=\"alert\" and a real Retry button.",
  ],
  tokens: ["--settings-section-gap", "--settings-section-header-gap", "--settings-section-padding", "--settings-panel-bg", "--settings-bg", "--line"],
  internalExports: {
    SettingsSectionLabelsProvider: "SettingsPage applies it from its labels prop; pages never render it directly.",
  },
};
