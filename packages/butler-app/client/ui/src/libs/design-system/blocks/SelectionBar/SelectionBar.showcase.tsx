import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Copy, ImageIcon, MessageSquarePlus, Scrap } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { BROWSER_DEMO_COPY } from "../BrowserPane/fixtures/copy";
import { PageCardDemo } from "../PageCard/PageCard.demo";
import { SelectionBar, type SelectionBarAction } from "./SelectionBar";

export const meta: ShowcaseMeta = {
  title: "SelectionBar",
  category: "Browser",
  tags: ["browser", "pick", "selection", "toolbar", "elements", "attach", "scrap"],
  status: "beta",
};

function actions({ locale }: ShowcaseRenderContext): SelectionBarAction[] {
  const copy = BROWSER_DEMO_COPY[locale];
  return [
    { id: "attach", label: copy.attach, icon: <MessageSquarePlus size="sm" />, onSelect: () => undefined },
    { id: "image", label: copy.saveImage, icon: <ImageIcon size="sm" />, onSelect: () => undefined },
    { id: "scrap", label: copy.scrap, icon: <Scrap size="sm" />, onSelect: () => undefined },
    { id: "copy", label: copy.copyText, icon: <Copy size="sm" />, onSelect: () => undefined },
  ];
}

function Bar({ context, count, compact, dimmed, list }: {
  context: ShowcaseRenderContext; count: number; compact?: boolean; dimmed?: boolean; list?: SelectionBarAction[];
}) {
  const copy = BROWSER_DEMO_COPY[context.locale];
  return (
    <SelectionBar placement="inline" count={count} label={copy.picked(count)} hint={copy.pickEmpty} emptyReason={copy.pickFirst}
      actions={list ?? actions(context)} compact={compact} dimmed={dimmed} onClear={() => undefined} clearLabel={copy.clear} />
  );
}

/** Floating over a page card of a given width (the bar answers to the card's width). */
function OnPage({ context, width, count }: { context: ShowcaseRenderContext; width: number; count: number }) {
  const copy = BROWSER_DEMO_COPY[context.locale];
  return (
    <div style={{ width: "100%", maxWidth: width }}>
      <PageCardDemo locale={context.locale} band="pick" height={300} overlay={(
        <SelectionBar count={count} label={copy.picked(count)} hint={copy.pickEmpty} emptyReason={copy.pickFirst} actions={actions(context)}
          onClear={() => undefined} clearLabel={copy.clear} />
      )} />
    </div>
  );
}

export const stories: ShowcaseStory[] = [
  {
    // Acceptance: 1, 2 and 10 picks, one line each.
    name: "1, 2 and 10 picks",
    render: (context) => (
      <Stack gap="sm" cross="start">
        <Bar context={context} count={1} />
        <Bar context={context} count={2} />
        <Bar context={context} count={10} />
      </Stack>
    ),
  },
  {
    // Pick mode just started: the bar is already there, with a hint and unavailable actions (reason tooltips).
    name: "Picking, nothing picked yet (0)",
    states: ["disabled"],
    render: (context) => <Stack cross="start"><Bar context={context} count={0} /></Stack>,
  },
  {
    name: "Picking on a page (0)",
    widths: ["app", "wide"],
    render: (context) => <OnPage context={context} width={720} count={0} />,
  },
  { name: "Picking on a narrow page (0)", widths: ["375", "app"], render: (context) => <OnPage context={context} width={360} count={0} /> },
  {
    // One action can be unavailable for its own reason while the others work.
    name: "One unavailable action",
    states: ["disabled"],
    render: (context) => (
      <Stack cross="start">
        <Bar context={context} count={2} list={actions(context).map((action) => action.id === "copy"
          ? { ...action, disabledReason: context.locale === "ko-KR" ? "고른 요소에 텍스트가 없어요" : "No text in these picks" } : action)} />
      </Stack>
    ),
  },
  { name: "Kept selection (pick mode off): the pill", render: (context) => <Stack cross="start"><Bar context={context} count={2} compact /></Stack> },
  { name: "Dimmed while the picks are dragged", render: (context) => <Stack cross="start"><Bar context={context} count={2} dimmed /></Stack> },
  { name: "Floating on a wide page", widths: ["app", "wide"], render: (context) => <OnPage context={context} width={720} count={2} /> },
  {
    // Narrow page cards keep one line: icon-only actions with tooltips.
    name: "Floating on a narrow page (icon actions)",
    render: (context) => <OnPage context={context} width={420} count={10} />,
  },
];

/** One action keeps the matrix cell narrow; the forced states land on its buttons. */
function MatrixBar({ locale, compact, count }: { locale: ShowcaseRenderContext["locale"]; compact: boolean; count: number }) {
  const copy = BROWSER_DEMO_COPY[locale];
  return (
    <SelectionBar placement="inline" count={count} label={copy.picked(count)} hint={copy.pickEmpty} emptyReason={copy.pickFirst}
      actions={actions({ locale }).slice(0, 1)} compact={compact} onClear={() => undefined} clearLabel={copy.clear} />
  );
}

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active"],
  variants: ["Full (one action)", "Pill", "Picking (0)"],
  render: ({ locale, variant }) => <MatrixBar locale={locale} compact={variant === "Pill"} count={variant === "Picking (0)" ? 0 : 2} />,
};
