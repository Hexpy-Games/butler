import { useEffect, useState } from "react";
import { PageContainer, Section, Stack, Tag, Typo } from "@/butler-ds";
import { COPY } from "./copy";
import { pageWallpaperSource } from "./decorationScenes";
import { NewChatScreen } from "./DecoratedComposer";
import { PreviewKnobs, SettingsPreview } from "./ProposalControls";
import { effectiveDecor, proposalSearch, readProposalState, writeProposalState, type ProposalState } from "./proposalState";
import { ShoreContrastTable } from "./ShoreContrast";
import styles from "./ComposerDecorations.module.css";

function systemTheme(): "light" | "dark" {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const DECISIONS = [
  "Same composer as the app: Conversation.tsx's ConversationShell and Composer.tsx's floating large ComposerCard with ComposerToolbar's parts. At rest it is the one-row pill; it opens on focus. Only the background layer and the character are new.",
  "Background, not a band: the scene fills the whole card behind the text. Nothing else sits behind the text or the controls; readability comes from the art's composition. The art is the same in light and dark.",
  "No interactivity: both scenes play continuously while visible, 20fps; typing does nothing to them. Hidden or offscreen: no frames. Reduced motion: a still frame.",
  "Shoreline: the shipped module with the day grade lifted to a high-key midday beach in light mode and the night grade in dark mode. Readability options a-d are switchable above; (b) is the only one that meets every floor (see Measured contrast).",
  "Cherry blossom: no background, the card's glass shows through. A Somei-yoshino branch whose corymbs of 2-5 notched five-petal flowers grow denser and fuller toward the top-right corner, a lush mass that all but hides the wood; sparse at the branch's left end. Deeper pink centres, petal edge shading and a soft contact shadow give presence on light glass. Fine petals and pollen drift across (fewer and fainter over the text).",
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
      <NewChatScreen copy={COPY[state.locale]} theme={effectiveDecor(state)} shore={state.shore} lush={state.cherry === "lush"} character={state.character} tone={tone}
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
              <NewChatScreen copy={COPY[state.locale]} theme={effectiveDecor(state)} shore={state.shore} lush={state.cherry === "lush"} character={state.character} tone={tone}
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
              <PreviewFrames state={state} />
            </Stack>
          </Section>
          <Section title="Measured contrast" titleAs="h2" description="Shoreline options a, b, d and cherry blossom, light and dark. No layer behind any text in any option.">
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
