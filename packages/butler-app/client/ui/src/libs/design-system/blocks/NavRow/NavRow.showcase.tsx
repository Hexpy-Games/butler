import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { IconButton } from "../../components/IconButton";
import { ArrowLeft, ChevronRight, Folder, GeneralChat, MoreHorizontal, Notebook, Settings } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { NavRow } from "./NavRow";
import { NavRowSwap } from "./NavRowSwap";

export const meta: ShowcaseMeta = {
  title: "NavRow",
  category: "Navigation",
  tags: ["sidebar", "row", "navigation", "density"],
  status: "stable",
};

const labels = {
  "en-US": {
    general: "General", project: "butler", active: "Design-system viewer", settings: "Settings",
    long: "Settings with a very long navigation label that truncates before the control region",
    menu: "Row actions", disabled: "Archived project", recent: "Release checklist review",
    recentMeta: "butler · 3 minutes ago", more: "More (12)", back: "Back to app", skills: "Skills",
  },
  "ko-KR": {
    general: "일반", project: "butler", active: "디자인 시스템 뷰어", settings: "설정",
    long: "컨트롤 영역에 닿기 전에 말줄임되는 아주 긴 내비게이션 라벨이 있는 설정",
    menu: "행 작업", disabled: "보관된 프로젝트", recent: "릴리스 체크리스트 검토",
    recentMeta: "butler · 3분 전", more: "더 보기 (12)", back: "앱으로 돌아가기", skills: "스킬",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

const menu = (label: string) => <IconButton label={label} aria-haspopup="menu"><MoreHorizontal size="md" /></IconButton>;

export const stories: ShowcaseStory[] = [
  {
    name: "Sidebar rows",
    states: ["active", "hover", "disabled"],
    widths: ["320", "375", "app"],
    render: (context) => {
      const copy = text(context);
      return (
        <Stack gap="xs">
          <NavRow icon={<GeneralChat size="md" />} label={copy.general} onClick={() => undefined} />
          <NavRow icon={<Notebook size="md" />} label={copy.active} active onClick={() => undefined} />
          <NavRow icon={<Settings size="md" />} label={copy.long} badge="3" onClick={() => undefined} />
          <NavRow icon={<Folder size="md" />} label={copy.project} onClick={() => undefined}
            actions={menu(copy.menu)} actionsVisibility="hover" />
          <NavRow icon={<Folder size="md" />} label={copy.disabled} disabled />
        </Stack>
      );
    },
  },
  {
    name: "Two lines (meta)",
    render: (context) => (
      <NavRow multiline icon={<Notebook size="md" />} label={text(context).recent} meta={<span>{text(context).recentMeta}</span>}
        actions={menu(text(context).menu)} onClick={() => undefined} />
    ),
  },
  {
    // SpaceRowMenu: activity status at rest, the row menu on hover/focus/open.
    name: "Swap trailing slot (NavRowSwap)",
    states: ["hover", "open"],
    render: (context) => (
      <Stack gap="xs">
        <NavRow icon={<Notebook size="md" />} label={text(context).active} onClick={() => undefined}
          actions={<NavRowSwap rest={<Spinner />}>{menu(text(context).menu)}</NavRowSwap>} />
        <NavRow icon={<Folder size="md" />} label={text(context).project} onClick={() => undefined}
          actions={<NavRowSwap open rest={<ChevronRight />}>{menu(text(context).menu)}</NavRowSwap>} />
      </Stack>
    ),
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
  states: ["default", "hover", "focus-visible", "active", "selected", "disabled"],
  render: (context) => (
    <NavRow
      actions={menu(text(context).menu)}
      actionsVisibility="hover"
      active={context.state === "selected"}
      disabled={context.state === "disabled"}
      icon={<Folder size="md" />}
      label={text(context).project}
      onClick={() => undefined}
    />
  ),
};
