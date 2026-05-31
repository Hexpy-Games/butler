import { ListRow } from "./ListRow";
import { Stack } from "../../components/Stack";
import { FileText } from "../../components/Icons";

export function ListRowFixture() {
  return (
    <Stack gap="2">
      <ListRow
        icon={<FileText size={16} />}
        title="Document Title"
        meta="2.4 KB"
      />
      <ListRow
        icon={<FileText size={16} />}
        title="Long document name that should truncate properly when space is limited"
        meta="Updated 2h ago"
        description="Brief description or preview text"
      />
    </Stack>
  );
}
