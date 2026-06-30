import { useState, type ReactNode } from "react";
import { MoreHorizontal } from "../../components/Icons";
import { IconButton } from "../../components/IconButton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/DropdownMenu";
import { cn } from "../../lib/utils";
import styles from "./OverflowActionMenu.module.css";

export interface OverflowActionMenuItem {
  /** Icon element */
  icon?: ReactNode;
  /** Menu item label */
  label: string;
  /** Selection handler */
  onSelect: () => void;
  /** Visual variant */
  variant?: "default" | "destructive";
}

export interface OverflowActionMenuProps {
  /** Menu items */
  items: OverflowActionMenuItem[];
  /** Accessible label for trigger button */
  label?: string;
  /** Controlled open state for row-context triggers */
  open?: boolean;
  /** Controlled open state change handler */
  onOpenChange?: (open: boolean) => void;
  /** Additional CSS class */
  className?: string;
}

export function OverflowActionMenu({
  items,
  label = "More actions",
  open,
  onOpenChange,
  className,
}: OverflowActionMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const menuOpen = open ?? internalOpen;
  const setMenuOpen = onOpenChange ?? setInternalOpen;

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <IconButton
          className={cn(styles.trigger, className)}
          label={label}
          selected={menuOpen}
        >
          <MoreHorizontal size={14} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onInteractOutside={() => setMenuOpen(false)}
        sideOffset={8}
      >
        {items.map((item, index) => (
          <DropdownMenuItem
            key={index}
            onSelect={item.onSelect}
            variant={item.variant}
          >
            {item.icon && item.icon} {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
