import { ResourceTile } from "./ResourceTile";
import { Grid } from "../../components/Grid";
import { Folder, FileText } from "../../components/Icons";

export function ResourceTileFixture() {
  return (
    <Grid gap="sm" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
      <ResourceTile
        icon={<Folder size="xl" />}
        title="Project Alpha"
        meta="12 sessions"
        description="AI assistant project"
      />
      <ResourceTile
        icon={<FileText size="xl" />}
        title="Documentation"
        meta="Updated today"
      />
    </Grid>
  );
}
