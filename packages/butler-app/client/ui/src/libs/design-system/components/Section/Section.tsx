import type { HTMLAttributes, ReactNode } from "react";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import styles from "./Section.module.css";

type SpacingToken = "none" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
type TitleLevel = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

export interface SectionProps extends Omit<
  HTMLAttributes<HTMLElement>,
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
  contentClassName?: string;
}

function renderTitle(title: ReactNode, titleAs: TitleLevel) {
  return (
    <Typo.PanelSectionTitle as={titleAs} className={styles.title}>
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
    <Stack as="section" className={sectionClasses} gap="lg" {...props}>
      {hasHeader && (
        <Stack className={styles.header} gap={headerGap}>
          {(title || icon || actions) && (
            <Stack
              align="row"
              justify="between"
              cross="center"
              gap="md"
              className={styles["title-row"]}
            >
              {(title || icon) && (
                <Stack
                  align="row"
                  cross="center"
                  gap="sm"
                  className={styles["title-group"]}
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
                  className={styles.actions}
                >
                  {actions}
                </Stack>
              )}
            </Stack>
          )}
          {description && (
            <Typo.Body className={styles.description}>{description}</Typo.Body>
          )}
        </Stack>
      )}
      <Stack className={contentClasses} gap={gap}>
        {children}
      </Stack>
    </Stack>
  );
}

export default Section;
