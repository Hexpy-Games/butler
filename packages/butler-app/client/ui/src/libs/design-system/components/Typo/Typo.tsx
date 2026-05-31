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
  | "code";

export interface TypoProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  as?: TypoElement;
  htmlFor?: string;
}

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function createTypo(defaultAs: TypoElement, variantClassName: string) {
  return function TypoVariant({
    as: Component = defaultAs,
    className,
    children,
    ...props
  }: TypoProps) {
    return (
      <Component className={classNames(variantClassName, className)} {...props}>
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
  AppTitle,
  PanelTitle,
  DashboardTitle,
  SectionTitle,
  PanelSectionTitle,
  MetricValue,
};

export default Typo;
