import type { ShowcaseRenderContext, ShowcaseStory } from "../../../showcase";
import { Stack } from "../../../components/Stack";
import { Typo } from "../../../components/Typo";
import { ShellFrameDemo, type ShellFrameView } from "./ShellFrameDemo";

/** Flat above cards, the same window and state: everything but the shell surfaces is unchanged. */
function FlatVsCards({ locale, view, width = 1440, sidebar }: {
  locale: ShowcaseRenderContext["locale"]; view: ShellFrameView; width?: number; sidebar?: "open" | "collapsed" | "peek";
}) {
  const height = width === 1440 ? 900 : 800;
  return (
    <Stack gap="md">
      <Typo.Caption tone="secondary">frame="flat"</Typo.Caption>
      <ShellFrameDemo locale={locale} frame="flat" view={view} width={width} height={height} sidebar={sidebar} />
      <Typo.Caption tone="secondary">frame="cards"</Typo.Caption>
      <ShellFrameDemo locale={locale} frame="cards" view={view} width={width} height={height} sidebar={sidebar} />
    </Stack>
  );
}

/** AdaptiveShell frame="cards" stories (the approved app shell), light and dark through the viewer theme. */
export const cardsStories: ShowcaseStory[] = [
  {
    // frame="cards": one shell surface (sidebar, traffic lights, title row); content in a rounded card.
    name: "Cards frame: conversation (flat vs cards)",
    widths: ["app", "wide"],
    render: ({ locale }) => <FlatVsCards locale={locale} view="chat" />,
  },
  {
    // The chat column and the browser sheet are two cards; the page card is the only nested surface.
    name: "Cards frame: conversation + browser (1440, and 1100 with the sidebar stepped aside)",
    widths: ["app", "wide"],
    render: ({ locale }) => (
      <Stack gap="md">
        <ShellFrameDemo locale={locale} frame="cards" view="browser" width={1440} height={900} />
        <ShellFrameDemo locale={locale} frame="cards" view="browser" width={1100} height={800} sidebar="collapsed" />
      </Stack>
    ),
  },
  {
    // The inspector is the side card; the title row spans its column, so ⋯ · browser · inspector never move.
    name: "Cards frame: inspector open, title icons stay (closed above, open below)",
    states: ["open", "collapsed"],
    widths: ["app", "wide"],
    render: ({ locale }) => (
      <Stack gap="md">
        <ShellFrameDemo locale={locale} frame="cards" view="chat" width={1440} height={900} />
        <ShellFrameDemo locale={locale} frame="cards" view="inspector" width={1440} height={900} />
        <ShellFrameDemo locale={locale} frame="cards" view="inspector" width={1100} height={800} />
      </Stack>
    ),
  },
  {
    name: "Cards frame: sidebar collapsed and peek",
    states: ["collapsed", "open"],
    widths: ["app", "wide"],
    render: ({ locale }) => (
      <Stack gap="md">
        <ShellFrameDemo locale={locale} frame="cards" view="chat" width={1440} height={900} sidebar="collapsed" />
        <ShellFrameDemo locale={locale} frame="cards" view="browser" width={1100} height={800} sidebar="peek" />
      </Stack>
    ),
  },
  {
    // The settings navigation sits on the shell; the detail pane is the card.
    name: "Cards frame: settings (flat vs cards)",
    widths: ["app", "wide"],
    render: ({ locale }) => <FlatVsCards locale={locale} view="settings" />,
  },
  {
    // The standalone Browser: the sheet itself is the card (no outer card).
    name: "Cards frame: standalone browser",
    widths: ["app", "wide"],
    render: ({ locale }) => <ShellFrameDemo locale={locale} frame="cards" view="hub" width={1440} height={900} />,
  },
  {
    // The wallpaper lives inside the content card, clipped to its corners; the shell stays the window material.
    name: "Cards frame: wallpaper inside the card",
    widths: ["app", "wide"],
    render: ({ locale }) => <ShellFrameDemo locale={locale} frame="cards" view="chat" width={1440} height={900} wallpaper />,
  },
];
