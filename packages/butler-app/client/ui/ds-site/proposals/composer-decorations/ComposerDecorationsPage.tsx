import { useEffect, useRef, useState } from "react";
import { PageContainer, Section, Stack, Tag, Typo } from "@/butler-ds";
import { COPY } from "./copy";
import { pageWallpaperSource } from "./decorationScenes";
import { NewChatScreen } from "./DecoratedComposer";
import { PreviewKnobs, SettingsPreview } from "./ProposalControls";
import { proposalSearch, readProposalState, writeProposalState, type ProposalState } from "./proposalState";
import type { PulseMeter } from "./useTypingPulse";
import styles from "./ComposerDecorations.module.css";

declare global {
  interface Window { __composerDecorMeter?: PulseMeter }
}

function systemTheme(): "light" | "dark" {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function p99(values: number[]): number {
  if (!values.length) return 0;
  return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.99) - 1)] ?? 0;
}

/** Shared per document; the 375 previews are same-origin iframes, read through their window. */
function useMeter(): React.RefObject<PulseMeter> {
  const meter = useRef<PulseMeter>({ input: [], frame: [], scrim: [], relayout: [], pulses: 0 });
  useEffect(() => { window.__composerDecorMeter = meter.current; }, []);
  return meter;
}

/** Reads every meter at most once a second, only while the page is visible. */
function useMeterReadout(meter: React.RefObject<PulseMeter>): string {
  const [text, setText] = useState("Type in the message box to measure.");
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      const meters = [meter.current, ...[...document.querySelectorAll("iframe")].map((frame) => {
        try { return frame.contentWindow?.__composerDecorMeter; } catch { return undefined; }
      })].filter((value): value is PulseMeter => Boolean(value));
      const input = meters.flatMap((value) => value.input);
      const frame = meters.flatMap((value) => value.frame);
      const scrim = meters.flatMap((value) => value.scrim);
      const relayout = meters.flatMap((value) => value.relayout);
      const pulses = meters.reduce((sum, value) => sum + value.pulses, 0);
      if (!input.length) return;
      setText(`Keystroke handler p99 ${p99(input).toFixed(3)} ms · pulse frame p99 ${p99(frame).toFixed(3)} ms · scrim frame p99 ${p99(scrim).toFixed(3)} ms (open/resize ${p99(relayout).toFixed(3)} ms) · ${input.length} keystrokes, ${pulses} pulses`);
    }, 1000);
    return () => window.clearInterval(id);
  }, [meter]);
  return text;
}

const DECISIONS = [
  "Same composer as the app: Conversation.tsx's ConversationShell and Composer.tsx's floating large ComposerCard with ComposerToolbar's parts. At rest it is the one-row pill; it opens on focus. Only the background layer and the character are new.",
  "Background, not a band: the scene fills the whole card behind the text on the DS Wallpaper engine (container scope). Shoreline is the shipped module; cherry blossom is a new module in the same format.",
  "Composition keeps the busy art away from the text: the blossoms hang from the top-right corner along the top and right edges; text and controls start at the left.",
  "Readability from local scrims only: three frosted halos (TintedGlass tint + 8px blur, feathered) sized to the text block, the left controls and the right controls, re-measured in the frame after each keystroke. The rest of the scene shows unmuted; the art is the same in light and dark. Measured: primary text >= 6.5:1, secondary/placeholder >= 3.3:1, icons >= 3.5:1.",
  "Typing pulse: the scene swells 2.5% (transform only) over --motion-deliberate (320ms); at most one pulse per frame, faster typing coalesces. Scrims never animate.",
  "Character: head behind the card, paws in front on the top edge inside its padding; never over text or controls.",
  "Motion follows the existing wallpaper settings (Motion, Pause on battery) and reduced motion: still frame, no pulse.",
];

/** One new chat screen, full bleed: the 375 previews load this in a 375px iframe so media queries match a phone. */
function EmbeddedScreen({ state }: { state: ProposalState }) {
  const meter = useMeter();
  const tone = state.theme === "dark" ? "dark" : "light";
  useEffect(() => {
    document.body.classList.add(`theme-${tone}`);
    document.body.dataset.motion = state.motion;
  }, [tone, state.motion]);
  return (
    <div className={`${styles.embedRoot} theme-${tone}`} lang={state.locale}>
      <NewChatScreen copy={COPY[state.locale]} theme={state.decor} character={state.character} tone={tone}
        wallpaper={pageWallpaperSource(state.wallpaper)} meter={meter} engagedAtStart={state.composer === "open"} />
    </div>
  );
}

function PreviewFrames({ state, meter }: { state: ProposalState; meter: React.RefObject<PulseMeter> }) {
  const tones: Array<"light" | "dark"> = state.theme === "both" ? ["light", "dark"] : [state.theme];
  return (
    <div className={styles.frames} data-width={state.width}>
      {tones.map((tone) => (
        <div className={`${styles.frame} theme-${tone}`} data-theme-frame={tone} key={tone} lang={state.locale}>
          {state.width === "375" ? (
            <iframe className={styles.phone} title={`375px preview, ${tone}`} key={proposalSearch({ ...state, theme: tone })}
              src={`?${proposalSearch({ ...state, theme: tone })}&embed=1`} />
          ) : (
            <div className={styles.screen}>
              <NewChatScreen copy={COPY[state.locale]} theme={state.decor} character={state.character} tone={tone}
                wallpaper={pageWallpaperSource(state.wallpaper)} meter={meter} engagedAtStart={state.composer === "open"}
                key={`${state.composer}-${state.locale}`} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ComposerDecorationsPage() {
  const [state, setState] = useState<ProposalState>(() => readProposalState(window.location.search));
  const embed = new URLSearchParams(window.location.search).get("embed") === "1";
  const meter = useMeter();
  const readout = useMeterReadout(meter);
  const copy = COPY[state.locale];
  const chrome = state.theme === "both" ? systemTheme() : state.theme;
  const onChange = (patch: Partial<ProposalState>) => setState((current) => ({ ...current, ...patch }));

  useEffect(() => { if (!embed) writeProposalState(state); }, [state, embed]);
  useEffect(() => {
    if (embed) return undefined;
    document.body.classList.add(`theme-${chrome}`);
    document.body.dataset.motion = state.motion;
    return () => { document.body.classList.remove(`theme-${chrome}`); delete document.body.dataset.motion; };
  }, [chrome, state.motion, embed]);

  if (embed) return <EmbeddedScreen state={state} />;
  return (
    <div className={`${styles.pageRoot} theme-${chrome}`} data-proposal-scroll>
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
              <PreviewFrames state={state} meter={meter} />
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
