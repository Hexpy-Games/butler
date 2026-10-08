"use client";

import type { DsBaseProps } from "../../lib/dsProps";
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
import { dsClass } from "../../lib/internal";

function Dialog({
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Portal>>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>>) {
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

/** Dialog widths (`--dialog-width-*`); every size stays inside the viewport gutter. */
export type DialogSize = "sm" | "md" | "lg" | "xl" | "full";
/**
 * `flow`: children stack with the dialog gap and the whole dialog scrolls.
 * `scroll-body`: header, one scrolling body (a `ScrollArea fill`) and footer;
 * the dialog itself does not scroll.
 */
export type DialogLayout = "flow" | "scroll-body";

/** Data attributes DialogContent sets for its size props (read by Dialog.module.css). */
export function dialogContentAttributes({ size = "sm", layout = "flow", maxHeight = "full" }: {
  size?: DialogSize;
  layout?: DialogLayout;
  maxHeight?: "full" | "3/5";
}) {
  return {
    "data-size": size,
    "data-layout": layout,
    "data-max-height": maxHeight === "full" ? undefined : maxHeight,
  };
}

function DialogContent({
  className,
  children,
  glassRadius = "composer",
  showCloseButton = true,
  closeLabel,
  motion = "dialog",
  size = "sm",
  layout = "flow",
  maxHeight = "full",
  container,
  onInteractOutside,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>> & {
  glassRadius?: TintedGlassRadius;
  showCloseButton?: boolean;
  /** `palette`: the command palette's quicker scale-in and backdrop fade. */
  motion?: "dialog" | "palette";
  /** Localized accessible name for the close button; callers pass app copy. */
  closeLabel?: string;
  size?: DialogSize;
  layout?: DialogLayout;
  /** `3/5`: at most 60% of the viewport height (live transcripts). */
  maxHeight?: "full" | "3/5";
  /**
   * Anchors the dialog inside this element (a page card) instead of the window: it sits near the
   * container's top and its scrim covers only the container (which must be positioned). Pair it with
   * `<Dialog modal={false}>` so the rest of the app stays usable; outside clicks do not dismiss it.
   */
  container?: HTMLElement | null;
}) {
  const contained = container !== undefined;
  return (
    <DialogPortal container={container ?? undefined}>
      {contained
        ? <div className={styles.overlay} data-slot="dialog-overlay" data-contained="" data-state="open" aria-hidden="true" />
        : <DialogOverlay data-motion={motion} />}
      <DialogPrimitive.Content
        data-contained={contained ? "" : undefined}
        onInteractOutside={contained ? (event) => { onInteractOutside?.(event); event.preventDefault(); } : onInteractOutside}
        data-slot="dialog-content"
        data-motion={motion}
        data-glass="popover"
        data-radius={glassRadius}
        data-surface="tinted-glass"
        {...dialogContentAttributes({ size, layout, maxHeight })}
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
              className={dsClass(styles.close)}
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
}: DsBaseProps<React.ComponentPropsWithoutRef<"div">>) {
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
}: DsBaseProps<React.ComponentPropsWithoutRef<"div">> & {
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
  visuallyHidden = false,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>> & {
  /** Keep the accessible name but hide the title (the dialog shows its own heading). */
  visuallyHidden?: boolean;
}) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(visuallyHidden ? "sr-only" : styles.title, className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>>) {
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
