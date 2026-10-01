import { Box } from "../../../Box";
import { Typo } from "../../../Typo";
import { type RadiusCopy } from "./radiusCopy";
import s from "./RadiusHero.module.css";

/** An overlay menu at the popover radius (12). */
export function MenuCard({ copy }: { copy: RadiusCopy }) {
  return (
    <Box border="hairline" padding="xs" radius="popover" surface="overlay">
      {[copy.rename, copy.duplicate, copy.archive].map((item) => <div className={s.menuRow} key={item}><Typo.Body>{item}</Typo.Body></div>)}
    </Box>
  );
}
