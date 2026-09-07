import * as TabsPrimitive from "@radix-ui/react-tabs";
import type * as React from "react";
import { cn } from "../../lib/utils";
import styles from "./Tabs.module.css";

type TabsListVariant = "default" | "line";

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
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
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & {
  variant?: TabsListVariant;
  stretch?: boolean;
}) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(
        tabsListVariants({ variant }),
        stretch && styles.stretch,
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) {
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
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(styles.content, className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
