import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { Archive, Folder, FolderPlus, Monitor, MoreHorizontal, PencilLine, Terminal, Trash2 } from "../Icons";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./DropdownMenu";

export const meta: ShowcaseMeta = {
  title: "DropdownMenu",
  category: "Overlay",
  tags: ["menu", "command", "titlebar", "glass", "motion"],
  status: "stable",
};

const labels = {
  "en-US": {
    actions: "Session actions", rename: "Rename", openIn: "Open folder in", vscode: "VS Code", terminal: "Terminal",
    archive: "Archive", remove: "Delete", newProject: "New project", scratch: "Start from scratch", existing: "Open a folder",
    view: "View", density: "Sidebar density", compact: "Compact", comfortable: "Comfortable", showArchived: "Show archived",
    loading: "Looking for editors…", tags: "Tags", tagged: [["jeju", true], ["cafés", "indeterminate"], ["family", false]] as const,
  },
  "ko-KR": {
    actions: "세션 작업", rename: "이름 바꾸기", openIn: "다음에서 폴더 열기", vscode: "VS Code", terminal: "터미널",
    archive: "보관", remove: "삭제", newProject: "새 프로젝트", scratch: "처음부터 시작", existing: "폴더 열기",
    view: "보기", density: "사이드바 밀도", compact: "촘촘하게", comfortable: "여유 있게", showArchived: "보관된 항목 보기",
    loading: "편집기를 찾는 중…", tags: "태그", tagged: [["제주", true], ["카페", "indeterminate"], ["가족", false]] as const,
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** Titlebar session menu: grouped items, a submenu and a destructive item. */
function SessionMenu({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={copy.actions} aria-haspopup="menu"><MoreHorizontal size="md" /></IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8}>
        <DropdownMenuGroup>
          <DropdownMenuItem><PencilLine size="sm" /> {copy.rename}<DropdownMenuShortcut>⌘R</DropdownMenuShortcut></DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger><Folder size="sm" /> {copy.openIn}</DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent>
                <DropdownMenuItem><Monitor size="sm" /> {copy.vscode}</DropdownMenuItem>
                <DropdownMenuItem><Terminal size="sm" /> {copy.terminal}</DropdownMenuItem>
                <DropdownMenuItem disabled>{copy.loading}</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
          <DropdownMenuItem><Archive size="sm" /> {copy.archive}</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive"><Trash2 size="sm" /> {copy.remove}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ViewMenu({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  const [density, setDensity] = useState("comfortable");
  const [archived, setArchived] = useState(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="outline" size="sm" text={copy.view} /></DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{copy.density}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={density} onValueChange={setDensity}>
          <DropdownMenuRadioItem value="compact">{copy.compact}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="comfortable">{copy.comfortable}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={archived} onCheckedChange={setArchived}>{copy.showArchived}</DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Bulk tags for three selected items: on all (✓), on some (−), on none. */
function BulkTagMenu({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="outline" size="sm" text={copy.tags} /></DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {copy.tagged.map(([name, checked]) => <DropdownMenuCheckboxItem key={name} checked={checked}>{name}</DropdownMenuCheckboxItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Session actions", states: ["open", "disabled"], render: (context) => <SessionMenu context={context} /> },
  {
    name: "New project menu",
    render: (context) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label={text(context).newProject} aria-haspopup="menu"><FolderPlus size="md" /></IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8}>
          <DropdownMenuGroup>
            <DropdownMenuItem>{text(context).scratch}</DropdownMenuItem>
            <DropdownMenuItem>{text(context).existing}</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  },
  { name: "Radio and checkbox items", render: (context) => <ViewMenu context={context} /> },
  { name: "Checkbox items: all, some (indeterminate), none", render: (context) => <BulkTagMenu context={context} /> },
  {
    // presentation="auto": a BottomSheet below 768px, the anchored menu above.
    name: "Bottom sheet on phones (presentation=\"auto\")",
    widths: ["375", "app"],
    render: (context) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild><IconButton label={text(context).newProject} aria-haspopup="menu"><FolderPlus size="md" /></IconButton></DropdownMenuTrigger>
        <DropdownMenuContent presentation="auto">
          <DropdownMenuItem>{text(context).scratch}</DropdownMenuItem>
          <DropdownMenuItem>{text(context).existing}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  },
];
