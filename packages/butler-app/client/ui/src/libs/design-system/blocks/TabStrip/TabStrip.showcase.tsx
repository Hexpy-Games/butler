import { useLayoutEffect, useRef } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { TabStrip } from "./TabStrip";
import { crowdedGroups, demoGroups, demoLabels, ICONS, TabStripDemo } from "./TabStrip.demo";
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
  if (variant === "My tab") return [{ id: "mine", kind: "mine", tabs: [{ id: "t", title: copy.mine, faviconSrc: ICONS.docs }] }];
  const tabs = [{ id: "t", title: copy.conversation, faviconSrc: ICONS.shop }];
  if (variant === "Conversation tab") return [{ id: "c", kind: "conversation", label: copy.group, tabs }];
  return [{ id: "c", kind: "conversation", label: copy.group, state: "working", collapsed: selected, tabs }];
}

/** Forces the cell's state on the tab itself, not on the group chip in front of it. */
function MatrixCell({ context }: { context: ShowcaseStateContext }) {
  const cell = useRef<HTMLDivElement>(null);
  const selected = context.state === "selected";
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
    name: "My tabs and conversation groups",
    states: ["selected", "open", "loading"],
    render: ({ locale }) => <TabStripDemo locale={locale} initial={demoGroups(locale)} panelId="tab-strip-demo-page" />,
  },
  {
    name: "Group states: working, waiting for approval, crashed tab",
    render: ({ locale }) => <TabStripDemo locale={locale} initial={demoGroups(locale, { crashed: true })} activeTabId="x1" />,
  },
  {
    name: "Overflow: tabs shrink, then scroll sideways",
    render: ({ locale }) => <TabStripDemo locale={locale} initial={crowdedGroups(locale)} activeTabId="n12" />,
  },
  {
    name: "Only my tabs (no chip)",
    render: ({ locale }) => <TabStripDemo locale={locale} initial={demoGroups(locale).slice(0, 1)} />,
  },
  {
    name: "Locked order, no new-tab button",
    render: ({ locale }) => (
      <TabStrip groups={demoGroups(locale).slice(0, 2)} activeTabId="s2" labels={demoLabels(locale)} onActivate={noop} onClose={noop} />
    ),
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active", "selected"],
  variants: ["My tab", "Conversation tab", "Group chip"],
  render: (context) => <MatrixCell context={context} />,
};
