import type { DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes, ReactNode } from "react";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import styles from "./Section.module.css";
import { dsClass, type DsClassName } from "../../lib/internal";

type SpacingToken = "none" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
type TitleLevel = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

export interface SectionProps extends Omit<
  DsBaseProps<HTMLAttributes<HTMLElement>>,
  "title"
> {
  children: ReactNode;
  title?: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  gap?: SpacingToken;
  headerGap?: SpacingToken;
  titleAs?: TitleLevel;
  fill?: boolean;
  contentFill?: boolean;
  /** DS-internal: class for the content stack. */
  contentClassName?: DsClassName;
}

function renderTitle(title: ReactNode, titleAs: TitleLevel) {
  return (
    <Typo.PanelSectionTitle as={titleAs} className={dsClass(styles.title)}>
      {title}
    </Typo.PanelSectionTitle>
  );
}

export function Section({
  children,
  title,
  icon,
  description,
  actions,
  gap = "md",
  headerGap = "sm",
  titleAs = "h3",
  fill = false,
  contentFill = false,
  className,
  contentClassName,
  ...props
}: SectionProps) {
  const sectionClasses = [styles.section, fill && styles.fill, className]
    .filter(Boolean)
    .join(" ");
  const contentClasses = [
    styles.content,
    contentFill && styles.contentFill,
    contentClassName,
  ]
    .filter(Boolean)
    .join(" ");
  const hasHeader = Boolean(title || icon || description || actions);

  return (
    <Stack as="section" className={dsClass(sectionClasses)} gap="lg" {...props}>
      {hasHeader && (
        <Stack className={dsClass(styles.header)} gap={headerGap}>
          {(title || icon || actions) && (
            <Stack
              align="row"
              justify="between"
              cross="center"
              gap="md"
              className={dsClass(styles["title-row"])}
            >
              {(title || icon) && (
                <Stack
                  align="row"
                  cross="center"
                  gap="sm"
                  className={dsClass(styles["title-group"])}
                >
                  {icon && (
                    <span className={styles.icon} aria-hidden="true">
                      {icon}
                    </span>
                  )}
                  {title && renderTitle(title, titleAs)}
                </Stack>
              )}
              {actions && (
                <Stack
                  align="row"
                  cross="center"
                  gap="sm"
                  className={dsClass(styles.actions)}
                >
                  {actions}
                </Stack>
              )}
            </Stack>
          )}
          {description && (
            <Typo.Body className={dsClass(styles.description)}>{description}</Typo.Body>
          )}
        </Stack>
      )}
      <Stack className={dsClass(contentClasses)} gap={gap}>
        {children}
      </Stack>
    </Stack>
  );
}

export default Section;
