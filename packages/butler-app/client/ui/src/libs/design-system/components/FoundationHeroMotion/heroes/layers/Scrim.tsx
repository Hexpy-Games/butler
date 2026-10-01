import { cn } from "../../../../lib/utils";
import dialog from "../../../Dialog/Dialog.module.css";
import s from "./LayersHero.module.css";

/** The overlay layer: the dialog's scrim over the whole window. */
export function Scrim() {
  return <span className={cn(dialog.overlay, s.scrim)} data-slot="dialog-overlay" />;
}
