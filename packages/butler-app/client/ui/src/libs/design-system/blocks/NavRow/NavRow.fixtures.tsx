import { NavRow } from "./NavRow";
import { Stack } from "../../components/Stack";
import { Folder, Settings, Plus } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";

export function NavRowFixture() {
  return (
    <Stack gap="2" style={{ width: "100%" }}>
      <NavRow
        icon={<Folder size={17} />}
        label="Project Alpha"
        onClick={() => undefined}
      />
      <NavRow
        icon={<Folder size={17} />}
        label="Active Project"
        active
        onClick={() => undefined}
      />
      <NavRow
        icon={<Settings size={17} />}
        label="Settings with a very long navigation label that should truncate before it reaches the control region"
        badge="3"
      />
      <NavRow
        icon={<Folder size={17} />}
        label="With action"
        onClick={() => undefined}
        actions={
          <IconButton label="Add"><Plus size={14} /></IconButton>
        }
        actionsVisibility="hover"
      />
      <NavRow
        icon={<Folder size={17} />}
        label="Disabled state"
        disabled
      />
    </Stack>
  );
}
