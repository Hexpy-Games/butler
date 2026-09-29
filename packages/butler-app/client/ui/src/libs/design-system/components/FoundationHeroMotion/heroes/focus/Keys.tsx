import { Kbd } from "../../../Kbd";
import type { KeyId } from "./FocusScenes";
import s from "./FocusHero.module.css";

const CAPS: Record<KeyId, string[]> = { tab: ["Tab"], right: ["→"], left: ["←"], back: ["⇧", "Tab"] };

/** A key cap stack: the key pressed now shows (cut in place). */
export function Keys({ prefix, keys }: { prefix: string; keys: KeyId[] }) {
  return <span className={s.keys}>{keys.map((id) => <span className={s.key} data-t={`${prefix}-${id}`} key={id}><Kbd keys={CAPS[id]} /></span>)}</span>;
}
