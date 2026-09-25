import { Briefcase, Folder, LayoutDashboard, MessageSquare, Notebook } from "./Icons";
import { Stack } from "../Stack";
import { IconButton } from "../IconButton";

export function IconsFixture() {
  return <Stack gap="sm" data-ds-fixture="icons">
    <Stack align="row" gap="sm">
      <Briefcase size="md" /><Folder size="md" /><MessageSquare size="md" /><Notebook size="md" />
    </Stack>
    <IconButton label="Dashboard"><LayoutDashboard size="md" /></IconButton>
  </Stack>;
}
