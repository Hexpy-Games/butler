import type { DsBaseProps } from "../../lib/dsProps";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./KeyValueRow.module.css";
import { dsClass } from "../../lib/internal";
import { useKeyValueRowLink } from "./useKeyValueRowLink";

export interface KeyValueRowProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  label: ReactNode;
  value: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  swatch?: ReactNode;
  swatchColor?: string;
  /** hatched: the swatchColor subtask hatch of UsageBars (light stripes at --hatch-alpha). Default solid. */
  swatchPattern?: "solid" | "hatched";
  /**
   * Links the row to a chart: the row becomes a focusable group named by its
   * label and value, and reports mouse hover and keyboard focus (true) and
   * their end (false), so the chart can emphasize the series this row names.
   */
  onHighlightChange?: (highlighted: boolean) => void;
  valueTextSize?: "body" | "caption";
  detailAlign?: "center" | "start";
  detailLayout?: "row" | "stack";
}

/** The 10px round swatch on the label line: custom content, or swatchColor solid or hatched. */
function KeyValueSwatch({ swatch, swatchColor, swatchPattern }: Pick<KeyValueRowProps, "swatch" | "swatchColor" | "swatchPattern">) {
  return (
    <span
      className={styles.swatch}
      data-test-class="key-value-swatch"
      style={
        swatchColor
          ? ({ "--swatch-color": swatchColor } as CSSProperties)
          : undefined
      }
    >
      {swatch ?? <span className={styles["color-swatch"]} data-pattern={swatchPattern} />}
    </span>
  );
}

export function KeyValueRow({
  label,
  value,
  description,
  meta,
  swatch,
  swatchColor,
  swatchPattern = "solid",
  onHighlightChange,
  valueTextSize = "body",
  detailAlign = "center",
  detailLayout = "row",
  className,
  ...props
}: KeyValueRowProps) {
  const link = useKeyValueRowLink(onHighlightChange, props);
  const hasSwatch = Boolean(swatch || swatchColor);
  const ValueText = valueTextSize === "caption" ? Typo.Caption : Typo.Body;
  const isDetailStacked = detailLayout === "stack";

  return (
    <div
      className={cn(styles.row, hasSwatch && styles.hasSwatch, className)}
      data-test-class="key-value-row"
      {...props}
      {...link.rowProps}
    >
      <Stack
        align="row"
        justify="between"
        cross="baseline"
        gap="sm"
        className={dsClass(styles.mainRow)}
        data-test-class="key-value-label-row"
      >
        <span
          className={styles.labelGroup}
          data-test-class="key-value-label-group"
        >
          {hasSwatch ? <KeyValueSwatch swatch={swatch} swatchColor={swatchColor} swatchPattern={swatchPattern} /> : null}
          <Typo.Caption
            id={link.labelId}
            className={dsClass(styles.label)}
            data-test-class="key-value-label"
          >
            {label}
          </Typo.Caption>
        </span>
        <ValueText
          id={link.valueId}
          className={dsClass(styles.value, valueTextSize === "caption" ? styles.valueCaption : styles.valueBody)}
          data-test-class="key-value-value"
        >
          {value}
        </ValueText>
      </Stack>
      {description || meta ? (
        <Stack
          align={isDetailStacked ? "column" : "row"}
          justify={isDetailStacked ? "start" : "between"}
          cross={isDetailStacked ? "start" : detailAlign}
          gap={isDetailStacked ? "xs" : "sm"}
          className={dsClass(styles.detailRow, isDetailStacked && styles.detailStack)}
          data-test-class="key-value-detail-row"
        >
          {description ? (
            <Typo.Caption className={dsClass(styles.description)} data-test-class="key-value-description">{description}</Typo.Caption>
          ) : null}
          {meta ? (
            <Typo.Caption className={dsClass(styles.meta)} data-test-class="key-value-meta">{meta}</Typo.Caption>
          ) : null}
        </Stack>
      ) : null}
    </div>
  );
}
