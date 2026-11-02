import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Plus } from "../../components/Icons";
import { Input } from "../../components/Input";
import { Switch } from "../../components/Switch";
import { Typo } from "../../components/Typo";
import { CardList, CardListItem } from "../CardList";
import { EmptyLine } from "../EmptyLine";
import { KeyValueRow } from "../KeyValueRow";
import { SettingsActionField } from "../SettingsActionField";
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

// #region recipe: List section with header actions and a more row
function ServersPage() {
  return (
    <SettingsPage>
      <SettingsSection id="servers" kind="list" title="Servers"
        actions={<Button size="sm" variant="outline"><Plus size="md" />Add server</Button>}
        more={{ label: "More", onClick: () => undefined }}>
        <CardList>
          <CardListItem title="filesystem" description="stdio · 12 tools" meta="On" />
          <CardListItem title="github" description="http · 31 tools" meta="On" />
        </CardList>
      </SettingsSection>
    </SettingsPage>
  );
}
// #endregion

// #region recipe: Section action rows
function ProfileMemory() {
  return (
    <SettingsPage>
      <SettingsSection id="profile-memory" kind="form" title="Profile">
        <SettingsActionField id="p-reset" label="Reset profile" description="Erases what Butler learned about you. This can't be undone."
          action={<Button id="p-reset" size="sm" variant="outline">Reset</Button>} />
      </SettingsSection>
    </SettingsPage>
  );
}
// #endregion

// #region recipe: Section fetch states
function FetchedSections() {
  return (
    <SettingsPage labels={{ loading: "Loading updates", retry: "Retry" }}>
      <SettingsSection id="updates" kind="list" title="Versions" actions={<Button size="sm" variant="outline">Check for updates</Button>}>
        <KeyValueRow label="App" value="Up to date" />
      </SettingsSection>
      <SettingsSection id="servers" kind="list" title="Servers" state="loading" />
      <SettingsSection id="usage" kind="status" title="Usage" state="error" onRetry={() => undefined} />
      <SettingsSection id="archive" kind="list" title="Archived items" state="empty" emptyMessage="No archived conversations." />
    </SettingsPage>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The structure of a settings page: SettingsPage holds only SettingsSections, each one titled header (actions on its right) above one card that owns its loading, error and empty states.",
  whenToUse: [
    "Every settings page and settings subpage",
    "A settings list that loads, can fail, can be empty or loads more (kind list or status)",
    "Read-only app information (kind info with KeyValueRow)",
  ],
  whenNotToUse: [
    { when: "A titled form outside the settings window", use: "FormSection" },
    { when: "A form inside a dialog", use: "DialogForm" },
    { when: "A standalone panel with its own action", use: "SurfacePanel" },
  ],
  recipes: [
    { name: "Settings page of sections", description: "Every section has a title; pick kind by content; SettingsField only ever renders inside a section.", render: () => <GeneralPage /> },
    { name: "List section with header actions and a more row", description: "Add, refresh, filter and period go in the header, outline and small; rows sit flush in the card; more is the DS-owned last row.", render: () => <ServersPage /> },
    { name: "Section action rows", description: "Reset, clear and free-up-space are SettingsActionField rows in the card, not header buttons.", render: () => <ProfileMemory /> },
    { name: "Section fetch states", description: "Map the fetch result to state; the section draws skeleton rows, a Notice with Retry or an EmptyLine. Header actions stay visible in every state.", render: () => <FetchedSections /> },
  ],
  doDont: [
    {
      do: { caption: "Let the section own loading: skeleton rows shaped like its kind.", render: () => <SettingsPage><SettingsSection id="d-servers" kind="list" title="Servers" state="loading" /></SettingsPage> },
      dont: {
        caption: "An empty message while the list is still loading reads as \"you have none\".",
        render: () => <SettingsPage><SettingsSection id="d-servers-2" kind="list" title="Servers"><EmptyLine message="No MCP servers yet." /></SettingsSection></SettingsPage>,
      },
    },
    {
      do: { caption: "An action is a row in the card that says what it removes.", render: () => <ProfileMemory /> },
      dont: {
        caption: "A reset button beside the title: header actions are add, refresh, filter and period on list and status sections.",
        render: () => <SettingsPage><SettingsSection id="d-profile" kind="form" title="Profile" actions={<Button size="sm" variant="outline">Reset</Button>}><KeyValueRow label="Entries" value="12" /></SettingsSection></SettingsPage>,
      },
    },
    {
      do: { caption: "A titled header names the list; its add button sits on the right.", render: () => <ServersPage /> },
      dont: {
        caption: "A toolbar with no title reads as a page-level button.",
        render: () => <div><Button size="sm"><Plus size="md" />Add server</Button><Card padding="md"><Typo.Body>filesystem</Typo.Body></Card></div>,
      },
    },
    {
      do: { caption: "List rows sit flush in the section card, divided by hairlines.", render: () => <ServersPage /> },
      dont: {
        caption: "Bordered cards nested inside the section card double every edge.",
        render: () => <Card padding="md"><Card padding="md"><Typo.Body>filesystem</Typo.Body></Card></Card>,
      },
    },
  ],
  content: [
    "Every section has a title: a short noun for what the card holds (Notifications, Servers, Your hooks), never the page title again.",
    "State copy comes from SettingsPage labels (Loading, Could not load this section., Retry); override per section only with emptyMessage or errorMessage. An empty list says so in one short line.",
    "The page header shows only the page title and description; the sticky footer is only for pages that save explicitly.",
  ],
  accessibility: [
    "Each section is a section element labelled by its title heading.",
    "Loading sets aria-busy on the section and the skeleton group carries the loading label.",
    "The error state renders with role=\"alert\" and a real Retry button.",
    "The more row is a real button at the end of the list, after the rows it extends.",
  ],
  tokens: ["--settings-section-gap", "--settings-section-header-gap", "--settings-section-padding", "--settings-panel-bg", "--settings-bg", "--line"],
  internalExports: {
    SettingsSectionLabelsProvider: "SettingsPage applies it from its labels prop; pages never render it directly.",
  },
};
