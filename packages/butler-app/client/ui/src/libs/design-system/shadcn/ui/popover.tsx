import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "../../lib/utils";
import { adaptiveShellThemeClasses, type AdaptiveShellTheme } from "../../lib/theme";
import { usePopperExitFreezeRef } from "../../lib/popperExit";
import { floatingContentCollisionPadding } from "../../lib/floatingConstraints";
import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import styles from "../../components/Popover/Popover.module.css";

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
  sideOffset = 4,
  onCloseAutoFocus,
  onOpenAutoFocus,
  theme,
  width = "default",
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>> & {
  ref?: React.Ref<HTMLDivElement>;
  /** App theme for the portalled surface (it renders outside the themed shell). */
  theme?: AdaptiveShellTheme;
  /** `narrow`: min(280px, 100vw - 32px), for compact readouts such as usage. */
  width?: "default" | "narrow";
}) {
  const contentRef = usePopperExitFreezeRef(ref);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={contentRef}
        data-slot="popover-content"
        data-glass="popover"
        data-radius="popover"
        data-popover-width={width === "default" ? undefined : width}
        align={align}
        collisionPadding={floatingContentCollisionPadding}
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
        {...props}
      />
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
