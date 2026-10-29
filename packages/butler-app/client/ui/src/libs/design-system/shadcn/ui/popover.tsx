import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "../../lib/utils";
import { adaptiveShellThemeClasses, type AdaptiveShellTheme } from "../../lib/theme";
import { usePopperExitFreezeRef } from "../../lib/popperExit";
import { useComposedRefs } from "../../lib/composeRefs";
import { sheetSide, usePopoverSheet, useSheetCollisionPadding } from "../../lib/popoverSheet";
import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import styles from "../../components/Popover/Popover.module.css";
import { DEFAULT_OVERLAY_PRESENTATION, useSheetPresentation, type OverlayPresentation } from "../../lib/presentation";
import { PresentedSheetBody, PresentedSheetHandle, sheetContentProps } from "../../components/BottomSheet/SheetPresentation";

function Popover({
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Root>>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  ref,
  align = "center",
  side,
  sideOffset = 4,
  onCloseAutoFocus,
  onOpenAutoFocus,
  theme,
  width = "default",
  density = "default",
  presentation,
  children,
  onKeyDown,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>> & {
  ref?: React.Ref<HTMLDivElement>;
  /** App theme for the portalled surface (it renders outside the themed shell). */
  theme?: AdaptiveShellTheme;
  /**
   * `narrow`: min(280px, 100vw - 32px), for compact readouts such as usage.
   * `anchor`: exactly as wide as the `PopoverAnchor` (or trigger), at every viewport: a suggestion list under its field.
   */
  width?: "default" | "narrow" | "anchor";
  /** `list`: a 4px inset and no gap, for a list of rows (suggestions, options) that brings its own row padding. */
  density?: "default" | "list";
  /**
   * `auto`: a BottomSheet below 768px. `sheet`: always. `popover`: anchored. Defaults to the app-wide
   * default, except `width="anchor"`, which stays attached to its field.
   */
  presentation?: OverlayPresentation;
}) {
  const contentRef = usePopperExitFreezeRef(ref);
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);
  const sheetRef = useComposedRefs<HTMLDivElement>(ref, surfaceRef);
  const asSheet = useSheetPresentation(presentation ?? (width === "anchor" ? "popover" : DEFAULT_OVERLAY_PRESENTATION));
  // Mobile sheet (see Popover.module.css): left/right open below; keep clear of safe areas.
  const sheet = usePopoverSheet();
  const collisionPadding = useSheetCollisionPadding(sheet);
  if (asSheet) {
    // Focus moves into the sheet and returns to the trigger, unlike the anchored popover.
    return (
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={sheetRef}
          data-slot="popover-content"
          onCloseAutoFocus={onCloseAutoFocus}
          onOpenAutoFocus={onOpenAutoFocus}
          {...props}
          {...sheetContentProps(cn(theme && adaptiveShellThemeClasses(theme), className), onKeyDown)}
        >
          <PresentedSheetHandle surfaceRef={surfaceRef} />
          <PresentedSheetBody>{children}</PresentedSheetBody>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    );
  }
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={contentRef}
        data-slot="popover-content"
        data-glass="popover"
        data-radius="popover"
        data-popover-width={width === "default" ? undefined : width}
        data-popover-density={density === "default" ? undefined : density}
        align={align}
        side={sheetSide(sheet, side)}
        collisionPadding={collisionPadding}
        sideOffset={sideOffset}
        className={cn(tintedGlassSurfaceClassName, styles.content, theme && adaptiveShellThemeClasses(theme), className)}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (!event.defaultPrevented) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event);
          if (!event.defaultPrevented) event.preventDefault();
        }}
        onKeyDown={onKeyDown}
        {...props}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Anchor>>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverHeader({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"div">>) {
  return (
    <div
      data-slot="popover-header"
      className={cn(styles.header, className)}
      {...props}
    />
  );
}

function PopoverTitle({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"div">>) {
  return (
    <div
      data-slot="popover-title"
      className={cn(styles.title, className)}
      {...props}
    />
  );
}

function PopoverDescription({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"p">>) {
  return (
    <p
      data-slot="popover-description"
      className={cn(styles.description, className)}
      {...props}
    />
  );
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
};
