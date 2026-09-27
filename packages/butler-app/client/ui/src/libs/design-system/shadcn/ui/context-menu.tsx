"use client";

import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";

import { cn } from "../../lib/utils";
import { usePopperExitFreezeRef } from "../../lib/popperExit";
import { floatingContentCollisionPadding } from "../../lib/floatingConstraints";
import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import styles from "../../components/ContextMenu/ContextMenu.module.css";

function ContextMenu({
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Root>>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Trigger>>) {
  return (
    <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
  );
}

function ContextMenuContent({
  className,
  ref,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>> & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  const contentRef = usePopperExitFreezeRef(ref);
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        ref={contentRef}
        data-slot="context-menu-content"
        data-glass="popover"
        data-radius="popover"
        collisionPadding={floatingContentCollisionPadding}
        className={cn(tintedGlassSurfaceClassName, styles.content, className)}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item>> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(styles.item, className)}
      {...props}
    />
  );
}

export { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger };
