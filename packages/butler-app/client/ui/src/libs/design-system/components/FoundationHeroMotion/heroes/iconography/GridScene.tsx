import type { HeroLayout } from "../shared/grid";
import { IconGrid } from "./IconGridFinale";

/** Scene 6, the finale and the poster: the icon set filling the frame. */
export function GridScene({ layout }: { layout: HeroLayout }) {
  return <IconGrid layout={layout} />;
}
