import type { DsBaseProps } from "../../lib/dsProps";
/**
 * Icon wrapper for Butler UI
 * Maps Butler UI icon names to Hugeicons alternatives.
 * Preserves simple <Icon size={...} /> usage pattern
 */

import { HugeiconsIcon } from "@hugeicons/react";
import type { HugeiconsIconProps, IconSvgElement } from "@hugeicons/react";
// Named imports keep the bundle to the glyphs mapped below.
import {
  Activity01Icon, Add01Icon, AiChipIcon, AlertCircleIcon, ArchiveIcon, ArrowDown01Icon,
  ArrowLeft01Icon, ArrowRight01Icon, ArrowUp01Icon, ArrowUpDownIcon, AttachmentIcon,
  BookOpen01Icon, BotIcon, Briefcase01Icon, BubbleChatIcon, Cancel01Icon, CancelCircleIcon,
  CheckmarkCircle02Icon, CircleIcon, Clock03Icon, CollapseIcon, CommandIcon, ComputerIcon,
  Copy01Icon, CubeIcon, DatabaseIcon, Delete02Icon, DragDropVerticalIcon, ExpandIcon, File02Icon,
  FilterIcon, FloppyDiskIcon, Folder01Icon, Folder02Icon, FolderAddIcon, GitBranchIcon,
  Globe02Icon, Image01Icon, LayoutGridIcon, LockIcon, MagicWand01Icon, McpServerIcon, Message01Icon,
  MessageAdd01Icon, MinusSignIcon, Moon02Icon, MoreHorizontalIcon as MoreHorizontalGlyph,
  Note01Icon, PaintBrush02Icon, PanelLeftIcon, PanelLeftOpenIcon, PanelRightCloseIcon,
  PanelRightIcon, PencilEdit01Icon, PencilEdit02Icon, PinIcon, PlayIcon, ReloadIcon,
  Rocket01Icon, Search01Icon, SecurityCheckIcon, SecurityIcon, SentIcon, ServerStack01Icon,
  Settings01Icon, SlidersHorizontalIcon, SquareIcon, StarIcon, Sun03Icon, Task01Icon,
  TerminalIcon, Tick02Icon, Time03Icon, UserCircleIcon, ViewIcon, Wrench01Icon,
} from "@hugeicons/core-free-icons";

/** Icon size scale; mirrors --icon-size-sm/md/lg in tokens.css. */
export const ICON_SIZE = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24, "2xl": 32 } as const;
export type IconSize = keyof typeof ICON_SIZE;

// Icon component props extending Hugeicons with simplified API
export interface IconProps extends Omit<DsBaseProps<HugeiconsIconProps>, "icon" | "size"> {
  size?: IconSize | number;
}

// Helper to create icon component
function createIcon(icon: IconSvgElement) {
  return ({ size = "md", ...props }: IconProps) => (
    <HugeiconsIcon
      icon={icon}
      size={typeof size === "string" ? ICON_SIZE[size] : size}
      {...props}
    />
  );
}

// Export individual icon components. A glyph is mapped once; alternate
// names (kept for shadcn-style call sites) alias the same component.
export const Activity = createIcon(Activity01Icon);
export const AiChip = createIcon(AiChipIcon);
export const AlertCircle = createIcon(AlertCircleIcon);
export const Archive = createIcon(ArchiveIcon);
export const CheckCircle2 = createIcon(CheckmarkCircle02Icon);
export const CircleAlert = AlertCircle;
export const CircleX = createIcon(CancelCircleIcon);
export const ListFilter = createIcon(FilterIcon);
export const ArrowLeft = createIcon(ArrowLeft01Icon);
export const Blocks = createIcon(CubeIcon);
export const BookOpenText = createIcon(BookOpen01Icon);
export const Bot = createIcon(BotIcon);
export const Briefcase = createIcon(Briefcase01Icon);
export const CheckIcon = createIcon(Tick02Icon);
export const ChevronDown = createIcon(ArrowDown01Icon);
export const ChevronDownIcon = ChevronDown;
export const ChevronRight = createIcon(ArrowRight01Icon);
export const ChevronRightIcon = ChevronRight;
export const ChevronUpIcon = createIcon(ArrowUp01Icon);
export const ChevronsUpDown = createIcon(ArrowUpDownIcon);
export const Collapse = createIcon(CollapseIcon);
export const Circle = createIcon(CircleIcon);
export const Clock3 = createIcon(Clock03Icon);
export const Command = createIcon(CommandIcon);
export const Copy = createIcon(Copy01Icon);
export const Database = createIcon(DatabaseIcon);
/** Six-dot vertical grip for drag handles (sortable rows and cards). */
export const GripVertical = createIcon(DragDropVerticalIcon);
export const DragHandle = GripVertical;
export const Eye = createIcon(ViewIcon);
export const Expand = createIcon(ExpandIcon);
export const FileText = createIcon(File02Icon);
export const Folder = createIcon(Folder01Icon);
export const FolderOpen = createIcon(Folder02Icon);
export const FolderPlus = createIcon(FolderAddIcon);
export const GitBranch = createIcon(GitBranchIcon);
export const Globe2 = createIcon(Globe02Icon);
export const History = createIcon(Time03Icon);
export const ImageIcon = createIcon(Image01Icon);
export const LayoutDashboard = createIcon(LayoutGridIcon);
export const Lock = createIcon(LockIcon);
export const MagicWand = createIcon(MagicWand01Icon);
export const McpServer = createIcon(McpServerIcon);
export const ListChecks = createIcon(Task01Icon);
export const MessageSquarePlus = createIcon(MessageAdd01Icon);
export const MessageSquare = createIcon(Message01Icon);
export const GeneralChat = createIcon(BubbleChatIcon);
export const Notebook = createIcon(Note01Icon);
export const Minus = createIcon(MinusSignIcon);
export const Monitor = createIcon(ComputerIcon);
export const Moon = createIcon(Moon02Icon);
export const MoreHorizontal = createIcon(MoreHorizontalGlyph);
export const MoreHorizontalIcon = MoreHorizontal;
export const Palette = createIcon(PaintBrush02Icon);
export const PanelLeft = createIcon(PanelLeftIcon);
export const PanelLeftOpen = createIcon(PanelLeftOpenIcon);
export const PanelRight = createIcon(PanelRightIcon);
export const PanelRightClose = createIcon(PanelRightCloseIcon);
export const Paperclip = createIcon(AttachmentIcon);
export const Pencil = createIcon(PencilEdit01Icon);
export const PencilLine = createIcon(PencilEdit02Icon);
export const Pin = createIcon(PinIcon);
export const Play = createIcon(PlayIcon);
export const Plus = createIcon(Add01Icon);
export const RefreshCcw = createIcon(ReloadIcon);
export const Rocket = createIcon(Rocket01Icon);
export const RotateCcw = RefreshCcw;
export const Save = createIcon(FloppyDiskIcon);
export const Search = createIcon(Search01Icon);
export const SendHorizontal = createIcon(SentIcon);
export const Server = createIcon(ServerStack01Icon);
export const Settings = createIcon(Settings01Icon);
export const ShieldCheck = createIcon(SecurityCheckIcon);
export const ShieldQuestion = createIcon(SecurityIcon);
export const SlidersHorizontal = createIcon(SlidersHorizontalIcon);
export const Sparkles = createIcon(StarIcon);
export const Square = createIcon(SquareIcon);
export const Sun = createIcon(Sun03Icon);
export const Terminal = createIcon(TerminalIcon);
export const Trash2 = createIcon(Delete02Icon);
export const UserRound = createIcon(UserCircleIcon);
export const Wrench = createIcon(Wrench01Icon);
export const X = createIcon(Cancel01Icon);
export const XIcon = X;

// Generic Icon component for custom usage
export function Icon({ size = 24, ...props }: DsBaseProps<HugeiconsIconProps>) {
  return <HugeiconsIcon size={size} {...props} />;
}
