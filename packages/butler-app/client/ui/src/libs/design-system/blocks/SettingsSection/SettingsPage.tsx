import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { isDevBuild } from "../../lib/devBuild";
import { SettingsSection } from "./SettingsSection";
import { SettingsSectionLabelsProvider, type SettingsSectionLabels } from "./settingsPageLabels";
import styles from "./SettingsSection.module.css";

export interface SettingsPageProps {
  /** Only `SettingsSection` elements (fragments, null and false are allowed). */
  children: ReactNode;
  /** Section state copy (loading, error, retry, empty). */
  labels?: Partial<SettingsSectionLabels>;
  /** Sticky footer at the bottom of the detail scroll area (page-wide save / reset). */
  footer?: ReactNode;
}

function assertSections(children: ReactNode) {
  Children.forEach(children, (child) => {
    if (child === null || child === undefined || typeof child === "boolean") return;
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
      assertSections(child.props.children);
      return;
    }
    if (!isValidElement(child) || child.type !== SettingsSection) {
      throw new Error("SettingsPage renders only SettingsSection children.");
    }
  });
}

/** A settings page: sections separated by `--settings-section-gap`, plus an optional sticky footer. */
export function SettingsPage({ children, labels, footer }: SettingsPageProps) {
  if (isDevBuild()) assertSections(children);
  return (
    <SettingsSectionLabelsProvider labels={labels}>
      <div className={styles.page} data-slot="settings-page">
        {children}
        {footer ? (
          <div className={styles.footer} data-slot="settings-page-footer">{footer}</div>
        ) : null}
      </div>
    </SettingsSectionLabelsProvider>
  );
}
