import { ResourceTile } from "./ResourceTile";
import { Grid } from "../../components/Grid";
import { Folder, FileText } from "../../components/Icons";

export function ResourceTileFixture() {
  return (
    <Grid gap="2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
      <ResourceTile
        icon={<Folder size={24} />}
        title="Project Alpha"
        meta="12 sessions"
        description="AI assistant project"
      />
      <ResourceTile
        icon={<FileText size={24} />}
        title="Documentation"
        meta="Updated today"
      />
    </Grid>
  );
}
