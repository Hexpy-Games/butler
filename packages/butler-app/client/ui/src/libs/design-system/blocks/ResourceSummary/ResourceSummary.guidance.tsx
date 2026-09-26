import type { ShowcaseGuidance } from "../../showcase";
import { FileText } from "../../components/Icons";
import { ListRow } from "../ListRow";
import { ResourceSummary } from "./ResourceSummary";

// #region recipe: Document summary
function SpecSummary() {
  return <ResourceSummary icon={<FileText size="xl" />} title="Design-system spec" description="Tokens, components, blocks and the DS Viewer contract." meta="Updated today" />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A large-icon summary of one resource: title, description and meta.",
  whenToUse: ["Introduce a resource at the top of a card or detail view"],
  whenNotToUse: [
    { when: "A row in a list", use: "ListRow" },
    { when: "A tile in a grid", use: "ResourceTile" },
  ],
  recipes: [{ name: "Document summary", description: "Use the xl icon size; meta is a date or state.", render: () => <SpecSummary /> }],
  doDont: [
    {
      do: { caption: "One resource, introduced with room.", render: () => <SpecSummary /> },
      dont: { caption: "A list row cannot carry the description.", render: () => <ListRow icon={<FileText size="md" />} title="Design-system spec" meta="Updated today" /> },
    },
  ],
  content: ["Description in one or two sentences."],
  accessibility: ["The icon is decorative; the title names the resource."],
  tokens: ["--icon-size-xl", "--text-secondary", "--space-md"],
};
