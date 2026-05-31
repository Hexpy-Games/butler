import type { ButtonHTMLAttributes, ReactNode } from "react";
import { PillButton } from "../../components/PillButton";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { cn } from "../../lib/utils";
import styles from "./ComposerControl.module.css";

export interface ComposerControlProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  icon?: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  active?: boolean;
  className?: string;
}

export function ComposerControl({
  icon,
  label,
  detail,
  active = false,
  disabled = false,
  onClick,
  className,
  type = "button",
  ...props
}: ComposerControlProps) {
  return (
    <PillButton
      className={cn(styles.control, active && styles.active, className)}
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
        className={styles.content}
        data-test-class="composer-control-content"
      >
        <Typo.Caption className={styles.label}>{label}</Typo.Caption>
        {detail ? <Typo.Caption className={styles.detail}>{detail}</Typo.Caption> : null}
      </Stack>
    </PillButton>
  );
}
