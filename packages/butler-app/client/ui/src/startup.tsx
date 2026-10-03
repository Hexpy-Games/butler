import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { startupCopy, type StartupStage } from "@/app/startupCopy";
import { StartupScreen } from "@/butler-ds/viewer/recipes/StartupScreen";
import "@/butler-ds/tokens.css";

type State = { stage: StartupStage; failed: boolean; language?: string; reducedMotion?: boolean };
const bridge = (window as Window & { butlerStartup?: {
  painted: () => void; state: () => Promise<State>; action: (action: string) => Promise<void>;
  subscribe: (listener: (state: State) => void) => () => void;
} }).butlerStartup;

function Startup() {
  const [hydrated, setHydrated] = useState(!bridge);
  const [state, setState] = useState<State>({ stage: "starting", failed: false });
  const [themeName, setThemeName] = useState<"light" | "dark">(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const [language, setLanguage] = useState(navigator.language);
  useEffect(() => {
    const theme = matchMedia("(prefers-color-scheme: dark)");
    const update = () => { document.body.className = theme.matches ? "theme-dark" : "theme-light"; setThemeName(theme.matches ? "dark" : "light"); };
    update();
    requestAnimationFrame(() => requestAnimationFrame(() => bridge?.painted()));
    theme.addEventListener("change", update);
    const unsubscribe = bridge?.subscribe((next) => setState((prior) => ({ ...prior, ...next })));
    void bridge?.state().then((next) => { setState(next); setLanguage(next.language ?? navigator.language); setHydrated(true); });
    return () => { theme.removeEventListener("change", update); unsubscribe?.(); };
  }, []);
  useEffect(() => { document.body.dataset.motion = state.reducedMotion ? "reduced" : "auto"; }, [state.reducedMotion]);
  const copy = startupCopy[language.startsWith("ko") ? "ko" : "en"];
  return <StartupScreen fill theme={themeName} working={hydrated} reducedMotion={state.reducedMotion ? true : undefined} status={state.failed ? copy.failed : copy[state.stage]} failed={state.failed}
    retryLabel={copy.retry} logsLabel={copy.logs}
    onRetry={() => { void bridge?.action("retry"); }} onLogs={() => { void bridge?.action("logs"); }} />;
}
createRoot(document.getElementById("root")!).render(<Startup />);
