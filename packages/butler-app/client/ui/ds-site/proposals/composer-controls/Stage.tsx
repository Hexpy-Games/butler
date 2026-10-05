import { useEffect, useRef, useState } from "react";
import { setAppCopyLanguage } from "@/app/copy";
import { Box, Stack, Wallpaper, type WallpaperContentRect } from "@/butler-ds";
import { useComposerStore } from "@/components/conversation/composerStore";
import { PAGE_COPY } from "./copy";
import { installComposerProposal, proposalAttachment, TYPING_TEXT } from "./fixture";
import { ProposalComposer } from "./ProposalComposer";
import { STAGE_MESSAGE, stateFromQuery, WALLPAPERS, type StageState } from "./state";

function usePhoneWidth(): boolean {
  const query = "(width <= 640px)";
  const [phone, setPhone] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setPhone(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return phone;
}

/**
 * The preview rendered inside the width frame (an iframe), so viewport media queries such as the
 * 44px touch targets resolve at the chosen width. The outer page posts state changes in.
 */
export function ComposerControlsStage() {
  const [state, setState] = useState<StageState>(() => stateFromQuery(new URLSearchParams(location.search)));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const phone = usePhoneWidth();
  const [block, setBlock] = useState<HTMLDivElement | null>(null);
  const [contentRect, setContentRect] = useState<WallpaperContentRect>();

  useEffect(() => {
    if (!block) return undefined;
    const measure = () => {
      const rect = block.getBoundingClientRect();
      setContentRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(block);
    measure();
    return () => observer.disconnect();
  }, [block]);

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.data?.type !== STAGE_MESSAGE) return;
      setState(event.data.state as StageState);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, []);

  useEffect(() => {
    const restore = installComposerProposal(state.locale, fileInputRef);
    setReady(true);
    return restore;
    // The fixture is installed once; later changes go through the store below.
  }, []);

  useEffect(() => {
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add(`theme-${state.theme}`);
  }, [state.theme]);

  useEffect(() => { setAppCopyLanguage(state.locale); }, [state.locale]);

  useEffect(() => {
    const store = useComposerStore.getState();
    store.setText(state.mode === "typing" ? TYPING_TEXT[state.locale] : "");
    useComposerStore.setState({ activeTurn: state.mode === "streaming", canSend: state.mode === "typing" });
  }, [state.mode, state.locale]);

  useEffect(() => { useComposerStore.setState({ planMode: state.plan }); }, [state.plan]);
  useEffect(() => { useComposerStore.setState({ attachments: state.attachment ? [proposalAttachment] : [] }); }, [state.attachment]);

  return (
    <Stack UNSAFE_style={{ height: "100dvh", "--workspace-left-radius": "0px" }} justify="end" gap="none">
      <Wallpaper source={WALLPAPERS[state.wallpaper]} scope="viewport" contentRect={contentRect} />
      {/* Bottom and side insets of the floating composer (ComposerCard `.floating`): 22px + safe area, --adaptive-composer-inset. */}
      <Box paddingX={phone ? "md" : "2xl"} paddingY={phone ? "lg" : "xl"}>
        {ready ? (
          <ProposalComposer
            key={state.locale}
            variant={state.variant}
            copy={PAGE_COPY[state.locale].composer}
            expanded={state.mode !== "folded"}
            question={state.question}
            fileInputRef={fileInputRef}
            blockRef={setBlock}
          />
        ) : null}
      </Box>
    </Stack>
  );
}
