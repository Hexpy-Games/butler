import type { ReactNode } from "react";

/**
 * An edge character on the card's top edge, anchored to the form's top (not the
 * wrap, so a notice above never moves it): `behind` paints under the card (it
 * hides the part below the edge), `front` over its top edge. Decorative only.
 */
export interface ComposerCardEdge {
  behind?: ReactNode;
  front?: ReactNode;
  /**
   * Px the edge content rises above the card (set by the preset, e.g.
   * `composerDecorationEdge`). The wrap reserves it as top padding, so
   * measuring the wrap includes it; also on the wrap as `data-edge-reserve`
   * and `--composer-edge-reserve`.
   */
  reserveTop?: number;
}
