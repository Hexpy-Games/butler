import { Fragment, type ReactNode } from "react";
import { TitlebarShell } from "../blocks/TitlebarShell";
import { Breadcrumb, BreadcrumbButton, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "../components/Breadcrumb";
import { Button } from "../components/Button";
import { IconButton } from "../components/IconButton";
import { Search, SlidersHorizontal } from "../components/Icons";
import { Kbd } from "../components/Kbd";
import { Popover, PopoverContent, PopoverTrigger } from "../components/Popover";
import { SegmentedControl } from "../components/SegmentedControl";
import { Stack } from "../components/Stack";
import { Typo } from "../components/Typo";
import { pageTrail } from "./pageTrail";
import type { ViewerPage } from "./viewerNavigation";
import { VIEWER_LOCALES, VIEWER_MOTIONS, VIEWER_THEMES, VIEWER_WIDTHS, type ViewerState } from "./viewerState";

const THEME_LABELS: Record<(typeof VIEWER_THEMES)[number], string> = { light: "Light", dark: "Dark", "side-by-side": "Both" };
const WIDTH_LABELS: Record<(typeof VIEWER_WIDTHS)[number], string> = { "320": "320", "375": "375", "430": "430", app: "App", wide: "Wide" };
const MOTION_LABELS: Record<(typeof VIEWER_MOTIONS)[number], string> = { full: "Full", reduced: "Reduced" };

function options<T extends string>(values: readonly T[], labels: Record<T, string>) {
  return values.map((value) => ({ value, label: labels[value] }));
}

function Option({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap="xs">
      <Typo.Caption tone="secondary">{label}</Typo.Caption>
      {children}
    </Stack>
  );
}

/** Theme, locale, example width and motion. Phones drop the width presets: the page is already phone-wide. */
export function ViewerOptions({ state, compact, onChange }: {
  state: ViewerState;
  compact: boolean;
  onChange: (patch: Partial<ViewerState>) => void;
}) {
  return (
    <Stack gap="md" data-ds-toolbar="controls">
      <Option label="Theme">
        <SegmentedControl ariaLabel="Theme" options={options(VIEWER_THEMES, THEME_LABELS)}
          value={state.theme === "system" ? "" : state.theme} onValueChange={(theme) => onChange({ theme: theme as ViewerState["theme"] })} />
      </Option>
      <Option label="Language">
        <SegmentedControl ariaLabel="Locale" options={options(VIEWER_LOCALES, { en: "EN", ko: "KO" })}
          value={state.locale} onValueChange={(locale) => onChange({ locale: locale as ViewerState["locale"] })} />
      </Option>
      {compact ? null : (
        <Option label="Example width">
          <SegmentedControl ariaLabel="Width" options={options(VIEWER_WIDTHS, WIDTH_LABELS)}
            value={state.width} onValueChange={(width) => onChange({ width: width as ViewerState["width"] })} />
        </Option>
      )}
      <Option label="Motion">
        <SegmentedControl ariaLabel="Motion" options={options(VIEWER_MOTIONS, MOTION_LABELS)}
          value={state.motion} onValueChange={(motion) => onChange({ motion: motion as ViewerState["motion"] })} />
      </Option>
    </Stack>
  );
}

function Trail({ page, onOpen }: { page: ViewerPage; onOpen: (page: string) => void }) {
  const trail = pageTrail(page);
  return (
    <Breadcrumb label="Location">
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
  );
}

/**
 * The viewer's titlebar, the app's TitlebarShell: where you are, Search and View options.
 * Drawer widths show the page title only; the floating navigation toggle sits at its start.
 */
export function ViewerTitlebar({ page, state, drawer, compact, navOpen, onChange, onOpen, onSearch }: {
  page: ViewerPage;
  state: ViewerState;
  drawer: boolean;
  compact: boolean;
  navOpen: boolean;
  onChange: (patch: Partial<ViewerState>) => void;
  onOpen: (page: string) => void;
  onSearch: () => void;
}) {
  const title = pageTrail(page).at(-1)?.label ?? "Butler DS";
  return (
    <TitlebarShell
      collapsed={drawer || !navOpen}
      dataTestClass="custom-titlebar"
      title={drawer ? title : <Trail onOpen={onOpen} page={page} />}
      trailing={(
        <Stack align="row" cross="center" gap="xs" data-ds-toolbar="actions">
          {drawer ? (
            <IconButton label="Search" onClick={onSearch} data-ds-open-palette><Search size="md" /></IconButton>
          ) : (
            <Button size="sm" variant="outline" iconStart={<Search size="md" />} onClick={onSearch} data-ds-open-palette
              iconEnd={<Kbd keys={["⌘", "K"]} label="Command K" size="sm" />} text="Search" />
          )}
          <Popover>
            <PopoverTrigger asChild>
              <IconButton label="View options" aria-haspopup="dialog" data-ds-view-options><SlidersHorizontal size="md" /></IconButton>
            </PopoverTrigger>
            <PopoverContent align="end" aria-label="View options" data-ds-view-options-panel>
              <ViewerOptions compact={compact} state={state} onChange={onChange} />
            </PopoverContent>
          </Popover>
        </Stack>
      )}
    />
  );
}
