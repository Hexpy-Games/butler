import { useEffect, useState } from "react";
import { PageContainer, Section, Stack, Tag, Typo } from "@/butler-ds";
import { COPY } from "./copy";
import { pageWallpaperSource } from "./decorationScenes";
import { NewChatScreen } from "./DecoratedComposer";
import { PreviewKnobs, SettingsPreview } from "./ProposalControls";
import { currentShore, effectiveDecor, proposalSearch, readProposalState, writeProposalState, type ProposalState } from "./proposalState";
import { ShoreContrastTable } from "./ShoreContrast";
import { ShoreTuning } from "./ShoreTuningPanel";
import styles from "./ComposerDecorations.module.css";

function systemTheme(): "light" | "dark" {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const DECISIONS = [
  "Same composer as the app: Conversation.tsx's ConversationShell and Composer.tsx's floating large ComposerCard with ComposerToolbar's parts. At rest it is the one-row pill; it opens on focus. Only the background layer and the character are new.",
  "Background, not a band: the scene fills the whole card behind the text. Nothing else sits behind the text or the controls; readability comes from the art's composition. The art is the same in light and dark.",
  "No interactivity: both scenes play continuously while visible, 20fps; typing does nothing to them. Hidden or offscreen: no frames. Reduced motion: a still frame.",
  "Shoreline: the shipped module with the owner's setting as the default (waterline 19px above the bottom edge, exposure 1.22, sand highlights toned down 6%, a 30% tone gradient from 75% to 100% of the card height) and no cloud shadows by day (a proposed `dayClouds` param, mocked here). Dark mode keeps the night grade. Options a-d stay switchable for comparison.",
  "Cherry canopy inside the card, painted like the owner's anime references: soft cloud-shaped masses of blossom built from small dabs in four pinks, scalloped edges, thin branch strokes, petals falling across. Fixed size anchored to the top-right corner: along the top padding (to half the width, lighter from the top-left) and a mass over the empty right side, 24% of the width (18% on phones) and 56px deep at most; it never grows with the draft. Long first lines may run under its right end, so the part over the text uses a text-safe palette per theme (deep roses in dark mode, pale pinks in light mode); pale highlights stay in the top and right padding. No background.",
  "Character: head behind the card, paws in front on the top edge inside its padding; never over text or controls; static.",
];

/** One new chat screen, full bleed: the 375 previews load this in a 375px iframe so media queries match a phone. */
function EmbeddedScreen({ state }: { state: ProposalState }) {
  const tone = state.theme === "dark" ? "dark" : "light";
  useEffect(() => {
    document.body.classList.add(`theme-${tone}`);
    document.body.dataset.motion = state.motion;
  }, [tone, state.motion]);
  return (
    <div className={`${styles.embedRoot} theme-${tone}`} lang={state.locale}>
      <NewChatScreen copy={COPY[state.locale]} theme={effectiveDecor(state)} shore={currentShore(state)} character={state.character} tone={tone}
        wallpaper={pageWallpaperSource(state.wallpaper)} engagedAtStart={state.composer === "open"} />
    </div>
  );
}

function PreviewFrames({ state }: { state: ProposalState }) {
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
              <NewChatScreen copy={COPY[state.locale]} theme={effectiveDecor(state)} shore={currentShore(state)} character={state.character} tone={tone}
                wallpaper={pageWallpaperSource(state.wallpaper)} engagedAtStart={state.composer === "open"}
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
            <Typo.Body tone="secondary">A live scene as the message box background, and an optional character on the top edge.</Typo.Body>
          </Stack>
          <Section title="Preview" titleAs="h2">
            <Stack gap="lg">
              <PreviewKnobs state={state} onChange={onChange} />
              {state.decor === "shoreline" && state.shore === "d" ? <ShoreTuning state={state} onChange={onChange} /> : null}
              <PreviewFrames state={state} />
            </Stack>
          </Section>
          <Section title="Measured contrast" titleAs="h2" description="The shipped shoreline setting, the cherry canopy layouts (long drafts), and plain glass, light and dark. No layer sits behind the text.">
            <ShoreContrastTable />
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
