import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { IconButton } from "../../components/IconButton";
import { tintedGlassSurfaceClassName } from "../../components/TintedGlass";
import { cn } from "../../lib/utils";
import styles from "./DocumentFormatBar.module.css";

export interface DocumentFormatAction {
  id: string;
  /** A word: 굵게, 제목, 목록, 블록 추가 (the tooltip and accessible name). */
  label: string;
  icon: ReactNode;
  /** A format that is on for the selection (bold text, a heading): pressed. */
  pressed?: boolean;
  onPress: () => void;
}

export interface DocumentFormatBarProps {
  /** The selection's box in viewport coordinates; null hides the bar. */
  anchor: { top: number; left: number; width: number; bottom: number } | null;
  actions: DocumentFormatAction[];
  /** Names the toolbar for assistive tech. */
  label: string;
}

/** Gap between the selection and the bar, and the bar and the viewport edge. */
const GAP = 8;

/**
 * The floating format bar over a document selection: a glass row of icon buttons centred above the
 * selection (below it when there is no room above), kept inside the viewport. Buttons keep the editor's
 * selection: pressing one never moves focus out of the text.
 */
export function DocumentFormatBar({ anchor, actions, label }: DocumentFormatBarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!anchor || !bar) { setPlace(null); return; }
    const { width, height } = bar.getBoundingClientRect();
    const above = anchor.top - GAP - height;
    const top = above >= GAP ? above : anchor.bottom + GAP;
    const centre = anchor.left + anchor.width / 2 - width / 2;
    const left = Math.min(Math.max(centre, GAP), window.innerWidth - width - GAP);
    setPlace({ top, left });
  }, [anchor]);
  if (!anchor) return null;
  const style = { "--format-bar-top": `${place?.top ?? 0}px`, "--format-bar-left": `${place?.left ?? 0}px` } as CSSProperties;
  return (
    <div ref={ref} aria-label={label} className={cn(tintedGlassSurfaceClassName, styles.bar)} data-glass="popover"
      data-placed={place ? "true" : undefined} data-slot="document-format-bar" role="toolbar" style={style}
      onMouseDown={(event) => event.preventDefault()}>
      {actions.map((action) => (
        <IconButton key={action.id} label={action.label} pressed={action.pressed} selected={action.pressed} onClick={action.onPress}>
          {action.icon}
        </IconButton>
      ))}
    </div>
  );
}
