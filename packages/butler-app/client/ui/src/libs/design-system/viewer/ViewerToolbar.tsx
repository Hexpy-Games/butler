import { Button } from "../components/Button";
import { IconButton } from "../components/IconButton";
import { PanelLeft } from "../components/Icons";
import { Stack } from "../components/Stack";
import { Typo } from "../components/Typo";
import {
  VIEWER_LOCALES,
  VIEWER_THEMES,
  VIEWER_WIDTHS,
  type ViewerState,
} from "./viewerState";
import styles from "./DesignSystemViewer.module.css";

const THEME_LABELS: Record<(typeof VIEWER_THEMES)[number], string> = {
  light: "Light",
  dark: "Dark",
  "side-by-side": "Side by side",
};

const WIDTH_LABELS: Record<(typeof VIEWER_WIDTHS)[number], string> = {
  "320": "320",
  "375": "375",
  "430": "430",
  app: "App",
  wide: "Wide",
};

function Segmented<T extends string>({ label, options, labels, value, onChange }: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T | null;
  onChange: (value: T) => void;
}) {
  return (
    <Stack align="row" cross="center" gap="sm" role="group" aria-label={label} data-ds-toolbar={label.toLowerCase()}>
      <Typo.Caption>{label}</Typo.Caption>
      <Stack align="row" gap="1" wrap>
        {options.map((option) => (
          <Button
            aria-pressed={value === option}
            key={option}
            onClick={() => onChange(option)}
            size="xs"
            text={labels[option]}
            type="button"
            variant={value === option ? "default" : "outline"}
          />
        ))}
      </Stack>
    </Stack>
  );
}

export function ViewerToolbar({ state, onChange, onToggleMenu }: {
  state: ViewerState;
  onChange: (patch: Partial<ViewerState>) => void;
  onToggleMenu: () => void;
}) {
  return (
    <Stack align="row" cross="center" gap="lg" justify="between" wrap>
      <span className={styles.menuToggle}>
        <IconButton label="Toggle navigation" onClick={onToggleMenu}>
          <PanelLeft size="md" />
        </IconButton>
      </span>
      <Stack align="row" cross="center" gap="lg" wrap>
        <Segmented
          label="Theme"
          labels={THEME_LABELS}
          onChange={(theme) => onChange({ theme })}
          options={VIEWER_THEMES}
          value={state.theme === "system" ? null : state.theme}
        />
        <Segmented
          label="Locale"
          labels={{ en: "EN", ko: "KO" }}
          onChange={(locale) => onChange({ locale })}
          options={VIEWER_LOCALES}
          value={state.locale}
        />
        <Segmented
          label="Width"
          labels={WIDTH_LABELS}
          onChange={(width) => onChange({ width })}
          options={VIEWER_WIDTHS}
          value={state.width}
        />
      </Stack>
    </Stack>
  );
}
