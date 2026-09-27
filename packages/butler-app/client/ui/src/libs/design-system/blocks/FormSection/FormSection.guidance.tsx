import type { ShowcaseGuidance } from "../../showcase";
import { Input } from "../../components/Input";
import { Switch } from "../../components/Switch";
import { Typo } from "../../components/Typo";
import { SettingsField, SettingsFieldScopeProvider } from "../SettingsField";
import { SurfacePanel } from "../SurfacePanel";
import { FormSection } from "./FormSection";

// #region recipe: Settings section
function SearchSection() {
  return (
    <FormSection title="Search" description="Web search providers and pre-search planning.">
      <SettingsField id="provider" label="Search provider" control={<Input id="provider" defaultValue="Tavily" />} />
      <SettingsField id="planning" label="Plan before searching" control={<Switch id="planning" defaultChecked />} />
    </FormSection>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A settings section: header (title, description) above its card, fields inside following the settings ramp.",
  whenToUse: ["Group related settings on a settings page"],
  whenNotToUse: [
    { when: "A titled region in a panel", use: "Section" },
    { when: "One row with an action", use: "SurfacePanel" },
  ],
  recipes: [{ name: "Settings section", description: "The header sits outside the card; fields use SettingsField.", render: () => <SearchSection /> }],
  doDont: [
    {
      do: { caption: "Header above, card below, tight between them.", render: () => <SearchSection /> },
      dont: { caption: "A title inside the card blurs where sections start.", render: () => <SettingsFieldScopeProvider><SurfacePanel><Typo.PanelTitle>Search</Typo.PanelTitle><SettingsField id="p2" label="Search provider" control={<Input id="p2" defaultValue="Tavily" />} /></SurfacePanel></SettingsFieldScopeProvider> },
    },
  ],
  content: ["Section titles are nouns; descriptions one sentence, never repeating the page description."],
  accessibility: ["The title is a heading for the section; the card is not a separate landmark."],
  tokens: ["--settings-section-header-gap", "--settings-section-padding", "--settings-field-gap", "--settings-section-gap"],
};
