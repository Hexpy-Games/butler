import { ArtifactPreview, ArtifactPreviewPre } from "./ArtifactPreview";

export function ArtifactPreviewFixture() {
  return (
    <ArtifactPreview>
      <ArtifactPreviewPre>
        {"# Preview\n\nArtifact content appears here."}
      </ArtifactPreviewPre>
    </ArtifactPreview>
  );
}
