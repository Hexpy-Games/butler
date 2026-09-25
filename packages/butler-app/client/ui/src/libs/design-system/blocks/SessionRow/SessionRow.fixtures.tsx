import { IconButton } from "../../components/IconButton";
import { MoreHorizontal, Notebook } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { SessionRow } from "./SessionRow";

const menu = <IconButton label="Session menu"><MoreHorizontal size="md" /></IconButton>;

/** Sidebar session rows: tree rows (one line) and flat Recent/Running rows (two lines). */
export function SessionRowFixture() {
  return (
    <Stack gap="xs" style={{ width: 280 }}>
      <SessionRow active icon={<Notebook />} title="Design-system expansion" actions={menu} onSelect={() => undefined} />
      <SessionRow icon={<Notebook />} title="A much longer session title that truncates in the tree" actions={menu} onSelect={() => undefined} />
      <SessionRow
        title="Release checklist review for the desktop client"
        description="Desktop client polish"
        meta="5 min ago"
        actions={menu}
        onSelect={() => undefined}
      />
    </Stack>
  );
}
