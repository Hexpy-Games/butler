import type { ShowcaseMeta, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Grid } from "../../components/Grid";
import { PageCardDemo } from "./PageCard.demo";

export const meta: ShowcaseMeta = {
  title: "PageCard",
  category: "Browser",
  tags: ["browser", "page", "native view", "holder", "riso edge", "letterbox", "band", "reserved band", "loading"],
  status: "beta",
};

export const stories: ShowcaseStory[] = [
  {
    name: "Butler holds the tab (riso edge, fixed 1280×800 page)",
    states: ["loading"],
    render: ({ locale }) => <PageCardDemo locale={locale} holder="butler" band="agent" agent height={420} readout reserveBand />,
  },
  {
    // The band row is reserved: idle, agent and pick leave the native view's bounds (the readout) unchanged.
    name: "Reserved band row: the page never moves",
    widths: ["app", "wide"],
    render: ({ locale }) => (
      <Grid columns="3" gap="md">
        <PageCardDemo locale={locale} holder="none" band="idle" agent height={240} readout reserveBand />
        <PageCardDemo locale={locale} holder="butler" band="agent" agent height={240} readout reserveBand />
        <PageCardDemo locale={locale} holder="none" band="pick" agent height={240} readout reserveBand />
      </Grid>
    ),
  },
  {
    // Your tab: the row stays empty and quiet until a band (pick, a pop-up) arrives; the bounds do not change.
    name: "Your tab: an empty reserved row",
    widths: ["app", "wide"],
    render: ({ locale }) => (
      <Grid columns="2" gap="md">
        <PageCardDemo locale={locale} holder="none" height={240} readout reserveBand />
        <PageCardDemo locale={locale} holder="none" band="popup" height={240} readout reserveBand />
      </Grid>
    ),
  },
  { name: "You hold the tab", render: ({ locale }) => <PageCardDemo locale={locale} holder="user" band="user" agent height={420} reserveBand /> },
  { name: "Waiting for approval (static amber)", render: ({ locale }) => <PageCardDemo locale={locale} holder="waiting" band="waiting" agent height={420} reserveBand /> },
  {
    // The native view's bounds are the content area: inside the 1px border, under the band.
    name: "Your page at the card's size, loading",
    states: ["loading"],
    render: ({ locale }) => <PageCardDemo locale={locale} loading={64} readout />,
  },
  {
    name: "Holders side by side",
    widths: ["app", "wide"],
    render: ({ locale }) => (
      <Grid columns="2" gap="md">
        <PageCardDemo locale={locale} holder="none" height={240} />
        <PageCardDemo locale={locale} holder="butler" height={240} />
        <PageCardDemo locale={locale} holder="user" height={240} />
        <PageCardDemo locale={locale} holder="waiting" height={240} />
      </Grid>
    ),
  },
  { name: "No tab (empty)", render: ({ locale }) => <PageCardDemo locale={locale} state="empty" height={200} /> },
  { name: "Crashed tab", render: ({ locale }) => <PageCardDemo locale={locale} state="crashed" height={200} /> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "loading"],
  variants: ["none", "butler", "user", "waiting"],
  render: ({ locale, state, variant }) => (
    <PageCardDemo locale={locale} holder={variant as "none" | "butler" | "user" | "waiting"} loading={state === "loading" ? 40 : undefined} height={160} />
  ),
};
