import { NavSection } from "./NavSection";
import { NavRow } from "../NavRow";
import { Folder, Plus } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";

export function NavSectionFixture() {
  return (
    <NavSection
      title="Projects"
      actions={
        <IconButton label="New project"><Plus size="sm" /></IconButton>
      }
    >
      <NavRow icon={<Folder size="md" />} label="Project Alpha" />
      <NavRow icon={<Folder size="md" />} label="Project Beta" active />
      <NavRow icon={<Folder size="md" />} label="Project Gamma" />
    </NavSection>
  );
}
