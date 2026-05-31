import { useState } from "react";
import { SidebarSection } from "@/components/layout/SidebarSection.tsx";
import { SidebarProjectGroup } from "@/components/layout/SidebarProjectGroup.tsx";
import { SidebarProjectsMenu } from "@/components/layout/SidebarProjectsMenu.tsx";
import { useSidebarProjectCollapse } from "@/components/layout/useSidebarProjectCollapse.ts";
import { canSelectProjectFolder } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { appThemeClasses } from "@/app/utils.ts";
import { useButlerStore } from "@/app/store.ts";

export function SidebarProjectsSection() {
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const collapse = useSidebarProjectCollapse();
  const navigation = useButlerStore((state) => state.navigation);
  const creatingProject = useButlerStore((state) => state.creatingProject);
  const createScratchProject = useButlerStore(
    (state) => state.createScratchProject,
  );
  const createProjectFromExistingFolder = useButlerStore(
    (state) => state.createProjectFromExistingFolder,
  );
  const settings = useButlerStore((state) => state.settings);
  const projects = navigation.projects ?? [];

  function runProjectCreator(action: () => void) {
    setProjectMenuOpen(false);
    action();
  }

  return (
    <SidebarSection
      title={appCopy.sidebar.projects}
      actions={
        <SidebarProjectsMenu
          creatingProject={creatingProject}
          folderPickerAvailable={canSelectProjectFolder()}
          popoverThemeClass={appThemeClasses(settings)}
          projectMenuOpen={projectMenuOpen}
          projectsCollapsed={collapse.projectsCollapsed}
          onCreateScratch={() =>
            runProjectCreator(createScratchProject)
          }
          onMenuOpenChange={setProjectMenuOpen}
          onToggleCollapse={() => collapse.handleProjectsSectionToggle(projects)}
          onUseExistingFolder={() =>
            runProjectCreator(createProjectFromExistingFolder)
          }
        />
      }
    >
      {projects.map((project) => (
        <SidebarProjectGroup
          collapsed={collapse.projectsCollapsed}
          key={project.id}
          project={project}
          projectRowCollapsed={collapse.collapsedProjectIds.has(project.id)}
          onToggleCollapse={() => collapse.toggleProjectCollapse(project.id)}
        />
      ))}
    </SidebarSection>
  );
}
