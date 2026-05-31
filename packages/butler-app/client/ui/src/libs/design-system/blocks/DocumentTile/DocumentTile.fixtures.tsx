import { BookOpenText } from "../../components/Icons";
import { DocumentTile } from "./DocumentTile";

export function DocumentTileFixture() {
  return (
    <DocumentTile
      badge="Spec"
      icon={<BookOpenText size={16} />}
      title="Architecture notes"
      description="Project Ledger document"
      meta="Updated 1h ago"
      clickTarget="tile"
      onOpen={() => undefined}
      actions={[
        { id: "save", label: "Save", href: "#", download: "notes.md" },
      ]}
    />
  );
}
