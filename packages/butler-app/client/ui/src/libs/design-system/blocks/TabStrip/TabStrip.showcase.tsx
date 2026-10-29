import { useLayoutEffect, useRef } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { TabStrip } from "./TabStrip";
import { IconButton } from "../../components/IconButton";
import { FileText, ImageIcon, TabIn } from "../../components/Icons";
import { conversationGroup, crowdedGroups, demoGroups, demoLabels, foldedGroups, ICONS, pairedGroups, TabStripDemo } from "./TabStrip.demo";
import type { TabStripGroup } from "./tabStripModel";

export const meta: ShowcaseMeta = {
  title: "TabStrip",
  category: "Navigation",
  tags: ["browser", "tabs", "tablist", "groups", "drag", "reorder", "conversation"],
  status: "beta",
};

const noop = () => undefined;

const MATRIX_COPY = {
  "en-US": { mine: "Butler design system", conversation: "Checkout", group: "Shoes" },
  "ko-KR": { mine: "버틀러 디자인 시스템", conversation: "결제", group: "러닝화" },
} as const;

function matrixGroups(variant: string, selected: boolean, { locale }: ShowcaseRenderContext): TabStripGroup[] {
  const copy = MATRIX_COPY[locale];
  if (variant === "My tab" || variant === "Selected tab") return [{ id: "mine", kind: "mine", tabs: [{ id: "t", title: copy.mine, faviconSrc: ICONS.docs }] }];
  const tabs = [{ id: "t", title: copy.conversation, faviconSrc: ICONS.shop }];
  if (variant === "Conversation tab") return [{ id: "c", kind: "conversation", label: copy.group, tabs }];
  return [{ id: "c", kind: "conversation", label: copy.group, state: "working", collapsed: selected, tabs }];
}

const FILE_TITLES = {
  "en-US": ["release-notes.md", "ime-guard.ts", "shortcut-clash.png"],
  "ko-KR": ["릴리스-노트.md", "ime-guard.ts", "단축키-충돌.png"],
} as const;

function fileGroups(locale: ShowcaseRenderContext["locale"]): TabStripGroup[] {
  const [doc, code, image] = FILE_TITLES[locale];
  return [{ id: "files", kind: "mine", tabs: [
    { id: "f1", title: doc, icon: <FileText size="md" /> },
    { id: "f2", title: code, icon: <FileText size="md" /> },
    { id: "f3", title: image, icon: <ImageIcon size="md" /> },
  ] }];
}

/**
 * Forces the cell's state on the tab itself, not on the group title in front of it. The close
 * button shows only in the hover and focus-visible columns; "Selected tab" shows that the
 * active tab follows the same rule.
 */
function MatrixCell({ context }: { context: ShowcaseStateContext }) {
  const cell = useRef<HTMLDivElement>(null);
  const selected = context.state === "selected" || context.variant === "Selected tab";
  useLayoutEffect(() => {
    if (context.variant !== "Group chip") cell.current?.querySelector('[role="tab"]')?.setAttribute("data-ds-force-target", "");
  }, [context.variant]);
  return (
    <div ref={cell}>
      <TabStrip groups={matrixGroups(context.variant, selected, context)} activeTabId={selected ? "t" : null}
        labels={demoLabels(context.locale)} onActivate={noop} onClose={noop} onToggleGroup={noop} />
    </div>
  );
}

export const stories: ShowcaseStory[] = [
  {
    // Beside other groups every group is an outline pill: its title (a click folds it), its tabs and its own +.
    name: "My tabs and conversation groups",
    states: ["selected", "open", "loading"],
    render: ({ locale }) => <TabStripDemo locale={locale} initial={demoGroups(locale)} panelId="tab-strip-demo-page" />,
  },
  {
    name: "My tabs beside one conversation",
    render: ({ locale }) => <TabStripDemo locale={locale} initial={pairedGroups(locale)} />,
  },
  {
    // Dividers sit between tabs and after the title; they step aside next to the selected (or hovered) tab.
    name: "Dividers: the selected tab in the middle of a group",
    render: ({ locale }) => <TabStripDemo locale={locale} initial={pairedGroups(locale, { middle: true })} activeTabId="s2" />,
  },
  {
    // A folded group keeps its title, previews three favicons and counts the rest; its + hides with its tabs.
    name: "Folded group: three favicons and +N beside an open group",
    render: ({ locale }) => <TabStripDemo locale={locale} initial={foldedGroups(locale)} activeTabId="s1" />,
  },
  {
    name: "Group states: working, waiting for approval, crashed tab",
    render: ({ locale }) => <TabStripDemo locale={locale} initial={demoGroups(locale, { crashed: true })} activeTabId="x1" />,
  },
  {
    // Tabs in every pill share one width; past the minimum the row scrolls with edge fades.
    name: "Overflow: tabs shrink, then scroll sideways",
    render: ({ locale }) => (
      <div style={{ width: "100%", maxWidth: 600 }}>
        <TabStripDemo locale={locale} initial={crowdedGroups(locale)} activeTabId="n12" />
      </div>
    ),
  },
  {
    // A conversation's browser pane: only its group, no title or outline (the title bar names it), bring-in at the row end.
    name: "Conversation pane: one group without its title, trailing slot",
    render: ({ locale }) => (
      <TabStripDemo locale={locale} initial={conversationGroup(locale)} activeTabId="s1" hideChip
        trailing={<IconButton label={locale === "ko-KR" ? "내 탭 가져오기" : "Bring in a tab"}><TabIn size="md" /></IconButton>} />
    ),
  },
  {
    name: "Only my tabs: plain pill tabs and the row's +",
    render: ({ locale }) => <TabStripDemo locale={locale} initial={demoGroups(locale).slice(0, 1)} />,
  },
  {
    name: "Locked order, no new-tab button",
    render: ({ locale }) => (
      <TabStrip groups={demoGroups(locale).slice(0, 2)} activeTabId="s2" labels={demoLabels(locale)} onActivate={noop} onClose={noop} />
    ),
  },
  {
    // A docked file viewer's tabs: each tab's `icon` (its file type) takes the favicon slot instead of the globe.
    name: "File tabs: a file-type icon per tab",
    render: ({ locale }) => (
      <TabStrip hideChip groups={fileGroups(locale)} activeTabId="f1" labels={demoLabels(locale)} onActivate={noop} onClose={noop} />
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active", "selected"],
  variants: ["My tab", "Selected tab", "Conversation tab", "Group chip"],
  render: (context) => <MatrixCell context={context} />,
};
