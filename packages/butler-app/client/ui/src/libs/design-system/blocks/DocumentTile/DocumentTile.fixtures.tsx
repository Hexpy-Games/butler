import { FileText, Save } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { DocumentTile } from "./DocumentTile";

/** The product uses: inspector artifacts (whole tile opens) and dashboard plan / spec lists. */
export function DocumentTileFixture() {
  return (
    <Stack gap="lg">
      <Stack gap="xs" style={{ maxWidth: 360 }}>
        <Typo.Caption>Inspector artifact (tile opens, icon action)</Typo.Caption>
        <DocumentTile
          icon={<FileText size="md" />}
          title="butler-dedicated-client-composer.md"
          description="document / 7.6 KB"
          meta="2d ago"
          clickTarget="tile"
          ariaLabel="Open: butler-dedicated-client-composer.md"
          onOpen={() => undefined}
          actions={[{ id: "save", label: "Save", icon: <Save size="sm" />, onClick: () => undefined }]}
        />
      </Stack>
      <Stack gap="xs" style={{ maxWidth: 360 }}>
        <Typo.Caption>Dashboard plan lane and spec list (Open action)</Typo.Caption>
        <DocumentTile
          badge="Plan"
          icon={<FileText size="md" />}
          title="OAuth connection and model presets rollout plan"
          meta="In review"
          actionLabel="Open"
          onOpen={() => undefined}
        />
        <DocumentTile
          icon={<FileText size="md" />}
          title="Model presets and OAuth"
          meta="specs/model-presets-and-oauth.md"
          actionLabel="Open"
          onOpen={() => undefined}
        />
      </Stack>
    </Stack>
  );
}
