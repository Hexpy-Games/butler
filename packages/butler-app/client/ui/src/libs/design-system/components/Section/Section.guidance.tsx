import type { ShowcaseGuidance } from "../../showcase";
import { ListRow } from "../../blocks/ListRow";
import { IconButton } from "../IconButton";
import { FileText, Plus } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Section } from "./Section";

// #region recipe: Inspector section with an action
function ArtifactsSection() {
  return (
    <Section title="Artifacts" gap="md" actions={<IconButton label="Add artifact"><Plus size="md" /></IconButton>}>
      <ListRow icon={<FileText size="md" />} title="release-notes.md" />
      <ListRow icon={<FileText size="md" />} title="design-review.png" />
    </Section>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A titled region: title (with optional icon and actions), description and content with a token gap.",
  whenToUse: ["A titled group inside an inspector or dashboard panel", "A page region with its own heading level"],
  whenNotToUse: [
    { when: "A settings section whose header sits above a card", use: "FormSection" },
    { when: "A panel with a surface and header", use: "InspectorPanel" },
    { when: "A sidebar group", use: "NavSection" },
  ],
  recipes: [{ name: "Inspector section with an action", description: "Actions align to the title row; content gap is a token step.", render: () => <ArtifactsSection /> }],
  doDont: [
    {
      do: { caption: "Section renders the heading with the right level (titleAs).", render: () => <ArtifactsSection /> },
      dont: { caption: "A bold Body line is not a heading for assistive technology.", render: () => <Stack gap="md"><Typo.Body weight="semibold">Artifacts</Typo.Body><ListRow title="release-notes.md" /></Stack> },
    },
  ],
  content: ["Titles are nouns (Artifacts, Automations); descriptions one sentence."],
  accessibility: ["Pick titleAs for the document outline (h2 on pages, h3 in panels)."],
  tokens: ["--typo-panel-section-title-size", "--space-md", "--space-lg"],
};
