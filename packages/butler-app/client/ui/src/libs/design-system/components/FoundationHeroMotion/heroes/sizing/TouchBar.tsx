import { TitlebarShell } from "../../../../blocks/TitlebarShell";
import { ButtonContainer } from "../../../ButtonContainer";
import { IconButton } from "../../../IconButton";
import { MoreHorizontal, PanelLeft, PanelRight } from "../../../Icons";
import type { SizingCopy } from "./sizingCopy";
import { Subtitle } from "./Subtitle";
import s from "./SizingHero.module.css";

/** The cursor: an arrow whose tip rests on the target's centre. */
function Cursor() {
  return (
    <svg aria-hidden="true" className={s.cursor} data-t="cur" viewBox="0 0 16 20">
      <path d="M1 1 L1 16 L5 12 L8 19 L10.5 18 L7.5 11 L13 11 Z" />
    </svg>
  );
}

/**
 * The real titlebar of a conversation (TitlebarShell with the product's
 * session menu and right-panel toggle). Each icon button sits in its hit
 * target (`target`): the pointer's 30, or touch's 44 — as on a touch screen,
 * the target is the button's own box, so neighbours move apart and never
 * overlap; the bar grows to the phone titlebar's height around them. The
 * dashed halo is that box. `name` prefixes the timeline's
 * parts; `pointer` adds the cursor and the fingertip on the second button.
 */
export function TouchBar({ copy, name, touch = false, pointer = false }: { copy: SizingCopy; name?: string; touch?: boolean; pointer?: boolean }) {
  const icons = [[copy.sessionMenu, <MoreHorizontal key="i" size="md" />], [copy.rightPanel, <PanelRight key="i" size="md" />]] as const;
  return (
    <div className={s.strip} data-touch={touch ? "" : undefined}>
      <span className={s.stripHeight} data-m={name ? `${name}-bar` : undefined} data-t={name ? `${name}-bar` : undefined} />
      <span className={s.stripBar}>
      <span className={s.stripToggle}><IconButton label={copy.showSidebar}><PanelLeft size="md" /></IconButton></span>
      <TitlebarShell
        subtitle={<Subtitle copy={copy} />}
        title={copy.session}
        trailing={
          <ButtonContainer size="icon-sm">
            {icons.map(([label, icon], k) => (
              <span className={s.target} data-t={name ? `${name}-t${k}` : undefined} key={label}>
                <span className={s.halo} data-t={name ? `${name}-h${k}` : undefined} />
                <IconButton label={label}>{icon}</IconButton>
                {pointer && k === 1 ? <><span className={s.finger} data-t="fin" /><Cursor /></> : null}
              </span>
            ))}
          </ButtonContainer>
        }
      />
      </span>
    </div>
  );
}
