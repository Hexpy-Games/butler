import { useState } from "react";
import { Section, Stack, Typo } from "@/butler-ds";
import { EMPTY_METRICS } from "../../decorations/composer/types";
import { PageHeader } from "../parts";
import type { ResolvedTheme } from "../useViewerTheme";
import type { ViewerState } from "../viewerState";
import { ComposerExample, type ExampleOptions } from "./composer-decoration/ComposerExample";
import { DecorationControls } from "./composer-decoration/DecorationControls";
import styles from "./composer-decoration/ComposerExample.module.css";

export function ComposerDecorationPage({ state, themes, onChange }: {
  state: ViewerState;
  themes: ResolvedTheme[];
  onChange: (patch: Partial<ViewerState>) => void;
}) {
  const [options, setOptions] = useState<ExampleOptions>({
    theme: "none", mode: "interactive", intensity: 0.7, tone: "light", inside: false, wallpaper: false,
  });
  const [metrics, setMetrics] = useState(EMPTY_METRICS);
  const tone = themes[0] ?? "light";
  const measured = options.theme === "none" ? EMPTY_METRICS : metrics;
  return (
    <Stack gap="2xl" data-ds-composer-decorations>
      <PageHeader title="Composer decorations" lead="Background themes for ComposerCard." />
      <Section title="Examples" titleAs="h2">
        <div className={styles.example} data-width={state.width}>
          <ComposerExample options={{ ...options, tone }} onMetrics={setMetrics} />
        </div>
      </Section>
      <Section title="Controls" titleAs="h2">
        <DecorationControls options={{ ...options, tone }} state={state} onChange={onChange}
          onOptions={(patch) => setOptions((current) => ({ ...current, ...patch }))} />
      </Section>
      <Typo.Caption tone="secondary" data-decoration-perf>
        {`${measured.state} · ${measured.fps.toFixed(1)} fps · CPU draw p95 ${measured.drawP95.toFixed(2)} ms · input p99 ${measured.inputP99.toFixed(2)} ms · ${measured.inputs} edits`}
      </Typo.Caption>
    </Stack>
  );
}
