import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { ButtonContainer } from "../ButtonContainer";
import {
  ArrowLeft,
  Eye,
  FolderPlus,
  Globe2,
  Pick,
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
    browserShow: "Show browser", browserHide: "Hide browser", browserActive: "Butler is browsing", pick: "Pick elements",
    picked: (count: number) => `Pick elements, ${count} selected`,
    toneNote: "Tones colour the icon only; the toggle state is aria-pressed, never a pressed fill.",
  },
  "ko-KR": {
    back: "뒤로", hideLeft: "왼쪽 패널 숨기기", hideRight: "오른쪽 패널 숨기기", minimize: "창 최소화",
    maximize: "창 최대화", close: "창 닫기", dashboard: "프로젝트 대시보드", newChat: "프로젝트에서 새 채팅",
    newProject: "새 프로젝트", pin: "고정", edit: "설명 편집", remove: "행 삭제", more: "세션 작업",
    note: "버튼에 마우스를 올리거나 포커스하면 라벨이 툴팁으로 보입니다. 메뉴를 여는 버튼은 제외입니다.",
    browserShow: "브라우저 열기", browserHide: "브라우저 닫기", browserActive: "버틀러가 브라우저 사용 중", pick: "요소 선택",
    picked: (count: number) => `요소 선택, ${count}개 선택됨`,
    toneNote: "톤은 아이콘 색만 바꿉니다. 켜짐 상태는 aria-pressed로 전하고, 눌린 배경은 쓰지 않습니다.",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** The conversation title bar's browser toggle in its four states, and count badges. */
function BrowserToggles(context: ShowcaseRenderContext) {
  const copy = text(context);
  return (
    <Stack gap="sm">
      <ButtonContainer size="icon-sm">
        <IconButton label={copy.browserShow} pressed={false}><Globe2 size="md" /></IconButton>
        <IconButton label={copy.browserHide} pressed tone="butler"><Globe2 size="md" /></IconButton>
        <IconButton label={copy.browserActive} pressed={false} tone="riso" indicator><Globe2 size="md" /></IconButton>
        <IconButton label={copy.browserHide} pressed tone="riso"><Globe2 size="md" /></IconButton>
        <IconButton label={copy.picked(3)} badge={3}><Pick size="md" /></IconButton>
        <IconButton label={copy.picked(12)} badge={12}><Pick size="md" /></IconButton>
      </ButtonContainer>
      <Typo.Caption tone="secondary">{copy.toneNote}</Typo.Caption>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Tones, indicator and badge (browser toggle)", states: ["selected"], render: (context) => <BrowserToggles {...context} /> },
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
  {
    // StewardParentProgress: card header actions whose icons meet the card's top-end corner.
    name: "Optical top-end alignment",
    render: () => (
      <Stack align="row" cross="start" justify="between" gap="sm">
        <Typo.Label>Card title</Typo.Label>
        <IconButton label="Open details" opticalAlign="top-end"><Eye size="md" /></IconButton>
      </Stack>
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active", "selected", "disabled"],
  variants: ["Default tone", "Butler tone", "Riso tone + indicator", "Badge"],
  render: (context) => {
    const copy = text(context);
    const variant = context.variant;
    const browser = variant !== "Default tone";
    return (
      <IconButton
        aria-haspopup={context.state === "selected" ? "menu" : undefined}
        disabled={context.state === "disabled"}
        label={variant === "Badge" ? copy.picked(2) : browser ? copy.browserHide : copy.newProject}
        selected={context.state === "selected"}
        pressed={variant === "Butler tone" || variant === "Riso tone + indicator" ? true : undefined}
        tone={variant === "Butler tone" ? "butler" : variant === "Riso tone + indicator" ? "riso" : "default"}
        indicator={variant === "Riso tone + indicator"}
        badge={variant === "Badge" ? 2 : undefined}
      >
        {variant === "Badge" ? <Pick size="md" /> : browser ? <Globe2 size="md" /> : <FolderPlus size="md" />}
      </IconButton>
    );
  },
};
