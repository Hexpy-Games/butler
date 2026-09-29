import { AdaptiveShell, AdaptiveShellChrome, AdaptiveShellWorkspace } from "../../../../blocks/AdaptiveShell";
import { ChromeFloatingToggleLayer } from "../../../../blocks/ChromeFrame";
import { IconButton } from "../../../IconButton";
import { PanelLeft } from "../../../Icons";
import type { FocusCopy } from "./focusCopy";
import { Named } from "./Named";
import { Workspace } from "./Workspace";
import s from "./FocusHero.module.css";

/**
 * The compact app screen (tall): the sidebar folded into its drawer, its
 * toggle on the app's floating chrome layer (kept inside this window: the
 * window contains fixed layers).
 */
export function CompactShell({ copy, live = false }: { copy: FocusCopy; live?: boolean }) {
  const toggle = (
    <ChromeFloatingToggleLayer>
      <IconButton label={copy.app}><PanelLeft size="md" /></IconButton>
    </ChromeFloatingToggleLayer>
  );
  return (
    <div className={s.window} data-shell="compact">
      <AdaptiveShell leftOpen={false} rightOpen={false}>
        <AdaptiveShellChrome>{live ? <Named names={TOGGLE}>{toggle}</Named> : toggle}</AdaptiveShellChrome>
        <AdaptiveShellWorkspace><Workspace collapsed copy={copy} live={live} /></AdaptiveShellWorkspace>
      </AdaptiveShell>
    </div>
  );
}

const TOGGLE = { toggle: "button" };
