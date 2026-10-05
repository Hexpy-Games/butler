import { useEffect, useRef, useState } from "react";
import { Grid, Slider, Stack, Tag, Typo } from "@/butler-ds";
import { measureShoreline } from "./liveContrast";
import type { ContrastRow } from "./measuredContrast";
import type { ProposalState } from "./proposalState";
import { SHORE_SLIDERS, type ShoreParams } from "./shoreTuning";

const FLOORS: Array<[keyof ContrastRow, string, number]> = [
  ["primary", "Primary", 4.5], ["placeholder", "Placeholder", 3], ["secondary", "Secondary", 3], ["icons", "Icons", 3],
];

function cardFor(tone: "light" | "dark"): HTMLElement | null {
  const frame = document.querySelector(`[data-theme-frame="${tone}"]`);
  const iframe = frame?.querySelector("iframe");
  const root: ParentNode | null | undefined = iframe ? iframe.contentDocument : frame;
  return (root?.querySelector('[data-test-class="composer-card"]') as HTMLElement | null) ?? null;
}

/** Live contrast for each visible theme frame, re-measured on every change and every 1.5s. */
function useLiveContrast(params: ShoreParams, tones: Array<"light" | "dark">) {
  const [rows, setRows] = useState<Record<string, ContrastRow>>({});
  const key = JSON.stringify(params) + tones.join();
  const latest = useRef(key);
  latest.current = key;
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (document.visibilityState === "hidden") return;
      const next: Record<string, ContrastRow> = {};
      for (const tone of tones) {
        const card = cardFor(tone);
        if (card) next[tone] = await measureShoreline(card, tone, params).catch(() => ({ primary: Number.NaN, placeholder: Number.NaN, secondary: Number.NaN, icons: Number.NaN }));
      }
      if (!cancelled && latest.current === key) setRows(next);
    };
    const first = window.setTimeout(run, 200);
    const every = window.setInterval(run, 1500);
    return () => { cancelled = true; window.clearTimeout(first); window.clearInterval(every); };
  }, [key]); // key covers params and tones
  return rows;
}

/** Option (d): one slider per parameter, values in the URL, live contrast readout. */
export function ShoreTuning({ state, onChange }: { state: ProposalState; onChange: (patch: Partial<ProposalState>) => void }) {
  const tones: Array<"light" | "dark"> = state.theme === "both" ? ["light", "dark"] : [state.theme];
  const rows = useLiveContrast(state.tune, tones);
  const set = (key: keyof ShoreParams, value: number) => onChange({ tune: { ...state.tune, [key]: value } });
  return (
    <Stack gap="lg" data-shore-tuning>
      <Grid columns={{ base: "1", wide: "3" }} gap="lg">
        {SHORE_SLIDERS.map(({ key, label, min, max, step }) => {
          const value = state.tune[key] ?? 0;
          return (
            <Stack gap="xs" key={key}>
              <Stack align="row" justify="between">
                <Typo.Label tone="secondary">{label}</Typo.Label>
                <Typo.Code>{String(value)}</Typo.Code>
              </Stack>
              <Slider aria-label={label} min={min} max={max} step={step} value={value} onValueChange={(next) => set(key, next)} />
            </Stack>
          );
        })}
      </Grid>
      <Stack gap="sm" data-live-contrast>
        {tones.map((tone) => (
          <Stack align="row" gap="md" wrap key={tone}>
            <Typo.Label>{`Live contrast · ${tone === "light" ? "Light" : "Dark"}`}</Typo.Label>
            {FLOORS.map(([role, label, floor]) => {
              const value = rows[tone]?.[role];
              const shown = value === undefined ? "…" : Number.isNaN(value) ? "retrying" : value >= 99 ? "–" : value.toFixed(2);
              return (
                <Stack align="row" gap="xs" key={role}>
                  <Typo.Caption tone="secondary">{label}</Typo.Caption>
                  <Typo.Body>{shown}</Typo.Body>
                  {value !== undefined && value < floor ? <Tag tone="danger" size="sm">{`below ${floor}`}</Tag> : null}
                </Stack>
              );
            })}
          </Stack>
        ))}
        <Typo.Caption tone="secondary">Measured on the scene's still frame behind the preview composer's glyphs and icons, as currently shown (at rest or open). The URL keeps these values: copy it to send a setting back.</Typo.Caption>
      </Stack>
    </Stack>
  );
}
