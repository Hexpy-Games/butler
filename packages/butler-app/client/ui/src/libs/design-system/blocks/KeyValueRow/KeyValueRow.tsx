import type { DsBaseProps } from "../../lib/dsProps";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./KeyValueRow.module.css";
import { dsClass } from "../../lib/internal";

export interface KeyValueRowProps extends DsBaseProps<HTMLAttributes<HTMLDivElement>> {
  label: ReactNode;
  value: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  swatch?: ReactNode;
  swatchColor?: string;
  valueTextSize?: "body" | "caption";
  detailAlign?: "center" | "start";
  detailLayout?: "row" | "stack";
}

export function KeyValueRow({
  label,
  value,
  description,
  meta,
  swatch,
  swatchColor,
  valueTextSize = "body",
  detailAlign = "center",
  detailLayout = "row",
  className,
  ...props
}: KeyValueRowProps) {
  const hasSwatch = Boolean(swatch || swatchColor);
  const ValueText = valueTextSize === "caption" ? Typo.Caption : Typo.Body;
  const isDetailStacked = detailLayout === "stack";
  const swatchElement = hasSwatch ? (
    <span
      className={styles.swatch}
      data-test-class="key-value-swatch"
      style={
        swatchColor
          ? ({ "--swatch-color": swatchColor } as CSSProperties)
          : undefined
      }
    >
      {swatch ?? <span className={styles["color-swatch"]} />}
    </span>
  ) : null;

  return (
    <div
      className={cn(styles.row, hasSwatch && styles.hasSwatch, className)}
      data-test-class="key-value-row"
      {...props}
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
          {swatchElement}
          <Typo.Caption
            className={dsClass(styles.label)}
            data-test-class="key-value-label"
          >
            {label}
          </Typo.Caption>
        </span>
        <ValueText
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
            <Typo.Caption
              className={dsClass(styles.description)}
              data-test-class="key-value-description"
            >
              {description}
            </Typo.Caption>
          ) : null}
          {meta ? (
            <Typo.Caption
              className={dsClass(styles.meta)}
              data-test-class="key-value-meta"
            >
              {meta}
            </Typo.Caption>
          ) : null}
        </Stack>
      ) : null}
    </div>
  );
}
