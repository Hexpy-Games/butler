import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { ButtonContainer } from "../ButtonContainer";
import {
  ArrowLeft,
  FolderPlus,
  LayoutDashboard,
  MessageSquarePlus,
  Minus,
  MoreHorizontal,
  PanelLeft,
  PanelRightClose,
  Pencil,
  Pin,
  Square,
  Trash2,
  X,
} from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { IconButton } from "./IconButton";

export const meta: ShowcaseMeta = {
  title: "IconButton",
  category: "Action",
  tags: ["action", "icon-only", "tooltip", "titlebar", "sidebar"],
  status: "stable",
};

const labels = {
  "en-US": {
    back: "Back", hideLeft: "Hide left panel", hideRight: "Hide right panel", minimize: "Minimize window",
    maximize: "Maximize window", close: "Close window", dashboard: "Project dashboard", newChat: "New chat in project",
    newProject: "New project", pin: "Pin", edit: "Edit description", remove: "Delete row", more: "Session actions",
    note: "Hover or focus a button: the label shows as a tooltip unless it opens a menu.",
  },
  "ko-KR": {
    back: "뒤로", hideLeft: "왼쪽 패널 숨기기", hideRight: "오른쪽 패널 숨기기", minimize: "창 최소화",
    maximize: "창 최대화", close: "창 닫기", dashboard: "프로젝트 대시보드", newChat: "프로젝트에서 새 채팅",
    newProject: "새 프로젝트", pin: "고정", edit: "설명 편집", remove: "행 삭제", more: "세션 작업",
    note: "버튼에 마우스를 올리거나 포커스하면 라벨이 툴팁으로 보입니다. 메뉴를 여는 버튼은 제외입니다.",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Titlebar and window controls",
    render: (context) => {
      const copy = text(context);
      return (
        <Stack gap="sm">
          <ButtonContainer size="sm">
            <IconButton label={copy.hideLeft} onClick={() => undefined}><PanelLeft size="md" /></IconButton>
            <IconButton label={copy.back} onClick={() => undefined}><ArrowLeft size="md" /></IconButton>
            <IconButton label={copy.hideRight} onClick={() => undefined}><PanelRightClose size="md" /></IconButton>
            <IconButton label={copy.minimize} onClick={() => undefined}><Minus size="md" /></IconButton>
            <IconButton label={copy.maximize} onClick={() => undefined}><Square size="md" /></IconButton>
            <IconButton label={copy.close} onClick={() => undefined}><X size="md" /></IconButton>
          </ButtonContainer>
          <Typo.Caption tone="secondary">{copy.note}</Typo.Caption>
        </Stack>
      );
    },
  },
  {
    name: "Row actions",
    render: (context) => {
      const copy = text(context);
      return (
        <ButtonContainer size="sm">
          <IconButton label={copy.dashboard} onClick={() => undefined}><LayoutDashboard size="md" /></IconButton>
          <IconButton label={copy.newChat} onClick={() => undefined}><MessageSquarePlus size="sm" /></IconButton>
          <IconButton label={copy.pin} onClick={() => undefined}><Pin /></IconButton>
          <IconButton label={copy.edit} onClick={() => undefined}><Pencil /></IconButton>
          <IconButton label={copy.remove} onClick={() => undefined}><Trash2 size="md" /></IconButton>
        </ButtonContainer>
      );
    },
  },
  {
    name: "Menu trigger (selected while open)",
    states: ["selected"],
    render: (context) => (
      <ButtonContainer size="sm">
        <IconButton label={text(context).newProject} selected aria-haspopup="menu" aria-expanded><FolderPlus size="md" /></IconButton>
        <IconButton label={text(context).more} aria-haspopup="menu" aria-expanded={false}><MoreHorizontal size="md" /></IconButton>
      </ButtonContainer>
    ),
  },
  {
    name: "Disabled",
    states: ["disabled"],
    render: (context) => <IconButton disabled label={text(context).remove}><Trash2 size="md" /></IconButton>,
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active", "selected", "disabled"],
  render: (context) => (
    <IconButton
      aria-haspopup={context.state === "selected" ? "menu" : undefined}
      disabled={context.state === "disabled"}
      label={text(context).newProject}
      selected={context.state === "selected"}
    >
      <FolderPlus size="md" />
    </IconButton>
  ),
};
