// Sidebar information architecture for the DS Viewer. Showcase files pick one
// category from the list that matches their folder (components/ or blocks/).

export const SHOWCASE_COMPONENT_CATEGORIES = [
  "Action",
  "Input",
  "Overlay",
  "Navigation",
  "Layout",
  "Feedback",
  "Data display",
] as const;

export const SHOWCASE_BLOCK_CATEGORIES = [
  "Shell",
  "Navigation",
  "Composer",
  "Conversation & Activity",
  "Feedback",
  "Inspector",
  "Settings & Forms",
  "Dashboard & Metrics",
  "Documents & Artifacts",
] as const;

export type ShowcaseComponentCategory = (typeof SHOWCASE_COMPONENT_CATEGORIES)[number];
export type ShowcaseBlockCategory = (typeof SHOWCASE_BLOCK_CATEGORIES)[number];
export type ShowcaseCategory = ShowcaseComponentCategory | ShowcaseBlockCategory;
