import type { ShowcaseGuidance } from "../../showcase";
import { Grid } from "../../components/Grid";
import { FileText, Folder } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ResourceTile } from "./ResourceTile";

// #region recipe: Resource tiles in a grid
function ResourceTiles() {
  return (
    <Grid columns="auto-fit" gap="sm">
      <ResourceTile icon={<Folder size="xl" />} title="butler" meta="12 conversations" description="Desktop app and agent gateway" />
      <ResourceTile icon={<FileText size="xl" />} title="Design-system spec" meta="Updated today" />
    </Grid>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A tile for one resource (project, document) in a grid: icon, title, meta and a short description.",
  whenToUse: ["A grid of resources to choose from"],
  whenNotToUse: [
    { when: "Documents with open/save actions", use: "DocumentTile" },
    { when: "Interactive work items", use: "Card" },
  ],
  recipes: [{ name: "Resource tiles in a grid", description: "Place tiles in Grid auto-fit; keep descriptions to one line.", render: () => <ResourceTiles /> }],
  doDont: [
    {
      do: { caption: "Tiles in a grid with consistent heights.", render: () => <ResourceTiles /> },
      dont: { caption: "Loose text blocks lose the tile silhouette.", render: () => <Stack gap="xs"><Typo.Body>butler</Typo.Body><Typo.Caption>12 conversations</Typo.Caption></Stack> },
    },
  ],
  content: ["Meta is a count or a date; description one line."],
  accessibility: ["Tiles are presentational; wrap in Clickable or pass an action for interaction."],
  tokens: ["--surface-raised", "--radius-panel", "--icon-size-xl"],
};
