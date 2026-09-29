import s from "./FocusHero.module.css";

export type KeyId = "tab" | "right" | "left" | "back";

/** The ring: one overlay, sized and rounded per stop (the control's own corner). */
export const Ring = ({ name }: { name: string }) => <span className={s.ring} data-t={name} />;

export const RANGE = ["day", "week", "month"] as const;
