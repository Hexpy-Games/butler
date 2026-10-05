import { useEffect, useRef, useState } from "react";
import { PageContainer, Section, Stack, Tag, Typo, Wallpaper } from "@/butler-ds";
import { COPY } from "./copy";
import { pageWallpaperSource } from "./decorationScenes";
import { DecoratedComposer } from "./DecoratedComposer";
import { PreviewKnobs, SettingsPreview } from "./ProposalControls";
import { readProposalState, writeProposalState, type ProposalState } from "./proposalState";
import type { PulseMeter } from "./useTypingPulse";
import styles from "./ComposerDecorations.module.css";

function systemTheme(): "light" | "dark" {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function p99(values: number[]): number {
  if (!values.length) return 0;
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.99) - 1)] ?? 0;
}

/** Reads the shared meter at most once a second, only while the page is visible. */
function useMeterReadout(meter: React.RefObject<PulseMeter>): string {
  const [text, setText] = useState("Type in the message box to measure.");
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      const { input, frame, pulses } = meter.current;
      if (!input.length) return;
      setText(`Keystroke handler p99 ${p99(input).toFixed(3)} ms · pulse frame p99 ${p99(frame).toFixed(3)} ms · ${input.length} keystrokes, ${pulses} pulses (last 128)`);
    }, 1000);
    return () => window.clearInterval(id);
  }, [meter]);
  return text;
}

const DECISIONS = [
  "Background, not a band: the scene fills the whole card behind the text; card structure, order and controls are unchanged.",
  "Scenes run on the DS Wallpaper engine (container scope): shoreline is the shipped module; cherry blossom is a new module in the same format.",
  "Readability: a card-local scrim of the TintedGlass tint over the scene (light: shoreline 74%, cherry blossom 30%; dark: 76%; measured text-primary >= 7.5:1, secondary and placeholder >= 3:1), stronger at the top and bottom edges like TintedGlass. The art is the same in light and dark.",
  "Typing pulse: the scene swells 2.5% (transform only, scrim fixed so contrast never dips) over --motion-deliberate (320ms); at most one pulse per frame, faster typing coalesces.",
  "Character: head behind the card, paws in front on the top edge inside its padding; never over text or controls.",
  "Motion follows the existing wallpaper settings (Motion, Pause on battery) and reduced motion: still frame, no pulse.",
];

export function ComposerDecorationsPage() {
  const [state, setState] = useState<ProposalState>(() => readProposalState(window.location.search));
  const meter = useRef<PulseMeter>({ input: [], frame: [], pulses: 0 });
  const readout = useMeterReadout(meter);
  const copy = COPY[state.locale];
  const frames: Array<"light" | "dark"> = state.theme === "both" ? ["light", "dark"] : [state.theme];
  const chrome = state.theme === "both" ? systemTheme() : state.theme;
  const onChange = (patch: Partial<ProposalState>) => setState((current) => ({ ...current, ...patch }));

  useEffect(() => { writeProposalState(state); }, [state]);
  useEffect(() => {
    document.body.classList.add(`theme-${chrome}`);
    document.body.dataset.motion = state.motion;
    return () => { document.body.classList.remove(`theme-${chrome}`); delete document.body.dataset.motion; };
  }, [chrome, state.motion]);

  return (
    <div className={`${styles.pageRoot} theme-${chrome}`}>
    <PageContainer as="main" width="default" gutter="lg">
      <Stack gap="2xl">
        <Stack gap="md">
          <Stack align="row"><Tag tone="accent" size="md">Proposal · #474</Tag></Stack>
          <Typo.H1>Composer decorations</Typo.H1>
          <Typo.Body tone="secondary">A live scene as the message box background, a small pulse while typing, and an optional character on the top edge.</Typo.Body>
        </Stack>
        <Section title="Preview" titleAs="h2">
          <Stack gap="lg">
            <PreviewKnobs state={state} onChange={onChange} />
            <div className={styles.frames} data-count={frames.length}>
              {frames.map((tone) => (
                <div className={`${styles.frame} theme-${tone}`} data-theme-frame={tone} key={tone} lang={state.locale}>
                  <div className={styles.screen} data-width={state.width}>
                    <Wallpaper source={pageWallpaperSource(state.wallpaper)} scope="container" tone={tone} />
                    <DecoratedComposer copy={copy} theme={state.decor} character={state.character} meter={meter} />
                  </div>
                </div>
              ))}
            </div>
            <Typo.Caption tone="secondary" data-proposal-meter>{readout}</Typo.Caption>
          </Stack>
        </Section>
        <Section title="Settings" titleAs="h2" description="Settings → Appearance, under the wallpaper fields.">
          <div lang={state.locale}>
            <SettingsPreview copy={copy} state={state} onChange={onChange} />
          </div>
        </Section>
        <Section title="Decisions" titleAs="h2">
          <Stack gap="sm">
            {DECISIONS.map((line) => <Typo.Body key={line}>{line}</Typo.Body>)}
          </Stack>
        </Section>
      </Stack>
    </PageContainer>
    </div>
  );
}
