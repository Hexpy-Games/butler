import { useAppLocale } from "@/app/copy.ts";
import { Collapse, Expand, FolderPlus } from "@/butler-ds";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/butler-ds";
import { IconButton, type AdaptiveShellTheme } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";

interface SidebarProjectsMenuProps {
  projectsCollapsed: boolean;
  projectMenuOpen: boolean;
  creatingProject: boolean;
  folderPickerAvailable: boolean;
  popoverTheme: AdaptiveShellTheme;
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
  popoverTheme,
  onToggleCollapse,
  onMenuOpenChange,
  onCreateScratch,
  onUseExistingFolder,
}: SidebarProjectsMenuProps) {
  useAppLocale();
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
        {projectsCollapsed ? <Expand size="md" /> : <Collapse size="md" />}
      </IconButton>
      <DropdownMenu
        key="new"
        open={projectMenuOpen}
        onOpenChange={onMenuOpenChange}
      >
        <DropdownMenuTrigger asChild>
          <IconButton label={sidebarCopy.newProject} selected={projectMenuOpen}>
            <FolderPlus size="md" />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          theme={popoverTheme}
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
