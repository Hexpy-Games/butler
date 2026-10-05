import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  ComposerCard, ComposerCardCompactPreview, ComposerCardEditable, ComposerCardEditor, ComposerCardExpandedBody,
  ComposerCardExpandedControls, ComposerCardPlaceholder, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerControl,
  ComposerSendButton, ConversationScroll, ConversationShell, IconButton, Plus, Popover, PopoverTrigger, ShieldQuestion, Wallpaper,
  type WallpaperSource,
} from "@/butler-ds";
import type { ProposalCopy } from "./copy";
import { DECORATION_REGISTRY, DECORATION_SOURCES, type DecorationTheme } from "./decorationScenes";
import { CharacterHead, CharacterPaws, characterFor } from "./EdgeCharacter";
import { SCRIM_POOL, useLocalScrim } from "./useLocalScrim";
import { useTypingPulse, type PulseMeter } from "./useTypingPulse";
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
 * card radius. Scene = DS Wallpaper (container scope, fixed light tone: the same art in both
 * themes). Scrim = local halos of the TintedGlass tint behind the text lines and controls only.
 */
function DecorationBackground({ theme, artRef, meter }: {
  theme: Exclude<DecorationTheme, "none">;
  artRef: RefObject<HTMLDivElement | null>;
  meter: RefObject<PulseMeter>;
}) {
  const halos = useRef<HTMLDivElement>(null);
  useLocalScrim(halos, true, meter);
  return (
    <div aria-hidden="true" className={styles.background} data-composer-decoration={theme}>
      <div className={styles.art} data-scene={theme} ref={artRef}>
        <Wallpaper source={DECORATION_SOURCES[theme]} registry={DECORATION_REGISTRY} scope="container" tone="light" pauseOnBattery
          dataTestClass="composer-decoration-scene" />
      </div>
      <div className={styles.halos} ref={halos}>
        {Array.from({ length: SCRIM_POOL }, (_, index) => <div className={styles.halo} key={index} />)}
      </div>
    </div>
  );
}

/**
 * The new chat screen as Conversation.tsx composes it: ConversationShell (empty-state gutters),
 * the page wallpaper, and Composer.tsx's ComposerCard (floating, large) with ComposerInputSurface
 * and ComposerToolbar's DS parts and props. Only the decoration layer and the character are new.
 */
export function NewChatScreen({ copy, theme, character, wallpaper, tone, meter, engagedAtStart }: {
  copy: ProposalCopy;
  theme: DecorationTheme;
  character: boolean;
  wallpaper: WallpaperSource;
  tone: "light" | "dark";
  meter: RefObject<PulseMeter>;
  engagedAtStart?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [engaged, setEngaged] = useState(Boolean(engagedAtStart));
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const editable = useRef<HTMLDivElement>(null);
  const art = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  useTypingPulse(wrapRef, { art, head }, theme !== "none" || character, meter);
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
        {theme === "none" ? null : <DecorationBackground key={theme} theme={theme} artRef={art} meter={meter} />}
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
      {character && wrap ? createPortal(<CharacterHead kind={kind} headRef={head} />, wrap) : null}
      {character && wrap ? createPortal(<CharacterPaws kind={kind} />, wrap) : null}
    </ConversationShell>
  );
}
