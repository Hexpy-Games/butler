import type { DsBaseProps } from "../../lib/dsProps";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import type * as React from "react";
import { cn } from "../../lib/utils";
import { useScrollEdges } from "../../lib/useScrollEdges";
import styles from "./Tabs.module.css";
import { TabsIndicator } from "./TabsIndicator";

type TabsListVariant = "default" | "line";

type TabsGap = "sm" | "md" | "lg" | "xl" | "2xl";

function Tabs({
  className,
  orientation = "horizontal",
  gap,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>> & {
  /** Space between the tab list and its panels. */
  gap?: TabsGap;
}) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      data-gap={gap}
      className={cn(
        styles.root,
        styles[`orientation-${orientation}`],
        className,
      )}
      orientation={orientation}
      {...props}
    />
  );
}

function tabsListVariants({
  variant = "default",
}: { variant?: TabsListVariant | null } = {}) {
  return cn(styles.list, styles[`variant-${variant ?? "default"}`]);
}

function TabsList({
  className,
  variant = "default",
  stretch = false,
  children,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>> & {
  variant?: TabsListVariant;
  stretch?: boolean;
}) {
  const listFadeRef = useScrollEdges("x");
  return (
    <TabsPrimitive.List
      ref={listFadeRef}
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(
        tabsListVariants({ variant }),
        stretch && styles.stretch,
        className,
      )}
      {...props}
    >
      {children}
      {variant === "line" ? <TabsIndicator /> : null}
    </TabsPrimitive.List>
  );
}

function TabsTrigger({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(styles.trigger, className)}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(styles.content, className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
