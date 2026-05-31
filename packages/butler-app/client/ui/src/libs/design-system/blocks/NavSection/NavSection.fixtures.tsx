import { NavSection } from "./NavSection";
import { NavRow } from "../NavRow";
import { Folder, Plus } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";

export function NavSectionFixture() {
  return (
    <NavSection
      title="Projects"
      actions={
        <IconButton label="New project"><Plus size={14} /></IconButton>
      }
    >
      <NavRow icon={<Folder size={17} />} label="Project Alpha" />
      <NavRow icon={<Folder size={17} />} label="Project Beta" active />
      <NavRow icon={<Folder size={17} />} label="Project Gamma" />
    </NavSection>
  );
}
