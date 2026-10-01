import type { DsBaseProps } from "../../lib/dsProps";
import * as React from "react";
import { cn } from "../../lib/utils";
import { useScrollEdges } from "../../lib/useScrollEdges";
import { useTextareaGrow } from "../../lib/useTextareaGrow";
import underline from "../../components/Input/UnderlineField.module.css";
import styles from "../../components/Textarea/Textarea.module.css";

function Textarea({
  className, variant = "default", textSize = "inherit", onChange, ...props
}: DsBaseProps<React.ComponentPropsWithoutRef<"textarea">> & {
  /** Wrapping in-place entry, growing from one line to the DS line cap. */
  variant?: "default" | "underline";
  textSize?: "inherit" | "label";
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const grow = useTextareaGrow(ref, variant === "underline", props.value);
  const edges = useScrollEdges("y", variant === "underline");
  const attach = React.useCallback((element: HTMLTextAreaElement | null) => {
    ref.current = element;
    return edges(element);
  }, [edges]);
  const textarea = <textarea {...props} ref={attach} rows={variant === "underline" ? 1 : props.rows}
    data-slot="textarea" data-variant={variant}
    className={cn(styles.textarea, variant === "underline" && underline.field, className)}
    onChange={(event) => { grow(); onChange?.(event); }} />;
  return variant === "underline"
    ? <span className={cn(underline.inlineField, underline.multiline)} data-text-size={textSize}>{textarea}</span>
    : textarea;
}

export { Textarea };
