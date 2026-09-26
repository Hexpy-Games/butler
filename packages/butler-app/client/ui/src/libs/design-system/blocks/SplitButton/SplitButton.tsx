import type { ReactNode } from "react";
import { Button } from "../../components/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/DropdownMenu";
import { ChevronDown } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import styles from "./SplitButton.module.css";

export interface SplitButtonItem {
  key: string;
  label: ReactNode;
  /** Secondary lines under the label (each one wraps anywhere). */
  description?: ReactNode | readonly ReactNode[];
  onSelect: () => void;
  disabled?: boolean;
}

export interface SplitButtonProps {
  /** The primary action's label. */
  text: ReactNode;
  onClick: () => void;
  size?: "sm" | "default";
  variant?: "primary" | "outline";
  disabled?: boolean;
  /** Accessible name of the menu (arrow) button. */
  menuLabel: string;
  menuSide?: "top" | "bottom";
  items: readonly SplitButtonItem[];
}

/**
 * A primary action joined to a menu of related actions ("Allow once" plus
 * "Allow for this conversation"). The halves share one outline; the arrow is
 * a hit-target-wide button that opens the menu.
 */
export function SplitButton({
  text,
  onClick,
  size = "default",
  variant = "primary",
  disabled = false,
  menuLabel,
  menuSide = "bottom",
  items,
}: SplitButtonProps) {
  const buttonVariant = variant === "primary" ? "default" : "outline";
  const menuDisabled = disabled || items.every((item) => item.disabled);
  return (
    <span className={styles.split} role="group" data-slot="split-button">
      <Button type="button" className={styles.action} variant={buttonVariant} size={size} disabled={disabled} onClick={onClick}>
        {text}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" className={styles.arrow} variant={buttonVariant} size={size} disabled={menuDisabled} aria-label={menuLabel}>
            <ChevronDown aria-hidden="true" size="md" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side={menuSide} align="end" className={styles.menu}>
          {items.map((item) => {
            const lines = item.description === undefined ? [] : Array.isArray(item.description) ? item.description : [item.description];
            return (
              <DropdownMenuItem key={item.key} disabled={item.disabled} onSelect={item.onSelect}>
                <Stack as="span" gap="xs">
                  <span>{item.label}</span>
                  {lines.map((line, index) => (
                    <Typo.Caption key={index} tone="secondary" wrap="anywhere">{line}</Typo.Caption>
                  ))}
                </Stack>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
