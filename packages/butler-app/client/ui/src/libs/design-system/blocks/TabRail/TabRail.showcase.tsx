import type { ShowcaseMeta, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { ComeAndGo, InConversation, Rail, SET_A, SET_B, Stage } from "./tabRailDemo";

export const meta: ShowcaseMeta = {
  title: "TabRail",
  category: "Browser",
  tags: ["browser", "tabs", "rail", "live", "preview", "shelf", "background", "conversation"],
  status: "beta",
};

// Every state at every mode: set A (needs you, busy, error, then idle and approval behind "+2"), set B (approval, held, idle).
export const stories: ShowcaseStory[] = [
  { name: "Full rail: needs you, busy, error, +2", widths: ["375", "app", "wide"],
    render: ({ locale }) => <Stage height="tall"><Rail locale={locale} states={SET_A} mode="full" /></Stage> },
  { name: "Full rail: approval, held, idle", widths: ["375", "app", "wide"],
    render: ({ locale }) => <Stage height="tall"><Rail locale={locale} states={SET_B} mode="full" /></Stage> },
  { name: "Full rail: short card shows two", widths: ["375", "app"],
    render: ({ locale }) => <Stage height="short"><Rail locale={locale} states={SET_A} mode="full" /></Stage> },
  { name: "Compact rail: needs you, busy, error, +2", widths: ["320", "375", "app"],
    render: ({ locale }) => <Stage height="tall"><Rail locale={locale} states={SET_A} mode="compact" /></Stage> },
  { name: "Compact rail: approval, held, idle", widths: ["320", "375", "app"],
    render: ({ locale }) => <Stage height="tall"><Rail locale={locale} states={SET_B} mode="compact" /></Stage> },
  { name: "Shelf: needs you, busy, error, +2", widths: ["320", "375", "430", "app"],
    render: ({ locale }) => <Stage height="strip"><Rail locale={locale} states={SET_A} mode="shelf" /></Stage> },
  { name: "Shelf: approval, held, idle", widths: ["320", "375", "430", "app"],
    render: ({ locale }) => <Stage height="strip"><Rail locale={locale} states={SET_B} mode="shelf" /></Stage> },
  { name: "In a conversation: mode from the card width", widths: ["320", "375", "app", "wide"],
    render: ({ locale }) => <InConversation locale={locale} /> },
  { name: "Tabs come and go: full", widths: ["375", "app"], render: ({ locale }) => <ComeAndGo locale={locale} mode="full" /> },
  { name: "Tabs come and go: shelf", widths: ["320", "375"], render: ({ locale }) => <ComeAndGo locale={locale} mode="shelf" /> },
  { name: "Reduced motion: still marks, no entrance", widths: ["375", "app"],
    render: ({ locale }) => <Stage height="tall"><Rail locale={locale} states={SET_A} mode="full" reducedMotion /></Stage> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible"],
  variants: ["full", "compact", "shelf"],
  render: ({ locale, variant }) => (
    <Stage height={variant === "shelf" ? "strip" : "tall"}>
      <Rail locale={locale} states={SET_A} mode={variant as "full" | "compact" | "shelf"} />
    </Stage>
  ),
};
