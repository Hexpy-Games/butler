import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Typo.module.css";

type TypoElement =
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "div"
  | "p"
  | "span"
  | "label"
  | "code"
  | "time";

export type TypoTone =
  | "primary"
  | "secondary"
  | "tertiary"
  | "disabled"
  | "danger"
  | "success"
  | "warning"
  | "inherit";
export type TypoWeight = "regular" | "medium" | "semibold";
export type TypoAlign = "start" | "center" | "end";
export type TypoLineClamp = 2 | 3 | 4;
export type TypoWrap = "normal" | "nowrap" | "anywhere";
export type TypoNumeric = "tabular";

/** Text props shared by every Typo variant. None of them change the type scale. */
export interface TypoTextProps {
  /** Semantic text color. Omit to inherit the container color. */
  tone?: TypoTone;
  weight?: TypoWeight;
  align?: TypoAlign;
  /** One line with an ellipsis; the element becomes a block with `min-width: 0`. */
  truncate?: boolean;
  lineClamp?: TypoLineClamp;
  wrap?: TypoWrap;
  numeric?: TypoNumeric;
}

export interface TypoProps extends HTMLAttributes<HTMLElement>, TypoTextProps {
  children: ReactNode;
  as?: TypoElement;
  htmlFor?: string;
  dateTime?: string;
}

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function createTypo(defaultAs: TypoElement, variantClassName: string) {
  return function TypoVariant({
    as: Component = defaultAs,
    className,
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
        className={classNames(styles.typo, variantClassName, className)}
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

export const H1 = createTypo("h1", styles.h1);
export const H2 = createTypo("h2", styles.h2);
export const H3 = createTypo("h3", styles.h3);
export const H4 = createTypo("h4", styles.h4);
export const H5 = createTypo("h5", styles.h5);
export const H6 = createTypo("h6", styles.h6);
export const Body = createTypo("p", styles.body);
export const Caption = createTypo("span", styles.caption);
export const Label = createTypo("label", styles.label);
export const Code = createTypo("code", styles.code);
/** Inherits the container's font size, weight and line-height; applies text props only. */
export const Text = createTypo("span", styles.text);

export const AppTitle = createTypo("span", styles["app-title"]);
export const PanelTitle = createTypo("span", styles["panel-title"]);
export const DashboardTitle = createTypo("span", styles["dashboard-title"]);
export const SectionTitle = createTypo("span", styles["section-title"]);
export const PanelSectionTitle = createTypo(
  "span",
  styles["panel-section-title"],
);
export const MetricValue = createTypo("span", styles["metric-value"]);

export const Typo = {
  H1,
  H2,
  H3,
  H4,
  H5,
  H6,
  Body,
  Caption,
  Label,
  Code,
  Text,
  AppTitle,
  PanelTitle,
  DashboardTitle,
  SectionTitle,
  PanelSectionTitle,
  MetricValue,
};

export default Typo;
