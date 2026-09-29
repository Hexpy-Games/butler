import { TitlebarShell } from "../../../../blocks/TitlebarShell";
import type { FocusCopy } from "./focusCopy";
import { Composer } from "./Composer";
import { Turn } from "./Turn";
import s from "./FocusHero.module.css";

/** The workspace: the conversation's titlebar (collapsed: room for the floating sidebar toggle), the exchange, the composer at the foot. */
export function Workspace({ copy, live, collapsed = false }: { copy: FocusCopy; live: boolean; collapsed?: boolean }) {
  return (
    <>
      <TitlebarShell collapsed={collapsed} dataTestClass="custom-titlebar" title={copy.chat} />
      <div className={s.conversation}>
        <Turn copy={copy} />
        <div className={s.composerSlot}><Composer copy={copy} live={live} /></div>
      </div>
    </>
  );
}
