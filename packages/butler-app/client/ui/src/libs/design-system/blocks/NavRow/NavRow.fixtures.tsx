import { NavRow } from "./NavRow";
import { Stack } from "../../components/Stack";
import { Folder, Settings, Plus } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";

export function NavRowFixture() {
  return (
    <Stack gap="sm" style={{ width: "100%" }}>
      <NavRow
        icon={<Folder size="md" />}
        label="Project Alpha"
        onClick={() => undefined}
      />
      <NavRow
        icon={<Folder size="md" />}
        label="Active Project"
        active
        onClick={() => undefined}
      />
      <NavRow
        icon={<Settings size="md" />}
        label="Settings with a very long navigation label that should truncate before it reaches the control region"
        badge="3"
      />
      <NavRow
        icon={<Folder size="md" />}
        label="With action"
        onClick={() => undefined}
        actions={
          <IconButton label="Add">
            <Plus size="sm" />
          </IconButton>
        }
        actionsVisibility="hover"
      />
      <NavRow icon={<Folder size="md" />} label="Disabled state" disabled />
      <NavRow
        multiline
        icon={<Folder size="md" />}
        label="Recent conversation"
        meta={<span>Project / conversation context · 3 minutes ago</span>}
        actions={<IconButton label="Add"><Plus size="sm" /></IconButton>}
        onClick={() => undefined}
      />
      <NavRow
        multiline
        icon={<Folder size="md" />}
        label={
          <>
            Multi-line navigation title
            <br />
            Project / conversation context
          </>
        }
        onClick={() => undefined}
      />
    </Stack>
  );
}
