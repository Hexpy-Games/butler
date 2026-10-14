import type { DsBaseProps } from "../../lib/dsProps";
import React, { useId } from "react";
import { Button } from "../Button";
import { Tooltip } from "../Tooltip";
import iconButtonStyles from "./IconButton.module.css";
import { dsClass, dsStyle } from "../../lib/internal";

void iconButtonStyles;

/** Icon colour only (never a fill): `butler` the Butler ink blue, `riso` the riso ink gradient (Butler is acting). */
export type IconButtonTone = "default" | "butler" | "riso";

interface IconButtonProps extends DsBaseProps<React.ButtonHTMLAttributes<HTMLButtonElement>> {
  label: string;
  selected?: boolean;
  /**
   * `top-end`: shift the button so its icon (not its hit area) lines up with
   * the top-end corner of the row, e.g. card header actions beside a title.
   */
  opticalAlign?: "top-end";
  tone?: IconButtonTone;
  /** A small riso dot at the top-end corner: Butler is acting on something this button shows. */
  indicator?: boolean;
  /** A count at the top-end corner (hidden at 0); the label should carry the count for screen readers. */
  badge?: number;
  /** Toggle state for assistive tech (`aria-pressed`); unlike `selected` it paints no fill. */
  pressed?: boolean;
}

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/** The riso gradient the `riso` tone strokes the icon with (one per button: SVG paint is referenced by id). */
function RisoPaint({ id }: { id: string }) {
  return (
    <svg className={iconButtonStyles.paint} width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="2" y1="2" x2="22" y2="22">
          <stop offset="0" stopColor="var(--butler-ink-blue)" />
          <stop offset="0.55" stopColor="var(--butler-ink-purple)" />
          <stop offset="1" stopColor="var(--butler-ink-pink)" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  children, className, label, selected, opticalAlign, onClick, disabled, tone = "default", indicator = false, badge, pressed,
  style, ...props
}, ref) {
  const paintId = `icon-button-riso-${useId().replace(/[^\w-]/gu, "")}`;
  const riso = tone === "riso";
  const count = badge && badge > 0 ? (badge > 99 ? "99+" : String(badge)) : null;
  const button = (
    <Button
      ref={ref}
      className={dsClass(classNames(
        iconButtonStyles.moduleScope,
        "icon-button",
        selected && iconButtonStyles.selected,
        className,
      ))}
      variant="ghost"
      size="icon-sm"
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      data-optical-align={opticalAlign}
      data-tone={tone === "default" ? undefined : tone}
      data-badge={count ? "" : undefined}
      onClick={onClick}
      disabled={disabled}
      title={undefined}
      style={riso ? dsStyle({ ...style, "--icon-button-riso-paint": `url(#${paintId})` }) : style}
      {...props}
    >
      {riso ? <RisoPaint id={paintId} /> : null}
      {children}
      {indicator ? <span className={iconButtonStyles.indicator} data-slot="icon-button-indicator" aria-hidden="true" /> : null}
      {count ? <span className={iconButtonStyles.badge} data-slot="icon-button-badge" aria-hidden="true">{count}</span> : null}
    </Button>
  );

  return props["aria-haspopup"] || props["aria-expanded"] !== undefined
    ? button
    : <Tooltip label={label}>{button}</Tooltip>;
});
