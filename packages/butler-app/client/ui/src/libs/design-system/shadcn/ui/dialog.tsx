"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cn } from "../../lib/utils";
import { Button } from "./button";
import { XIcon } from "../../components/Icons";
import {
  tintedGlassSurfaceClassName,
  type TintedGlassRadius,
} from "../../components/TintedGlass";
import styles from "../../components/Dialog/Dialog.module.css";

function Dialog({
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        styles.overlay,
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  glassRadius = "composer",
  showCloseButton = true,
  closeLabel,
  motion = "dialog",
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  glassRadius?: TintedGlassRadius;
  showCloseButton?: boolean;
  /** `palette`: the command palette's quicker scale-in and backdrop fade. */
  motion?: "dialog" | "palette";
  /** Localized accessible name for the close button; callers pass app copy. */
  closeLabel?: string;
}) {
  return (
    <DialogPortal>
      <DialogOverlay data-motion={motion} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-motion={motion}
        data-glass="popover"
        data-radius={glassRadius}
        data-surface="tinted-glass"
        className={cn(
          tintedGlassSurfaceClassName,
          styles.content,
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className={styles.close}
              size="icon-sm"
            >
              <XIcon />
              <span className="sr-only">{closeLabel}</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(styles.header, className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  closeLabel,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & {
  showCloseButton?: boolean;
  /** Localized close button text; callers pass app copy. */
  closeLabel?: string;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        styles.footer,
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">{closeLabel}</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(styles.title, className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        styles.description,
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
