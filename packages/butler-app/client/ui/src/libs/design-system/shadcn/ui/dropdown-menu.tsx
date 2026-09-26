"use client";

import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";

import { cn } from "../../lib/utils";
import { adaptiveShellThemeClasses, type AdaptiveShellTheme } from "../../lib/theme";
import { usePopperExitFreezeRef } from "../../lib/popperExit";
import { floatingContentCollisionPadding } from "../../lib/floatingConstraints";
import { CheckIcon, ChevronRightIcon } from "../../components/Icons";
import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import styles from "../../components/DropdownMenu/DropdownMenu.module.css";
import { dsClass } from "../../lib/internal";

function DropdownMenu({
  modal = false,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Root>>) {
  return (
    <DropdownMenuPrimitive.Root
      data-slot="dropdown-menu"
      modal={modal}
      {...props}
    />
  );
}

function DropdownMenuPortal({
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Portal>>) {
  return (
    <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
  );
}

function DropdownMenuTrigger({
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>>) {
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  );
}

function DropdownMenuContent({
  className,
  ref,
  align = "start",
  sideOffset = 4,
  theme,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>> & {
  ref?: React.Ref<HTMLDivElement>;
  /** App theme for the portalled surface (it renders outside the themed shell). */
  theme?: AdaptiveShellTheme;
}) {
  const contentRef = usePopperExitFreezeRef(ref);
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={contentRef}
        data-slot="dropdown-menu-content"
        data-glass="popover"
        data-radius="popover"
        sideOffset={sideOffset}
        align={align}
        collisionPadding={floatingContentCollisionPadding}
        className={cn(tintedGlassSurfaceClassName, styles.content, theme && adaptiveShellThemeClasses(theme), className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Group>>) {
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(styles.item, className)}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(styles.item, className)}
      checked={checked}
      {...props}
    >
      <span
        className={styles.indicator}
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioGroup>>) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(styles.item, className)}
      {...props}
    >
      <span
        className={styles.indicator}
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(styles.label, className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(styles.separator, className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"span">>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(styles.shortcut, className)}
      {...props}
    />
  );
}

function DropdownMenuSub({
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Sub>>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(styles.item, className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className={dsClass(styles.shortcut)} />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        data-slot="dropdown-menu-sub-content"
        data-glass="popover"
        data-radius="popover"
        collisionPadding={floatingContentCollisionPadding}
        className={cn(tintedGlassSurfaceClassName, styles.content, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
