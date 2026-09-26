import type { CSSProperties } from "react";
import { Button } from "../../components/Button";
import { tokenAnchor } from "../searchIndex";
import { tokenCatalog } from "./catalog";
import styles from "../DesignSystemViewer.module.css";

/** A token name that opens its foundations row; color tokens carry a live swatch. */
export function TokenChip({ name, onOpen }: { name: string; onOpen: (page: string) => void }) {
  const token = tokenCatalog.find((entry) => entry.name === name);
  const swatch = token?.category === "color"
    ? <span aria-hidden="true" className={styles.swatchDot} style={{ "--swatch": `var(${name})` } as CSSProperties} />
    : undefined;
  return (
    <Button size="xs" variant="outline" iconStart={swatch} text={name} disabled={!token}
      onClick={() => token && onOpen(`foundations/${token.category}#${tokenAnchor(name)}`)} />
  );
}
