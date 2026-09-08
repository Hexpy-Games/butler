import { Briefcase, Folder, LayoutDashboard, MessageSquare, Notebook } from "./Icons";
import { Stack } from "../Stack";
import { IconButton } from "../IconButton";

export function IconsFixture() {
  return <Stack gap="2" data-ds-fixture="icons">
    <Stack align="row" gap="2">
      <Briefcase size={16} /><Folder size={16} /><MessageSquare size={16} /><Notebook size={16} />
    </Stack>
    <IconButton label="Dashboard"><LayoutDashboard size={16} /></IconButton>
  </Stack>;
}
