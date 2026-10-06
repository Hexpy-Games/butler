import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Plus, RefreshCcw } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { EmptyLine } from "../EmptyLine";
import { Notice } from "../Notice";
import { demoGroups, TabStripDemo } from "../TabStrip/TabStrip.demo";
import { SLOT_COPY, SlotDemo } from "./NativeViewSlot.demo";

export const meta: ShowcaseMeta = {
  title: "NativeViewSlot",
  category: "Shell",
  tags: ["browser", "electron", "webcontentsview", "bounds", "occlusion", "viewport"],
  status: "beta",
};

const AGENT_VIEWPORT = { width: 1280, height: 800 };

function NoTabs({ locale }: ShowcaseRenderContext) {
  const copy = SLOT_COPY[locale];
  return (
    <Stack fill justify="center" cross="center">
      <EmptyLine message={copy.empty} action={<Button size="sm" variant="outline" iconStart={<Plus size="md" />} text={copy.newTab} />} />
    </Stack>
  );
}

function Crashed({ locale }: ShowcaseRenderContext) {
  const copy = SLOT_COPY[locale];
  return (
    <Stack fill justify="start">
      <Notice tone="error" message={copy.crashed} action={<Button size="sm" variant="outline" iconStart={<RefreshCcw size="md" />} text={copy.reload} />} />
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Live bounds and occlusion",
    states: ["open", "loading"],
    render: ({ locale }) => <SlotDemo locale={locale} controls />,
  },
  {
    name: "Fixed viewport for agent tabs (1280×800)",
    render: ({ locale }) => <SlotDemo locale={locale} viewport={AGENT_VIEWPORT} />,
  },
  {
    name: "Covered: the still stands in",
    render: ({ locale }) => <SlotDemo locale={locale} covered />,
  },
  {
    name: "Hidden: no open tabs",
    render: (context) => <SlotDemo locale={context.locale} fallback={<NoTabs {...context} />} height="10rem" />,
  },
  {
    name: "Hidden: crashed page",
    render: (context) => <SlotDemo locale={context.locale} fallback={<Crashed {...context} />} height="10rem" />,
  },
  {
    name: "Browser area: TabStrip over the slot",
    widths: ["app", "wide"],
    render: ({ locale }) => (
      <Stack gap="sm">
        <TabStripDemo locale={locale} initial={demoGroups(locale)} activeTabId="s1" panelId="native-view-browser-demo" />
        <SlotDemo locale={locale} viewport={AGENT_VIEWPORT} height="20rem" panelId="native-view-browser-demo" />
      </Stack>
    ),
  },
];
