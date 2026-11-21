// One default import per glyph: the package index re-exports ~5,000 files and must never be imported.
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import AttachmentIcon from "@hugeicons/core-free-icons/AttachmentIcon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import Clock03Icon from "@hugeicons/core-free-icons/Clock03Icon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import Message01Icon from "@hugeicons/core-free-icons/Message01Icon";
import SecurityCheckIcon from "@hugeicons/core-free-icons/SecurityCheckIcon";
import SentIcon from "@hugeicons/core-free-icons/SentIcon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import SquareIcon from "@hugeicons/core-free-icons/SquareIcon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";

import Briefcase01Icon from "@hugeicons/core-free-icons/Briefcase01Icon";
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";
import Image01Icon from "@hugeicons/core-free-icons/Image01Icon";
import File01Icon from "@hugeicons/core-free-icons/File01Icon";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowUp01Icon from "@hugeicons/core-free-icons/ArrowUp01Icon";
import Notebook01Icon from "@hugeicons/core-free-icons/Notebook01Icon";
import RotateLeft01Icon from "@hugeicons/core-free-icons/RotateLeft01Icon";

import PencilEdit01Icon from "@hugeicons/core-free-icons/PencilEdit01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import BookOpen01Icon from "@hugeicons/core-free-icons/BookOpen01Icon";
import BubbleChatAddIcon from "@hugeicons/core-free-icons/BubbleChatAddIcon";
import FolderAddIcon from "@hugeicons/core-free-icons/FolderAddIcon";
import Archive02Icon from "@hugeicons/core-free-icons/Archive02Icon";
import Flag01Icon from "@hugeicons/core-free-icons/Flag01Icon";
import Ticket01Icon from "@hugeicons/core-free-icons/Ticket01Icon";

export const icons = {
  Archive: Archive02Icon,
  Flag: Flag01Icon,
  Ticket: Ticket01Icon,
  Document: BookOpen01Icon,
  BranchChat: BubbleChatAddIcon,
  BranchProject: FolderAddIcon,
  Edit: PencilEdit01Icon,
  Delete: Delete02Icon,
  Briefcase: Briefcase01Icon,
  Copy: Copy01Icon,
  Info: InformationCircleIcon,
  Image: Image01Icon,
  File: File01Icon,
  ChevronDown: ArrowDown01Icon,
  ChevronUp: ArrowUp01Icon,
  Notebook: Notebook01Icon,
  Retry: RotateLeft01Icon,

  Plus: Add01Icon,
  X: Cancel01Icon,
  CheckIcon: Tick02Icon,
  ChevronRight: ArrowRight01Icon,
  ArrowLeft: ArrowLeft01Icon,
  SendHorizontal: SentIcon,
  Settings: Settings01Icon,
  Square: SquareIcon,
  AlertCircle: AlertCircleIcon,
  CheckCircle2: CheckmarkCircle02Icon,
  MessageSquare: Message01Icon,
  Folder: Folder01Icon,
  ShieldCheck: SecurityCheckIcon,
  Clock3: Clock03Icon,
  Paperclip: AttachmentIcon,
} as const;

export type IconGlyph = (typeof icons)[keyof typeof icons];
