import { useRef, useState, type RefObject } from "react";
import {
  AiChip, ComposerCard, ComposerCardEditable, ComposerCardEditor, ComposerCardExpandedBody, ComposerCardExpandedControls,
  ComposerCardPlaceholder, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerControl, ComposerPlanToggle,
  ComposerSendButton, ContextDonutButton, IconButton, Plus, ShieldQuestion, Wallpaper,
} from "@/butler-ds";
import type { ProposalCopy } from "./copy";
import { DECORATION_REGISTRY, DECORATION_SOURCES, type DecorationTheme } from "./decorationScenes";
import { CharacterHead, CharacterPaws, characterFor } from "./EdgeCharacter";
import { useTypingPulse, type PulseMeter } from "./useTypingPulse";
import styles from "./ComposerDecorations.module.css";

/**
 * The card background: first child of the unchanged ComposerCard. Absolutely fills the form
 * (TintedGlass's backdrop-filter makes the form its containing block and stacking context),
 * paints above the glass fill and below every editor/toolbar node (z-index -1), clipped by the
 * card radius. Scene = DS Wallpaper (container scope, fixed light tone: same art in both themes);
 * scrim = the TintedGlass tint at a fixed alpha so text contrast holds in light and dark.
 */
function DecorationBackground({ theme, artRef }: {
  theme: Exclude<DecorationTheme, "none">;
  artRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div aria-hidden="true" className={styles.background} data-composer-decoration={theme}>
      <div className={styles.art} ref={artRef}>
        <Wallpaper source={DECORATION_SOURCES[theme]} registry={DECORATION_REGISTRY} scope="container" tone="light" pauseOnBattery
          dataTestClass="composer-decoration-scene" />
      </div>
      <div className={styles.scrim} />
    </div>
  );
}

export function DecoratedComposer({ copy, theme, character, meter }: {
  copy: ProposalCopy;
  theme: DecorationTheme;
  character: boolean;
  meter: RefObject<PulseMeter>;
}) {
  const [plan, setPlan] = useState(false);
  const [draft, setDraft] = useState("");
  const stage = useRef<HTMLDivElement>(null);
  const art = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  useTypingPulse(stage, { art, head }, theme !== "none" || character, meter);
  const kind = characterFor(theme);
  return (
    <div className={styles.composerStage} ref={stage} data-proposal-composer>
      {character ? <CharacterHead kind={kind} headRef={head} /> : null}
      <ComposerCard large onSubmit={(event) => event.preventDefault()}>
        {theme === "none" ? null : <DecorationBackground key={theme} theme={theme} artRef={art} />}
        <ComposerCardExpandedBody>
          <ComposerCardEditor>
            <ComposerCardEditable>
              <div aria-label={copy.placeholder} contentEditable role="textbox" suppressContentEditableWarning
                onInput={(event) => setDraft(event.currentTarget.textContent ?? "")} />
            </ComposerCardEditable>
            {draft ? null : <ComposerCardPlaceholder>{copy.placeholder}</ComposerCardPlaceholder>}
          </ComposerCardEditor>
        </ComposerCardExpandedBody>
        <ComposerCardToolbar>
          <IconButton label={copy.more}><Plus size="md" /></IconButton>
          <ComposerCardExpandedControls>
            <ComposerControl compact="label" icon={<ShieldQuestion size="sm" />} label={copy.access} />
            <ComposerPlanToggle checked={plan} label={copy.plan} onCheckedChange={setPlan} />
            <ComposerCardToolbarSpacer />
            <ContextDonutButton aria-label={copy.context} ratio={0.42} />
            <ComposerControl icon={<AiChip size="sm" />} label={copy.model} detail="medium" />
          </ComposerCardExpandedControls>
          <ComposerSendButton aria-label={copy.send} disabled={!draft} />
        </ComposerCardToolbar>
      </ComposerCard>
      {character ? <CharacterPaws kind={kind} /> : null}
    </div>
  );
}
