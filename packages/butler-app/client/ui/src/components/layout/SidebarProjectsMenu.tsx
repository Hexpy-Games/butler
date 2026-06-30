import { Collapse, Expand, FolderPlus } from "@/butler-ds";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/butler-ds";
import { IconButton } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";

interface SidebarProjectsMenuProps {
  projectsCollapsed: boolean;
  projectMenuOpen: boolean;
  creatingProject: boolean;
  folderPickerAvailable: boolean;
  popoverThemeClass: string;
  onToggleCollapse: () => void;
  onMenuOpenChange: (open: boolean) => void;
  onCreateScratch: () => void;
  onUseExistingFolder: () => void;
}

export function SidebarProjectsMenu({
  projectsCollapsed,
  projectMenuOpen,
  creatingProject,
  folderPickerAvailable,
  popoverThemeClass,
  onToggleCollapse,
  onMenuOpenChange,
  onCreateScratch,
  onUseExistingFolder,
}: SidebarProjectsMenuProps) {
  const sidebarCopy = appCopy.sidebar;

  return (
    <>
      <IconButton
        key="collapse"
        label={
          projectsCollapsed
            ? sidebarCopy.expandProjects
            : sidebarCopy.collapseProjects
        }
        onClick={onToggleCollapse}
      >
        {projectsCollapsed ? <Expand size={15} /> : <Collapse size={15} />}
      </IconButton>
      <DropdownMenu
        key="new"
        open={projectMenuOpen}
        onOpenChange={onMenuOpenChange}
      >
        <DropdownMenuTrigger asChild>
          <IconButton label={sidebarCopy.newProject} selected={projectMenuOpen}>
            <FolderPlus size={15} />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className={popoverThemeClass}
          align="end"
          onInteractOutside={() => onMenuOpenChange(false)}
          sideOffset={8}
        >
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={creatingProject}
              onSelect={onCreateScratch}
            >
              {sidebarCopy.startFromScratch}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={creatingProject || !folderPickerAvailable}
              title={
                folderPickerAvailable
                  ? undefined
                  : sidebarCopy.availableInDesktop
              }
              onSelect={onUseExistingFolder}
            >
              {sidebarCopy.useExistingFolder}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
