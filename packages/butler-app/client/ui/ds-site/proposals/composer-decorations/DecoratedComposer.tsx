import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ComposerCard, ComposerCardCompactPreview, ComposerCardEditable, ComposerCardEditor, ComposerCardExpandedBody,
  ComposerCardExpandedControls, ComposerCardPlaceholder, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerControl,
  ComposerSendButton, ConversationScroll, ConversationShell, IconButton, Plus, Popover, PopoverTrigger, ShieldQuestion, Wallpaper,
  type WallpaperSource,
} from "@/butler-ds";
import { CherryCanvas } from "./CherryCanvas";
import type { ProposalCopy } from "./copy";
import { CHERRY_BLOSSOM_MODULE, SHORELINE_REGISTRY, SHORELINE_SOURCE, type DecorationTheme } from "./decorationScenes";
import { SHORE_PRESETS, shoreStyle, type ShoreParams } from "./shoreTuning";
import { CharacterHead, CharacterPaws, characterFor } from "./EdgeCharacter";
import styles from "./ComposerDecorations.module.css";

// Conversation.tsx passes these to ConversationShell on the new chat screen (empty state).
const TITLE_ICON_SIZE = "clamp(40px, 5.333vw, 54px)";
const TITLE_ICON_GUTTER = "calc(clamp(40px, 5.333vw, 54px) + clamp(40px, 5.333vw, 54px) + 10px)";
// Conversation.tsx DEFAULT_COMPOSER_RESERVE-like: composer height + float bottom + content gap.
const COMPOSER_RESERVE = 120;

/**
 * The card background: first child of the unchanged ComposerCard. Absolutely fills the form
 * (TintedGlass's backdrop-filter makes the form its containing block and stacking context),
 * paints above the glass fill and below every editor/toolbar node (z-index -1), clipped by the
 * card radius. Nothing else sits behind the text or the controls: readability comes from how
 * the art is composed. It never reacts to typing.
 * - Shoreline: DS Wallpaper (container scope; the module's own day/night grade follows the theme)
 *   on a canvas whose middle (the waterline) sits where ShoreParams put it, plus whole-scene
 *   grades (exposure, sand highlight, a vertical tone gradient); see shoreTuning.ts.
 * - Cherry blossom: a transparent canvas; the card's own glass shows through.
 */
function DecorationBackground({ theme, tone, shore, lush }: {
  theme: Exclude<DecorationTheme, "none">;
  tone: "light" | "dark";
  shore: ShoreParams;
  lush: boolean;
}) {
  return (
    <div aria-hidden="true" className={styles.background} data-composer-decoration={theme}
      style={theme === "shoreline" ? shoreStyle(shore) : undefined}>
      <div className={styles.art} data-scene={theme} data-tone={tone}>
        {theme === "shoreline" ? (
          <Wallpaper source={SHORELINE_SOURCE} registry={SHORELINE_REGISTRY} scope="container" tone={tone} pauseOnBattery dataTestClass="composer-decoration-scene" />
        ) : (
          <CherryCanvas fragment={CHERRY_BLOSSOM_MODULE.fragment} lush={lush} key={String(lush)} />
        )}
      </div>
      {theme === "shoreline" ? <div className={styles.shoreHighlight} data-tone={tone} /> : null}
      {theme === "shoreline" ? <div className={styles.shoreGradient} /> : null}
    </div>
  );
}

/**
 * The new chat screen as Conversation.tsx composes it: ConversationShell (empty-state gutters),
 * the page wallpaper, and Composer.tsx's ComposerCard (floating, large) with ComposerInputSurface
 * and ComposerToolbar's DS parts and props. Only the decoration layer and the character are new.
 */
export function NewChatScreen({ copy, theme, character, wallpaper, tone, shore = SHORE_PRESETS.d, lush = true, engagedAtStart }: {
  copy: ProposalCopy;
  theme: DecorationTheme;
  character: boolean;
  wallpaper: WallpaperSource;
  tone: "light" | "dark";
  shore?: ShoreParams;
  lush?: boolean;
  engagedAtStart?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [engaged, setEngaged] = useState(Boolean(engagedAtStart));
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const editable = useRef<HTMLDivElement>(null);
  // useComposerPresentation: a pointer down outside the composer collapses it.
  useEffect(() => {
    const collapse = (event: PointerEvent) => {
      if (event.target instanceof Node && wrapRef.current?.contains(event.target)) return;
      setEngaged(false);
    };
    document.addEventListener("pointerdown", collapse, true);
    return () => document.removeEventListener("pointerdown", collapse, true);
  }, []);
  const engage = () => {
    setEngaged(true);
    requestAnimationFrame(() => editable.current?.focus());
  };
  const kind = characterFor(theme);
  return (
    <ConversationShell composerReserve={COMPOSER_RESERVE} contentGutter={TITLE_ICON_GUTTER} titleIconGap="10px" titleIconSize={TITLE_ICON_SIZE}>
      <Wallpaper source={wallpaper} scope="container" tone={tone} />
      <ConversationScroll masked={false} scrollable={false}>{null}</ConversationScroll>
      <ComposerCard large floating expanded={engaged} containerRef={(node) => { wrapRef.current = node; setWrap(node); }}
        onFocusCapture={() => setEngaged(true)} onSubmit={(event) => event.preventDefault()}>
        {theme === "none" ? null : <DecorationBackground key={theme} theme={theme} tone={tone} shore={shore} lush={lush} />}
        <ComposerCardExpandedBody>
          <ComposerCardEditor>
            <ComposerCardEditable>
              <div aria-label={copy.messageComposer} contentEditable role="textbox" ref={editable} suppressContentEditableWarning
                data-max-auto-rows={8} onInput={(event) => setDraft(event.currentTarget.textContent ?? "")} />
            </ComposerCardEditable>
            {draft ? null : <ComposerCardPlaceholder>{copy.placeholder}</ComposerCardPlaceholder>}
          </ComposerCardEditor>
        </ComposerCardExpandedBody>
        <ComposerCardToolbar>
          {/* The app wraps these three in PopoverTrigger asChild (menus); kept so touch sizing matches. */}
          <Popover><PopoverTrigger asChild><IconButton label={copy.more}><Plus size="md" /></IconButton></PopoverTrigger></Popover>
          <ComposerCardCompactPreview aria-label={copy.messageComposer} data-empty={!draft.trim()}
            onPointerDown={(event) => { event.preventDefault(); engage(); }} onClick={engage}>
            {draft.trim() || copy.placeholder}
          </ComposerCardCompactPreview>
          <ComposerCardExpandedControls>
            <Popover><PopoverTrigger asChild>
              <ComposerControl aria-label={`${copy.permission}: ${copy.askFirst}`} compact="icon" icon={<ShieldQuestion size="md" />}
                permissionTone="ask" label={<span>{copy.askFirst}</span>} />
            </PopoverTrigger></Popover>
            <ComposerCardToolbarSpacer />
            <Popover><PopoverTrigger asChild>
              <ComposerControl compact="label" label={<span>{copy.model}</span>} detail={<span>{copy.reasoning}</span>} />
            </PopoverTrigger></Popover>
          </ComposerCardExpandedControls>
          <ComposerCardExpandedControls>
            <ComposerSendButton aria-label={copy.send} disabled={!draft.trim()} />
          </ComposerCardExpandedControls>
        </ComposerCardToolbar>
        <input hidden multiple type="file" tabIndex={-1} aria-hidden="true" />
      </ComposerCard>
      {character && wrap ? createPortal(<CharacterHead kind={kind} />, wrap) : null}
      {character && wrap ? createPortal(<CharacterPaws kind={kind} />, wrap) : null}
    </ConversationShell>
  );
}
