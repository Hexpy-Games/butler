import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { DsBaseProps } from "../../lib/dsProps";
import styles from "./Typo.module.css";

type TypoElement = "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "div" | "p" | "span" | "label" | "code" | "strong";

export type TypoTone = "primary" | "secondary" | "tertiary" | "disabled" | "danger" | "success" | "warning" | "inherit";
export type TypoWeight = "regular" | "medium" | "semibold";
export type TypoWrap = "normal" | "nowrap" | "anywhere" | "pre";

/** Text props shared by every variant. None of them change the type scale. */
export interface TypoProps extends DsBaseProps<HTMLAttributes<HTMLElement>> {
  children: ReactNode;
  as?: TypoElement;
  /** Semantic text color. Omit to inherit the container color. */
  tone?: TypoTone;
  weight?: TypoWeight;
  align?: "start" | "center" | "end";
  /** One line with an ellipsis. */
  truncate?: boolean;
  lineClamp?: 2 | 3 | 4 | 5;
  wrap?: TypoWrap;
  numeric?: "tabular";
}

function createTypo(defaultAs: TypoElement, variantClassName: string | undefined) {
  return function TypoVariant({
    as: Component = defaultAs,
    children,
    tone,
    weight,
    align,
    truncate,
    lineClamp,
    wrap,
    numeric,
    ...props
  }: TypoProps) {
    return (
      <Component
        className={cn(styles.typo, variantClassName)}
        data-tone={tone}
        data-weight={weight}
        data-align={align}
        data-truncate={truncate ? "true" : undefined}
        data-line-clamp={lineClamp}
        data-wrap={wrap}
        data-numeric={numeric}
        {...props}
      >
        {children}
      </Component>
    );
  };
}

export const Typo = {
  H1: createTypo("h1", styles.h1),
  H2: createTypo("h2", styles.h2),
  H3: createTypo("h3", styles.h3),
  H4: createTypo("h4", styles.h4),
  H5: createTypo("h5", styles.h5),
  H6: createTypo("h6", styles.h6),
  Body: createTypo("p", styles.body),
  Caption: createTypo("span", styles.caption),
  Label: createTypo("span", styles.label),
  Code: createTypo("code", styles.code),
  /** Inherits the container's font; applies text props only. */
  Text: createTypo("span", styles.text),
  AppTitle: createTypo("span", styles["app-title"]),
  SectionTitle: createTypo("span", styles["section-title"]),
};
