import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";

import { cn } from "../../lib/utils";
import styles from "../../components/Separator/Separator.module.css";

type SeparatorTone = "default" | "strong" | "muted" | "accent";
type SeparatorSpace = "none" | "xs" | "sm" | "md" | "lg";

interface SeparatorProps
  extends React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root> {
  line?: boolean;
  space?: SeparatorSpace;
  tone?: SeparatorTone;
}

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  line = true,
  space = "sm",
  tone = "default",
  ...props
}: SeparatorProps) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      data-line={line ? "true" : "false"}
      data-space={space}
      data-tone={tone}
      decorative={decorative}
      orientation={orientation}
      className={cn(styles.separator, className)}
      {...props} />
  );
}

export { Separator };
