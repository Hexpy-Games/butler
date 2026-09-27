import type { ComponentType } from "react";
import {
  ConversationTurnRecipe, DashboardRecipe, DialogFormRecipe, SettingsPageRecipe, SidebarRecipe, StatesRecipe,
} from "./screens";

export interface ScreenRecipe {
  id: string;
  /** Also the `// #region recipe: <title>` marker in screens.tsx. */
  title: string;
  description: string;
  /** DS exports the recipe composes, in reading order. */
  uses: string[];
  Screen: ComponentType;
}

export const RECIPES: ScreenRecipe[] = [
  {
    id: "settings", title: "Settings page", Screen: SettingsPageRecipe,
    description: "A narrow, start-aligned page: page header, then sections whose headers sit above their cards; fields follow the settings ramp.",
    uses: ["PageContainer", "SettingsHeader", "FormSection", "SettingsField", "Select", "Switch", "Input"],
  },
  {
    id: "conversation", title: "Conversation turn", Screen: ConversationTurnRecipe,
    description: "A user bubble, the assistant's work activity and answer with its footer, and the follow-up composer.",
    uses: ["MessageRow", "WorkActivityBlock", "MarkdownContent", "MessageFooter", "CopyButton", "ComposerCard", "IconButton"],
  },
  {
    id: "sidebar", title: "Sidebar", Screen: SidebarRecipe,
    description: "Sections of rows; project folders collapse; row actions appear on hover through an overflow menu.",
    uses: ["NavSection", "NavRow", "CollapsibleNavGroup", "OverflowActionMenu", "IconButton"],
  },
  {
    id: "dashboard", title: "Project dashboard", Screen: DashboardRecipe,
    description: "Header with the primary action, counting metrics, the activity calendar and document tiles.",
    uses: ["DashboardHeader", "MetricGrid", "MetricCard", "ActivityHeatmap", "DocumentTile", "Button"],
  },
  {
    id: "dialog", title: "Dialog form", Screen: DialogFormRecipe,
    description: "A focused task: title, description, fields and a right-aligned footer. Put it inside DialogContent.",
    uses: ["DialogForm", "SettingsField", "Input", "ButtonContainer", "Button"],
  },
  {
    id: "states", title: "Empty, loading and error states", Screen: StatesRecipe,
    description: "Say what is missing and offer the next step; show the shape while loading; errors explain and retry.",
    uses: ["EmptyLine", "Skeleton", "Notice", "Button"],
  },
];
