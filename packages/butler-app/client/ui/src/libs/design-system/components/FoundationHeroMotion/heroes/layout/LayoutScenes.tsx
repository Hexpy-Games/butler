import { Readout } from "./Readout";
import s from "./LayoutHero.module.css";

/** Tall canvas: the width and mode in the frame's corner, whatever the camera's zoom. */
export const Hud = () => <Readout className={s.hud} id="hu" />;
