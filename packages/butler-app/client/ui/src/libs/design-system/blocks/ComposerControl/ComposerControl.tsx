import type { DsBaseProps } from "../../lib/dsProps";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { PillButton, type PillButtonProps } from "../../components/PillButton";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import type { PermissionTone } from "../../lib/permissionTone";
import styles from "./ComposerControl.module.css";
import { dsClass } from "../../lib/internal";

export interface ComposerControlProps
  extends DsBaseProps<ButtonHTMLAttributes<HTMLButtonElement>> {
  icon?: ReactNode;
  surface?: PillButtonProps["surface"];
  size?: PillButtonProps["size"];
  label: ReactNode;
  detail?: ReactNode;
  active?: boolean;
  compact?: "label" | "icon";
  /** `danger` renders an error state in the danger color. */
  tone?: "default" | "danger";
  /** Access-mode colors for the control and its icon. */
  permissionTone?: PermissionTone;
}

export function ComposerControl({
  icon,
  label,
  detail,
  active = false,
  compact = "label",
  tone = "default",
  permissionTone,
  disabled = false,
  onClick,
  className,
  type = "button",
  ...props
}: ComposerControlProps) {
  return (
    <PillButton
      className={dsClass(styles.control, active && styles.active, className)}
      data-compact={compact}
      data-tone={tone === "danger" ? "danger" : undefined}
      data-permission-tone={permissionTone}
      icon={icon ? <span data-test-class="composer-control-icon">{icon}</span> : undefined}
      disabled={disabled}
      onClick={onClick}
      type={type}
      {...props}
    >
      <Stack
        align="row"
        gap="xs"
        cross="center"
        className={dsClass(styles.content)}
        data-test-class="composer-control-content"
      >
        <Typo.Caption className={dsClass(styles.label)}>{label}</Typo.Caption>
        {detail ? <Typo.Caption className={dsClass(styles.detail)}>{detail}</Typo.Caption> : null}
      </Stack>
    </PillButton>
  );
}
