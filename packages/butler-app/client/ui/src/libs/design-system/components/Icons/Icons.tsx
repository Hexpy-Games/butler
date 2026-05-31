/**
 * Icon wrapper for Butler UI
 * Maps Butler UI icon names to Hugeicons alternatives.
 * Preserves simple <Icon size={...} /> usage pattern
 */

import { HugeiconsIcon } from "@hugeicons/react";
import type { HugeiconsIconProps } from "@hugeicons/react";
import * as FreeIcons from "@hugeicons/core-free-icons";

// Icon component props extending Hugeicons with simplified API
export interface IconProps extends Omit<HugeiconsIconProps, "icon" | "size"> {
  size?: number;
}

// Helper to create icon component
function createIcon(iconName: keyof typeof FreeIcons) {
  return ({ size = 15, ...props }: IconProps) => {
    const icon = FreeIcons[iconName];
    return <HugeiconsIcon icon={icon} size={size} {...props} />;
  };
}

// Export individual icon components
export const Activity = createIcon("Activity01Icon");
export const AlertCircle = createIcon("AlertCircleIcon");
export const Archive = createIcon("ArchiveIcon");
export const CheckCircle2 = createIcon("CheckmarkCircle02Icon");
export const CircleAlert = createIcon("AlertCircleIcon");
export const CircleX = createIcon("CancelCircleIcon");
export const ListFilter = createIcon("FilterIcon");
export const LoaderCircle = createIcon("Loading03Icon");
export const ArrowLeft = createIcon("ArrowLeft01Icon");
export const Blocks = createIcon("SquareLock02Icon");
export const BookOpenText = createIcon("BookOpen01Icon");
export const Bot = createIcon("BotIcon");
export const CheckIcon = createIcon("Tick02Icon");
export const ChevronDown = createIcon("ArrowDown01Icon");
export const ChevronDownIcon = createIcon("ArrowDown01Icon");
export const ChevronRight = createIcon("ArrowRight01Icon");
export const ChevronRightIcon = createIcon("ArrowRight01Icon");
export const ChevronUpIcon = createIcon("ArrowUp01Icon");
export const ChevronsUpDown = createIcon("ArrowUpDownIcon");
export const Collapse = createIcon("CollapseIcon");
export const Circle = createIcon("CircleIcon");
export const Clock3 = createIcon("Clock03Icon");
export const Command = createIcon("CommandIcon");
export const Copy = createIcon("Copy01Icon");
export const Database = createIcon("DatabaseIcon");
export const Eye = createIcon("ViewIcon");
export const Expand = createIcon("ExpandIcon");
export const FileText = createIcon("File02Icon");
export const Folder = createIcon("Folder01Icon");
export const FolderOpen = createIcon("Folder02Icon");
export const FolderPlus = createIcon("FolderAddIcon");
export const GitBranch = createIcon("GitBranchIcon");
export const Globe2 = createIcon("Globe02Icon");
export const History = createIcon("Time03Icon");
export const ImageIcon = createIcon("Image01Icon");
export const LayoutDashboard = createIcon("LayoutGridIcon");
export const ListChecks = createIcon("Task01Icon");
export const MessageSquarePlus = createIcon("MessageAdd01Icon");
export const Monitor = createIcon("ComputerIcon");
export const Moon = createIcon("Moon02Icon");
export const MoreHorizontal = createIcon("MoreHorizontalIcon");
export const MoreHorizontalIcon = createIcon("MoreHorizontalIcon");
export const Palette = createIcon("PaintBrush02Icon");
export const PanelLeft = createIcon("PanelLeftIcon");
export const PanelLeftOpen = createIcon("PanelLeftOpenIcon");
export const PanelRight = createIcon("PanelRightIcon");
export const PanelRightClose = createIcon("PanelRightCloseIcon");
export const Paperclip = createIcon("AttachmentIcon");
export const Pencil = createIcon("PencilEdit01Icon");
export const PencilLine = createIcon("PencilEdit02Icon");
export const Pin = createIcon("PinIcon");
export const Play = createIcon("PlayIcon");
export const Plus = createIcon("Add01Icon");
export const RefreshCcw = createIcon("ReloadIcon");
export const Rocket = createIcon("Rocket01Icon");
export const RotateCcw = createIcon("ReloadIcon");
export const Save = createIcon("FloppyDiskIcon");
export const Search = createIcon("Search01Icon");
export const SendHorizontal = createIcon("SentIcon");
export const Server = createIcon("ServerStack01Icon");
export const Settings = createIcon("Settings01Icon");
export const ShieldCheck = createIcon("SecurityCheckIcon");
export const ShieldQuestion = createIcon("SecurityIcon");
export const SlidersHorizontal = createIcon("SlidersHorizontalIcon");
export const Sparkles = createIcon("StarIcon");
export const Square = createIcon("SquareIcon");
export const Sun = createIcon("Sun03Icon");
export const Terminal = createIcon("TerminalIcon");
export const Trash2 = createIcon("Delete02Icon");
export const UserRound = createIcon("UserCircleIcon");
export const Wrench = createIcon("Wrench01Icon");
export const X = createIcon("Cancel01Icon");
export const XIcon = createIcon("Cancel01Icon");

// Generic Icon component for custom usage
export function Icon({ size = 24, ...props }: HugeiconsIconProps) {
  return <HugeiconsIcon size={size} {...props} />;
}
