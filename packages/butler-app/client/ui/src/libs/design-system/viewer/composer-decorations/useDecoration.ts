import { useEffect, useRef } from "react";
import { coastalScene } from "./coastalScene";
import { decorationRuntime, type DecorationMetrics } from "./decorationRuntime";
import type { DecorationSettings } from "./types";

/** Listens to native committed edits without accessing text, caret, clipboard or keys. */
export function useDecoration(settings: DecorationSettings) {
  const root = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLOutputElement>(null);
  const coast = useRef<ReturnType<typeof coastalScene>>(null);
  useEffect(() => {
    const canvas = root.current?.querySelector("canvas");
    coast.current = canvas ? coastalScene(canvas) : null;
    return () => { coast.current?.dispose(); coast.current = null; };
  }, [settings.theme]);
  useEffect(() => {
    const art = root.current;
    const input = surface.current?.querySelector("textarea");
    if (!art || !input) return;
    const report = (m: DecorationMetrics) => {
      const output = readout.current;
      if (!output) return;
      output.dataset.metrics = JSON.stringify(m);
      output.textContent = `${m.edits ? (m.mainMs / m.edits).toFixed(3) : "0.000"} ms/edit · ${m.frames} frames · ${m.edits} edits · ${m.active ? "responding" : "idle: 0 scheduled work"}`;
    };
    const runtime = decorationRuntime(art, settings, report, coast.current?.draw);
    let composing = false;
    let commitPending = false;
    let commitFrame = 0;
    const flush = () => {
      cancelAnimationFrame(commitFrame); commitFrame = 0;
      if (commitPending) runtime.pulse();
      commitPending = false;
    };
    const start = () => { composing = true; commitPending = false; };
    const end = (event: CompositionEvent) => {
      composing = false;
      // Only the empty/nonempty commit signal; never retain composition content.
      commitPending = event.data.length > 0;
      if (commitPending) commitFrame = requestAnimationFrame(flush);
    };
    const edit = (event: Event) => {
      const native = event as InputEvent;
      if (!native.isTrusted || composing || native.isComposing) return;
      if (commitPending) flush();
      else runtime.pulse();
    };
    const blur = () => { cancelAnimationFrame(commitFrame); commitPending = false; runtime.stop(); };
    if (settings.mode === "interactive" && settings.theme !== "none") {
      input.addEventListener("input", edit);
      input.addEventListener("compositionstart", start);
      input.addEventListener("compositionend", end);
      input.addEventListener("blur", blur);
    }
    return () => {
      cancelAnimationFrame(commitFrame);
      input.removeEventListener("input", edit);
      input.removeEventListener("compositionstart", start);
      input.removeEventListener("compositionend", end);
      input.removeEventListener("blur", blur);
      runtime.dispose();
    };
  }, [settings]);
  return { root, surface, readout };
}
