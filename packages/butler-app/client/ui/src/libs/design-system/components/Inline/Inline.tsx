import { Stack, type StackProps } from "../Stack";

export interface InlineProps extends Omit<StackProps, "align" | "wrap"> {
  /** Wrap onto new lines when the row runs out of space (default true). */
  wrap?: boolean;
}

/** Row preset of Stack: horizontal, cross-axis centered, wrapping, small gap. */
export function Inline({ wrap = true, cross = "center", gap = "sm", ...props }: InlineProps) {
  return <Stack align="row" cross={cross} gap={gap} wrap={wrap} {...props} />;
}

export default Inline;
