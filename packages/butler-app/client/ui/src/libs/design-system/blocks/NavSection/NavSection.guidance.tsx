import type { ShowcaseGuidance } from "../../showcase";
import { IconButton } from "../../components/IconButton";
import { Folder, FolderPlus } from "../../components/Icons";
import { Section } from "../../components/Section";
import { NavRow } from "../NavRow";
import { NavSection } from "./NavSection";

// #region recipe: Projects section
function ProjectsSection() {
  return (
    <NavSection title="Projects" actions={<IconButton label="New project"><FolderPlus size="md" /></IconButton>}>
      <NavRow icon={<Folder size="md" />} label="butler" active onClick={() => undefined} />
      <NavRow icon={<Folder size="md" />} label="butler-site" onClick={() => undefined} />
    </NavSection>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A titled group of navigation rows with optional heading actions.",
  whenToUse: ["Group rows under a heading in the sidebar or settings navigation"],
  whenNotToUse: [
    { when: "A titled region of page content", use: "Section" },
    { when: "A folder that expands and collapses", use: "CollapsibleNavGroup" },
  ],
  recipes: [{ name: "Projects section", description: "Heading actions (new project) sit on the title row.", render: () => <ProjectsSection /> }],
  doDont: [
    {
      do: { caption: "NavSection keeps the sidebar heading voice.", render: () => <ProjectsSection /> },
      dont: { caption: "A page Section in navigation uses the wrong title scale.", render: () => <Section title="Projects"><NavRow label="butler" /></Section> },
    },
  ],
  content: ["Short plural nouns: Projects, Chats, Favorites."],
  accessibility: ["The heading labels the group; NavSectionHeading alone works over custom content."],
  tokens: ["--typo-section-title-size", "--text-tertiary", "--space-sm"],
};
