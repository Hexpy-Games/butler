import { Tag } from "../../../Tag";
import { Reveal as R } from "../shared/Reveal";
import { MODES, tokenValue, type LayoutCopy } from "./layoutCopy";
import { DeviceFrame } from "./DeviceFrame";
import { AppScreen } from "./LayoutShell";
import { Readout } from "./Readout";
import s from "./LayoutHero.module.css";

/** The measures on the window's rim: [part, axis, token, value]. */
function measures(): Array<[part: string, axis: "v" | "h", label: string]> {
  const value = (token: string) => `${token} · ${tokenValue(token).replace(/px$/u, "")}`;
  return [
    ["bar", "v", value("--titlebar-height")],
    ["bar-compact", "v", "--titlebar-height · 56"],
    ["side", "h", value("--sidebar-width")],
    ["read", "h", value("--page-max-width-reading")],
    ["read-medium", "h", value("--page-max-width-reading")],
    ["drawer", "h", "--adaptive-drawer-width · 100vw"],
  ];
}

/**
 * The window scene: Butler's app shell in a window, one layer per mode
 * (each the real AdaptiveShell composition, reflowing live as the window's
 * width animates), its measures on the rim beside the edge each belongs to,
 * the handle on the right edge and the width and mode above it.
 */
export function WindowScene({ copy }: { copy: LayoutCopy }) {
  return (
    <div className={s.stage} data-m="stage">
      <div className={s.win} data-m="win" data-t="win">
        <div className={s.device} data-t="dev">
          {MODES.map((mode) => (
            <div className={s.layer} data-t={`ly-${mode}`} key={mode}>
              <DeviceFrame label={mode}><AppScreen copy={copy} mode={mode} open={mode === "expanded"} /></DeviceFrame>
            </div>
          ))}
          {/* Compact's drawer, open: it slides in over the whole width, the conversation staying where it is under it. */}
          <div className={s.layer} data-t="ly-drawer">
            <DeviceFrame label="drawer"><AppScreen copy={copy} mode="compact" open /></DeviceFrame>
          </div>
        </div>
      </div>
      <div className={s.rim} data-t="rim">
        {measures().map(([part, axis, label]) => (
          <span key={part}>
            <span className={s.dim} data-axis={axis} data-part={part} data-t={`dm-${part}`} />
            <span className={s.tag} data-part={part} data-t={`tg-${part}`}><Tag><R name={`tl-${part}`}>{label}</R></Tag></span>
          </span>
        ))}
        <span className={s.leader} data-t="ld-bar" />
        <span className={s.handle} data-t="handle" />
        <Readout className={s.readout} id="ro" />
      </div>
    </div>
  );
}
