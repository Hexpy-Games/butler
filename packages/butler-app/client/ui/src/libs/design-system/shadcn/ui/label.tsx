"use client";

import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";

import { cn } from "../../lib/utils";
import styles from "../../components/Label/Label.module.css";

function Label({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(styles.label, className)}
      {...props} />
  );
}

export { Label };
