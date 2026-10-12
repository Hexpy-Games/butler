// The two display layers of a drifting print: the base shows the current keyframe (or live event frames), the top
// fades the next keyframe in. Frames reach them from the engine's WebGL canvas (drawn in the same task).

export interface DriftLayers {
  /** Copies the WebGL canvas's frame (drawn this task) into layer 0 (base) or 1 (top), shown from the first copy on. */
  present(layer: 0 | 1): void;
  /** Sets a layer's opacity (rounded to 1/1000); false when it did not change. */
  opacity(layer: 0 | 1, value: number): boolean;
  /** The two opacities now (base, top), for the debug state. */
  opacities(): readonly [number, number];
  /** The faded-in top becomes the base: its frame is copied down and it hides again. */
  promote(): void;
  /** Hides both layers and frees their pixels; the WebGL canvas shows again. */
  hide(): void;
  dispose(): void;
}

const COVERED = "driftCovered";

/**
 * Layers over `source` (the engine's WebGL canvas). While they show, `source` is
 * marked `data-drift-covered` (hidden by the CSS module: it keeps drawing frames,
 * but only the layers composite). A 2D `drawImage` copies each frame; it is a
 * GPU copy, made once per keyframe at rest and once per event frame.
 */
export function createDriftLayers(source: HTMLCanvasElement, base: HTMLCanvasElement, top: HTMLCanvasElement): DriftLayers {
  const layers = [base, top] as const;
  const contexts: Array<CanvasRenderingContext2D | null> = [null, null];
  const opacities = [1, 0];
  let shown = false;

  const context = (layer: 0 | 1) => {
    contexts[layer] ??= layers[layer].getContext("2d", { alpha: false });
    return contexts[layer];
  };
  const fit = (canvas: HTMLCanvasElement) => {
    if (canvas.width !== source.width) canvas.width = source.width;
    if (canvas.height !== source.height) canvas.height = source.height;
  };
  const setOpacity = (layer: 0 | 1, value: number) => {
    const rounded = Math.round(value * 1000) / 1000;
    if (opacities[layer] === rounded) return false;
    opacities[layer] = rounded;
    layers[layer].style.opacity = String(rounded);
    return true;
  };
  const show = () => {
    if (shown) return;
    shown = true;
    base.hidden = false;
    top.hidden = false;
    source.dataset[COVERED] = "";
  };

  return {
    present(layer) {
      const target = context(layer);
      if (!target) return;
      fit(layers[layer]);
      target.drawImage(source, 0, 0);
      // The base must hold a frame before anything shows (an opaque empty canvas paints black).
      if (layer === 0) show();
    },
    opacity: setOpacity,
    opacities: () => [opacities[0]!, opacities[1]!],
    promote() {
      const target = context(0);
      if (target) {
        fit(base);
        target.drawImage(top, 0, 0);
      }
      setOpacity(0, 1);
      setOpacity(1, 0);
    },
    hide() {
      shown = false;
      delete source.dataset[COVERED];
      for (const canvas of layers) {
        canvas.hidden = true;
        canvas.width = 0;
        canvas.height = 0;
      }
      setOpacity(1, 0);
    },
    dispose() {
      delete source.dataset[COVERED];
    },
  };
}
