"use client";

import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";

import { cn } from "../../lib/utils";
import { floatingContentCollisionPadding } from "../../lib/floatingConstraints";
import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import styles from "../../components/ContextMenu/ContextMenu.module.css";

function ContextMenu({
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Trigger>) {
  return (
    <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
  );
}

function ContextMenuContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
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
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
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
