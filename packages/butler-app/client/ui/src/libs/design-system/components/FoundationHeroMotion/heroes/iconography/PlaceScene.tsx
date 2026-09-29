import { type IconCopy } from "./iconCopy";
import { SidebarCrop } from "./SidebarCrop";
import s from "./IconHero.module.css";

/** Scenes 4–5: the app's sidebar; its icons pop in row by row, then a click on Settings. */
export function PlaceScene({ copy }: { copy: IconCopy }) {
  return <div className={s.placeStage} data-m="place"><SidebarCrop copy={copy} /></div>;
}
