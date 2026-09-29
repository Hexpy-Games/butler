import { useLayoutEffect, useRef, type ReactNode } from "react";
import s from "./FocusHero.module.css";

/** Names elements inside a DS component as marks (`data-a`) without wrapping them: `names` maps a mark to a selector inside the children. */
export function Named({ names, children }: { names: Record<string, string>; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    for (const [name, selector] of Object.entries(names)) ref.current?.querySelector(selector)?.setAttribute("data-a", name);
  }, [names]);
  return <span className={s.named} ref={ref}>{children}</span>;
}
