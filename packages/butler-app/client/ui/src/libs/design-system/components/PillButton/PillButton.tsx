import type { DsBaseProps } from "../../lib/dsProps";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { Button } from "../Button";
import styles from "./PillButton.module.css";
import { dsClass } from "../../lib/internal";

interface PillActionProps
 extends DsBaseProps<ButtonHTMLAttributes<HTMLButtonElement>> {
  as?: "button";
  children: ReactNode;
  icon?: ReactNode;
  stretch?: boolean;
  surface?: "plain" | "glass";
}

interface PillSurfaceProps extends DsBaseProps<HTMLAttributes<HTMLSpanElement>> {
  as: "span";
  surface: "glass";
  children: ReactNode;
}

export type PillButtonProps = PillActionProps | PillSurfaceProps;

export function PillButton(props: PillButtonProps) {
  if (props.as === "span") {
    const { as: Element, surface: _surface, className, ...rest } = props;
    return <Element className={dsClass(styles.surface, styles.glass, className)} data-surface="glass-pill" {...rest} />;
  }
  return <PillAction {...props} />;
}

function PillAction({
  as: _as,
  children,
  icon,
  stretch = false,
  surface = "plain",
  className,
  type = "button",
  ...props
}: PillActionProps) {
  const hasIconText = icon != null && children != null;

  return (
    <Button
      className={dsClass(hasIconText && styles.withIconText, surface === "glass" && styles.glass, className)}
      data-surface={surface === "glass" ? "glass-pill" : undefined}
      iconStart={icon}
      shape="pill"
      stretch={stretch}
      text={children}
      type={type}
      variant="borderless"
      {...props}
    />
  );
}
