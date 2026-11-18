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
import SquareIcon from "@hugeicons/core-free-icons/SquareIcon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";

export const icons = {
  Plus: Add01Icon,
  X: Cancel01Icon,
  CheckIcon: Tick02Icon,
  ChevronRight: ArrowRight01Icon,
  ArrowLeft: ArrowLeft01Icon,
  SendHorizontal: SentIcon,
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
