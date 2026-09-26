import { Fragment } from "react";
import { Breadcrumb, BreadcrumbButton, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "../components/Breadcrumb";
import { Button } from "../components/Button";
import { IconButton } from "../components/IconButton";
import { PanelLeft, Search } from "../components/Icons";
import { Kbd } from "../components/Kbd";
import { SegmentedControl } from "../components/SegmentedControl";
import { Stack } from "../components/Stack";
import { pageTrail } from "./pageTrail";
import type { ViewerPage } from "./viewerNavigation";
import { VIEWER_LOCALES, VIEWER_MOTIONS, VIEWER_THEMES, VIEWER_WIDTHS, type ViewerState } from "./viewerState";
import styles from "./DesignSystemViewer.module.css";

const THEME_LABELS: Record<(typeof VIEWER_THEMES)[number], string> = { light: "Light", dark: "Dark", "side-by-side": "Both" };
const WIDTH_LABELS: Record<(typeof VIEWER_WIDTHS)[number], string> = { "320": "320", "375": "375", "430": "430", app: "App", wide: "Wide" };
const MOTION_LABELS: Record<(typeof VIEWER_MOTIONS)[number], string> = { full: "Full", reduced: "Reduced" };

function options<T extends string>(values: readonly T[], labels: Record<T, string>) {
  return values.map((value) => ({ value, label: labels[value] }));
}

export function ViewerToolbar({ page, state, onChange, onOpen, onSearch, onToggleMenu }: {
  page: ViewerPage;
  state: ViewerState;
  onChange: (patch: Partial<ViewerState>) => void;
  onOpen: (page: string) => void;
  onSearch: () => void;
  onToggleMenu: () => void;
}) {
  const trail = pageTrail(page);
  return (
    <Stack align="row" cross="center" gap="md" justify="between" wrap>
      <Stack align="row" cross="center" gap="sm" minWidth="0">
        <span className={styles.menuToggle}>
          <IconButton label="Toggle navigation" onClick={onToggleMenu}><PanelLeft size="md" /></IconButton>
        </span>
        <Breadcrumb aria-label="Location">
          <BreadcrumbList>
            {trail.map((step, index) => (
              <Fragment key={step.label}>
                {index > 0 ? <BreadcrumbSeparator /> : null}
                <BreadcrumbItem>
                  {step.page && index < trail.length - 1
                    ? <BreadcrumbButton onClick={() => onOpen(step.page!)}>{step.label}</BreadcrumbButton>
                    : <BreadcrumbPage>{step.label}</BreadcrumbPage>}
                </BreadcrumbItem>
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      </Stack>
      <Stack align="row" cross="center" gap="sm" wrap data-ds-toolbar="controls">
        <SegmentedControl ariaLabel="Theme" size="sm" options={options(VIEWER_THEMES, THEME_LABELS)}
          value={state.theme === "system" ? "" : state.theme} onValueChange={(theme) => onChange({ theme: theme as ViewerState["theme"] })} />
        <SegmentedControl ariaLabel="Locale" size="sm" options={options(VIEWER_LOCALES, { en: "EN", ko: "KO" })}
          value={state.locale} onValueChange={(locale) => onChange({ locale: locale as ViewerState["locale"] })} />
        <SegmentedControl ariaLabel="Width" size="sm" options={options(VIEWER_WIDTHS, WIDTH_LABELS)}
          value={state.width} onValueChange={(width) => onChange({ width: width as ViewerState["width"] })} />
        <SegmentedControl ariaLabel="Motion" size="sm" options={options(VIEWER_MOTIONS, MOTION_LABELS)}
          value={state.motion} onValueChange={(motion) => onChange({ motion: motion as ViewerState["motion"] })} />
        <Button size="sm" variant="outline" iconStart={<Search size="md" />} onClick={onSearch} data-ds-open-palette
          iconEnd={<Kbd keys={["⌘", "K"]} label="Command K" size="sm" />} text="Search" />
      </Stack>
    </Stack>
  );
}
