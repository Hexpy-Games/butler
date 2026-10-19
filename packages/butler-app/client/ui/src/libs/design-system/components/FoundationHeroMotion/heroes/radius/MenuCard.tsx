import { cn } from "../../../../lib/utils";
import menu from "../../../DropdownMenu/DropdownMenu.module.css";
import { tintedGlassSurfaceClassName } from "../../../TintedGlass";
import { type RadiusCopy } from "./radiusCopy";

/**
 * An overlay menu as DropdownMenu draws it: popover radius (12), its 6px inset, 32px rows at the control radius (8).
 * The plain wrapper keeps the surface out of grid and flex layouts, where its popover z-index would lift the glass
 * over the Wear scene's arc.
 */
export function MenuCard({ copy }: { copy: RadiusCopy }) {
  return (
    <div>
      <div className={cn(tintedGlassSurfaceClassName, menu.content)} data-glass="popover" data-radius="popover" data-slot="dropdown-menu-content">
        {[copy.rename, copy.duplicate, copy.archive].map((item) => (
          <div className={menu.item} data-slot="dropdown-menu-item" data-variant="default" key={item}>{item}</div>
        ))}
      </div>
    </div>
  );
}
