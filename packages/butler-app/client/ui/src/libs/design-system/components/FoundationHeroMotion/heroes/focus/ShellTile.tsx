import type { FocusCopy } from "./focusCopy";
import { CompactShell } from "./CompactShell";
import { WideShell } from "./WideShell";
import s from "./FocusHero.module.css";

/** Finale: the app with the ring resting on Send (wide window, or the compact screen on the tall canvas). */
export function ShellTile({ copy }: { copy: FocusCopy }) {
  return (
    <div className={`${s.routes} ${s.tileWindow}`} data-still="">
      <div className={s.routeStage} data-layout-only="wide"><WideShell copy={copy} /></div>
      <div className={s.routeStage} data-layout-only="tall"><CompactShell copy={copy} /></div>
    </div>
  );
}
