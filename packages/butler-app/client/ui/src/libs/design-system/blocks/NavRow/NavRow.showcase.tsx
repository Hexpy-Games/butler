import type { ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { ButtonContainer } from "../../components/ButtonContainer";
import { IconButton } from "../../components/IconButton";
import { IconSlot } from "../../components/IconSlot";
import {
  Archive, ArrowLeft, ChevronRight, Folder, GeneralChat, LayoutDashboard, Notebook, PencilLine, Settings,
} from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { UnreadDot } from "../../components/UnreadDot";
import { OverflowActionMenu } from "../OverflowActionMenu";
import { SidebarShell } from "../SidebarShell";
import { NavRow } from "./NavRow";
import { NavRowSwap } from "./NavRowSwap";
import { NAV_ROW_SURFACE_VARIANTS, NavRowSurface } from "./fixtures/NavRowSurface";
import { nestedRowsStory } from "./fixtures/NavRowNested";

export const meta: ShowcaseMeta = {
  title: "NavRow",
  category: "Navigation",
  tags: ["sidebar", "row", "navigation", "density"],
  status: "stable",
};

const labels = {
  "en-US": {
    general: "Chats", project: "butler", active: "Design-system viewer", settings: "Settings",
    long: "Settings with a very long navigation label that truncates before the control region",
    menu: "Row actions", disabled: "Archived project", recent: "Release checklist review",
    recentMeta: "butler · 3 minutes ago", more: "More (12)", back: "Back to app", skills: "Skills",
    rename: "Rename", archive: "Archive", dashboard: "Dashboard", expand: "Expand", working: "Working", unread: "Unread", sidebar: "Sidebar",
  },
  "ko-KR": {
    general: "대화", project: "butler", active: "디자인 시스템 뷰어", settings: "설정",
    long: "컨트롤 영역에 닿기 전에 말줄임되는 아주 긴 내비게이션 라벨이 있는 설정",
    menu: "행 작업", disabled: "보관된 프로젝트", recent: "릴리스 체크리스트 검토",
    recentMeta: "butler · 3분 전", more: "더 보기 (12)", back: "앱으로 돌아가기", skills: "스킬",
    rename: "이름 바꾸기", archive: "보관", dashboard: "대시보드", expand: "펼치기", working: "작업 중", unread: "읽지 않음", sidebar: "사이드바",
  },
} as const;

const text = ({ locale }: ShowcaseRenderContext) => labels[locale];

type Copy = ReturnType<typeof text>;

/** Sidebar rows render inside the app's SidebarShell, which sizes their action targets and active fill. */
function Sidebar({ copy, children }: { copy: Copy; children: ReactNode }) {
  return <SidebarShell ariaLabel={copy.sidebar} scrollFade={false}>{children}</SidebarShell>;
}

/** SpaceRowMenu: the rest content (activity, else the unread dot) gives way to the row menu on hover, focus or while open. */
function rowMenu(copy: Copy, rest?: ReactNode, open?: boolean) {
  return (
    <NavRowSwap rest={rest ?? <UnreadDot label={copy.unread} present={false} />} open={open}>
      <OverflowActionMenu label={copy.menu} items={[
        { icon: <PencilLine size="sm" />, label: copy.rename, onSelect: () => undefined },
        { icon: <Archive size="sm" />, label: copy.archive, onSelect: () => undefined },
      ]} />
    </NavRowSwap>
  );
}

/** SpaceRowActions for a project: the dashboard button, then the row menu (behind the disclosure chevron when given). */
function projectActions(copy: Copy, chevron?: ReactNode, open?: boolean) {
  const menu = rowMenu(copy, undefined, open);
  return (
    <ButtonContainer size="icon-sm" wrap={false}>
      <IconButton label={`${copy.project} ${copy.dashboard}`}><LayoutDashboard /></IconButton>
      {chevron ? <NavRowSwap open={open} rest={chevron}>{menu}</NavRowSwap> : menu}
    </ButtonContainer>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Sidebar rows",
    states: ["active", "hover", "disabled"],
    widths: ["320", "375", "app"],
    render: (context) => {
      const copy = text(context);
      return (
        <Sidebar copy={copy}>
          <Stack gap="xs">
            <NavRow icon={<GeneralChat size="md" />} label={copy.general} onClick={() => undefined} />
            <NavRow icon={<Notebook size="md" />} label={copy.active} active onClick={() => undefined} actions={rowMenu(copy)} />
            <NavRow icon={<Settings size="md" />} label={copy.long} badge="3" onClick={() => undefined} />
            <NavRow icon={<Folder size="md" />} label={copy.project} onClick={() => undefined} actions={projectActions(copy)} />
            <NavRow icon={<Folder size="md" />} label={copy.disabled} disabled />
          </Stack>
        </Sidebar>
      );
    },
  },
  {
    name: "Two lines (meta)",
    render: (context) => (
      <Sidebar copy={text(context)}>
        <NavRow multiline icon={<Notebook size="md" />} label={text(context).recent} meta={<span>{text(context).recentMeta}</span>}
          actions={rowMenu(text(context))} onClick={() => undefined} />
      </Sidebar>
    ),
  },
  {
    // SpaceRowMenu: activity status at rest, the row menu on hover/focus/open.
    name: "Swap trailing slot (NavRowSwap)",
    states: ["hover", "open"],
    render: (context) => {
      const copy = text(context);
      const working = <IconSlot size="sidebar" minHeight="line" passive role="status" aria-label={copy.working}><Spinner /></IconSlot>;
      const chevron = <IconButton tabIndex={-1} label={`${copy.project} ${copy.expand}`}><ChevronRight /></IconButton>;
      return (
        <Sidebar copy={copy}>
          <Stack gap="xs">
            <NavRow icon={<Notebook size="md" />} label={copy.active} onClick={() => undefined} actions={rowMenu(copy, working)} />
            <NavRow icon={<Folder size="md" />} label={copy.project} onClick={() => undefined} actions={projectActions(copy, chevron, true)} />
          </Stack>
        </Sidebar>
      );
    },
  },
  {
    name: "Densities",
    render: (context) => (
      <Stack gap="sm">
        {(["compact", "comfortable", "touch"] as const).map((density) => (
          <NavRow density={density} icon={<Notebook size="md" />} key={density} label={`${text(context).recent} · ${density}`} onClick={() => undefined} />
        ))}
      </Stack>
    ),
  },
  nestedRowsStory,
  {
    name: "Label-only rows (load more, settings back, skills)",
    render: (context) => (
      <Stack gap="xs">
        <NavRow ariaLabel={text(context).back} icon={<ArrowLeft size="lg" />} label={text(context).back} onClick={() => undefined} />
        <NavRow label={text(context).skills} active onClick={() => undefined} />
        <NavRow reserveIcon label={<Typo.Text tone="secondary">{text(context).more}</Typo.Text>} onClick={() => undefined} />
      </Stack>
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active", "disabled"],
  variants: Object.keys(NAV_ROW_SURFACE_VARIANTS),
  render: (context) => {
    const variant = NAV_ROW_SURFACE_VARIANTS[context.variant] ?? { surface: "white", selected: false };
    return (
      <NavRowSurface surface={variant.surface}>
        <Sidebar copy={text(context)}>
          <NavRow actions={rowMenu(text(context))} active={variant.selected} disabled={context.state === "disabled"}
            icon={<Folder size="md" />} label={text(context).project} onClick={() => undefined} />
        </Sidebar>
      </NavRowSurface>
    );
  },
};
