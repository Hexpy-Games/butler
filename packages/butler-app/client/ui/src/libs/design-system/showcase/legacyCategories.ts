import type { ShowcaseCategory } from "./categories";

// Temporary IA placement for folders that do not have a `*.showcase.tsx` yet.
// Remove an entry when its showcase file declares `meta.category` itself.
export const legacyShowcaseCategories: Record<string, ShowcaseCategory> = {
  "blocks/ActivityHeatmap": "Dashboard & Metrics",
  "blocks/ArtifactList": "Documents & Artifacts",
  "blocks/ArtifactPreview": "Documents & Artifacts",
  "blocks/AutomationRow": "Dashboard & Metrics",
  "blocks/AutomationRunList": "Dashboard & Metrics",
  "blocks/CardList": "Settings & Forms",
  "blocks/DashboardHeader": "Dashboard & Metrics",
  "blocks/DialogForm": "Settings & Forms",
  "blocks/DocumentReader": "Documents & Artifacts",
  "blocks/DocumentTile": "Documents & Artifacts",
  "blocks/FilteredSelectPopover": "Navigation",
  "blocks/FormRow": "Settings & Forms",
  "blocks/MarkdownContent": "Documents & Artifacts",
  "blocks/PercentInputControl": "Settings & Forms",
  "blocks/ProgressStepper": "Inspector",
  "blocks/ResourceSummary": "Dashboard & Metrics",
  "blocks/ResourceTile": "Dashboard & Metrics",
  "blocks/SettingsHeader": "Settings & Forms",
  "blocks/SettingsNav": "Settings & Forms",
  "blocks/SettingsSecretRows": "Settings & Forms",
  "blocks/TokenInputControl": "Settings & Forms",
};
