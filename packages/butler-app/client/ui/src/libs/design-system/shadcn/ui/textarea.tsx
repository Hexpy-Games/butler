import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";

import { cn } from "../../lib/utils";
import styles from "../../components/Textarea/Textarea.module.css";

function Textarea({
  className,
  ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"textarea">>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        styles.textarea,
        className,
      )}
      {...props} />
  );
}

export { Textarea };
