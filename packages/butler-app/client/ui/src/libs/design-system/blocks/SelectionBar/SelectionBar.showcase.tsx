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

function Bar({ context, count, compact, dimmed }: { context: ShowcaseRenderContext; count: number; compact?: boolean; dimmed?: boolean }) {
  const copy = BROWSER_DEMO_COPY[context.locale];
  return (
    <SelectionBar placement="inline" count={count} label={copy.picked(count)} actions={actions(context)} compact={compact} dimmed={dimmed}
      onClear={() => undefined} clearLabel={copy.clear} />
  );
}

/** Floating over a page card of a given width (the bar answers to the card's width). */
function OnPage({ context, width, count }: { context: ShowcaseRenderContext; width: number; count: number }) {
  const copy = BROWSER_DEMO_COPY[context.locale];
  return (
    <div style={{ width, maxWidth: "100%" }}>
      <PageCardDemo locale={context.locale} band="pick" height={300} overlay={(
        <SelectionBar count={count} label={copy.picked(count)} actions={actions(context)} onClear={() => undefined} clearLabel={copy.clear} />
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
  { name: "Kept selection (pick mode off): the pill", render: (context) => <Stack cross="start"><Bar context={context} count={2} compact /></Stack> },
  { name: "Dimmed while the picks are dragged", render: (context) => <Stack cross="start"><Bar context={context} count={2} dimmed /></Stack> },
  { name: "Floating on a wide page", widths: ["app", "wide"], render: (context) => <OnPage context={context} width={720} count={2} /> },
  {
    // Narrow page cards keep one line: icon-only actions with tooltips.
    name: "Floating on a narrow page (icon actions)",
    render: (context) => <OnPage context={context} width={420} count={10} />,
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active"],
  variants: ["Full", "Pill"],
  render: ({ locale, variant }) => <Stack cross="start"><Bar context={{ locale }} count={2} compact={variant === "Pill"} /></Stack>,
};
