import { ChromeFloatingToggleLayer } from "../../../../blocks/ChromeFrame";
import { TitlebarShell } from "../../../../blocks/TitlebarShell";
import { ButtonContainer } from "../../../ButtonContainer";
import { IconButton } from "../../../IconButton";
import { MoreHorizontal, PanelLeft, PanelLeftOpen, PanelRight } from "../../../Icons";
import { type LayersCopy } from "./layersCopy";
import s from "./LayersHero.module.css";

/** The sticky layer: the window chrome's sidebar toggle and the titlebar pinned over the workspace. */
export function Sticky({ copy, compact }: { copy: LayersCopy; compact: boolean }) {
  return (
    <>
      <div className={s.titlebar}>
        <TitlebarShell
          collapsed={compact}
          dragRegion
          title={copy.sessions[0]}
          trailing={
            <ButtonContainer size="icon-sm">
              <IconButton label={copy.sessionActions}>
                <MoreHorizontal size="md" />
              </IconButton>
              <IconButton label={copy.showRight}>
                <PanelRight size="md" />
              </IconButton>
            </ButtonContainer>
          }
        />
      </div>
      <ChromeFloatingToggleLayer>
        <IconButton label={copy.showLeft}>
          {compact ? <PanelLeft size="md" /> : <PanelLeftOpen size="md" />}
        </IconButton>
      </ChromeFloatingToggleLayer>
    </>
  );
}
