import { useEffect, useState } from "react";
import type { WallpaperContentRect } from "@/butler-ds";
import { LifecycleBackdrop } from "./Backdrop";
import { WINDOW_COPY } from "./copy";
import { LifecycleWindow, lifecycleContent } from "./LifecycleWindow";
import {
  QUIT_STATES, STAGE_MESSAGE, STARTUP_STATES, WALLPAPER_IDS, stateFromQuery,
  type LifecycleKind, type LifecycleState, type QuitState, type StartupState,
} from "./state";

/** A simulated run: each stage line stays long enough to read, like a typical warm launch / quit. */
const PLAY: Record<LifecycleKind, Array<[string, number]>> = {
  startup: [["prepare", 700], ["service", 1500], ["screen", 700], ["data", 1100]],
  quit: [["saving", 900], ["search", 600], ["storage", 800], ["connections", 600], ["services", 600], ["finishing", 700]],
};

declare global {
  interface Window {
    /** Only in `electron-preview.mjs`. */
    lifecyclePreview?: { action: (name: string) => void };
  }
}

function cycle<T>(list: readonly T[], value: T, step: number): T {
  return list[(list.indexOf(value) + step + list.length) % list.length]!;
}

function useKeyboard(kind: LifecycleKind, setState: (update: (state: LifecycleState) => LifecycleState) => void, play: () => void) {
  useEffect(() => {
    if (!window.lifecyclePreview) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const step = key === "arrowright" || key === "arrowdown" ? 1 : key === "arrowleft" || key === "arrowup" ? -1 : 0;
      setState((state) => {
        if (step && kind === "startup") return { ...state, startup: cycle(STARTUP_STATES, state.startup, step) };
        if (step) return { ...state, quit: cycle(QUIT_STATES, state.quit, step) };
        if (key === "t") return { ...state, theme: state.theme === "light" ? "dark" : "light" };
        if (key === "w") return { ...state, wallpaper: cycle(WALLPAPER_IDS, state.wallpaper, 1) };
        if (key === "s") return { ...state, surface: state.surface === "box" ? "panel" : "box" };
        if (key === "l") return { ...state, locale: state.locale === "ko-KR" ? "en-US" : "ko-KR" };
        if (key === "m") return { ...state, motion: state.motion === "auto" ? "reduced" : "auto" };
        if (key === "b") return { ...state, backdrop: state.backdrop === "still" ? "poster" : "still" };
        if (key === "f") return { ...state, forceQuit: !state.forceQuit };
        return state;
      });
      if (key === "p") play();
      if (key === "q") window.lifecyclePreview?.action("quit");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kind, play, setState]);
}

/** One window at 100vw × 100vh: inside the review page's frame, or as the real Electron window. */
export function LifecycleStage({ kind }: { kind: LifecycleKind }) {
  const [state, setState] = useState<LifecycleState>(() => stateFromQuery(new URLSearchParams(location.search)));
  const [playing, setPlaying] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const [contentRect, setContentRect] = useState<WallpaperContentRect>();
  const play = () => setRun((value) => value + 1);
  useKeyboard(kind, setState, play);

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.data?.type !== STAGE_MESSAGE) return;
      if (event.data.state) setState(event.data.state as LifecycleState);
      if (event.data.play) play();
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, []);

  useEffect(() => {
    if (!run) return undefined;
    const timers: number[] = [];
    let at = 0;
    for (const [stage, duration] of PLAY[kind]) {
      timers.push(window.setTimeout(() => setPlaying(stage), at));
      at += duration;
    }
    timers.push(window.setTimeout(() => setPlaying(null), at));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [run, kind]);

  useEffect(() => {
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add(`theme-${state.theme}`);
    document.documentElement.lang = state.locale === "ko-KR" ? "ko" : "en";
    document.title = kind === "startup" ? WINDOW_COPY[state.locale].startupTitle : WINDOW_COPY[state.locale].quitTitle;
  }, [state.theme, state.locale, kind]);

  useEffect(() => {
    if (!card) return undefined;
    const measure = () => {
      const rect = card.getBoundingClientRect();
      setContentRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    measure();
    return () => observer.disconnect();
  }, [card]);

  const shown = (playing ?? (kind === "startup" ? state.startup : state.quit)) as StartupState | QuitState;
  return (
    <LifecycleWindow
      surface={state.surface}
      content={lifecycleContent(kind, shown, WINDOW_COPY[state.locale], state.forceQuit)}
      reducedMotion={state.motion === "reduced"}
      theme={state.theme}
      cardRef={setCard}
      onAction={(action) => window.lifecyclePreview?.action(action)}
      backdrop={<LifecycleBackdrop wallpaper={state.wallpaper} backdrop={state.backdrop} theme={state.theme} contentRect={contentRect} />}
    />
  );
}
