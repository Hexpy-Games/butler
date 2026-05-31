import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import styles from "./OptionMenu.module.css";

export interface OptionMenuProps {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  size?: "default" | "fit";
}

export function OptionMenu({
  title,
  children,
  className,
  size = "default",
}: OptionMenuProps) {
  return (
    <div
      className={cn(styles.menu, className)}
      data-size={size}
      data-slot="option-menu"
      data-test-class="composer-menu"
      aria-label={typeof title === "string" ? title : undefined}
    >
      <div className={styles.title}>{title}</div>
      <div className={styles.items}>{children}</div>
    </div>
  );
}

export interface OptionMenuSectionProps {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}

export function OptionMenuSection({
  title,
  children,
  className,
}: OptionMenuSectionProps) {
  return (
    <section
      className={cn(styles.section, className)}
      data-slot="option-menu-section"
    >
      <div
        className={styles.sectionTitle}
        data-slot="option-menu-section-title"
      >
        {title}
      </div>
      <div className={styles.sectionItems}>{children}</div>
    </section>
  );
}

export interface OptionMenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  descriptionPlacement?: "inline" | "block";
  selected?: boolean;
  tone?: "default" | "accent" | "warning" | "muted";
}

export function OptionMenuItem({
  icon,
  label,
  description,
  descriptionPlacement = "inline",
  selected = false,
  tone = "default",
  type = "button",
  className,
  ...props
}: OptionMenuItemProps) {
  return (
    <button
      aria-current={selected ? "true" : undefined}
      className={cn(styles.item, className)}
      data-has-icon={icon ? "true" : undefined}
      data-description-placement={
        description ? descriptionPlacement : undefined
      }
      data-selected={selected ? "true" : undefined}
      data-tone={tone}
      data-slot="option-menu-item"
      type={type}
      {...props}
    >
      {icon ? (
        <span className={styles.icon} data-slot="option-menu-item-icon">
          {icon}
        </span>
      ) : null}
      <span className={styles.copy}>
        <span className={styles.label} data-slot="option-menu-item-label">
          {label}
        </span>
        {description ? (
          <span
            className={styles.description}
            data-slot="option-menu-item-description"
          >
            {description}
          </span>
        ) : null}
      </span>
    </button>
  );
}
