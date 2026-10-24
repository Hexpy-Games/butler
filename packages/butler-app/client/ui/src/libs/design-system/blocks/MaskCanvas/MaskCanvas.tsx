import { useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { MaskCanvasProps } from "./MaskCanvas.types";

export type * from "./MaskCanvas.types";
import { drawSegment, isBlank, maskBlob, redraw, type MaskStroke } from "./maskStrokes";
import styles from "./MaskCanvas.module.css";

/** The paint colour comes from the theme (`--mask-paint` on the frame), resolved once per stroke. */
function paintColour(frame: HTMLElement | null) {
  return (frame && getComputedStyle(frame).getPropertyValue("--mask-paint").trim()) || "#000";
}

/**
 * A picture with a paint layer for marking the region an edit may change: brush paints, eraser
 * removes, undo steps back. The mask keeps the picture's resolution; the frame fits its container.
 */
export function MaskCanvas({
  ref, src, alt, width, height, tool, brushSize, onChange, defaultStrokes, disabled = false, compareSrc, generating = false, resultSrc, onResultShown,
}: MaskCanvasProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const strokes = useRef<MaskStroke[]>([]);
  const active = useRef<{ pointer: number; stroke: MaskStroke; paint: string } | null>(null);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);

  const context = () => layerRef.current?.getContext("2d") ?? null;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const report = useCallback((empty: boolean) => onChangeRef.current?.({ strokes: strokes.current.length, empty }), []);
  const repaint = useCallback(() => {
    const layer = context();
    if (!layer) return;
    redraw(layer, strokes.current, paintColour(frameRef.current));
    report(strokes.current.length === 0 || isBlank(layer.canvas));
  }, [report]);

  useImperativeHandle(ref, () => ({
    undo() {
      strokes.current = strokes.current.slice(0, -1);
      repaint();
    },
    clear() {
      strokes.current = [];
      repaint();
    },
    toMask() {
      const layer = layerRef.current;
      if (!layer || strokes.current.length === 0 || isBlank(layer)) return Promise.resolve(null);
      return maskBlob(layer);
    },
  }), [repaint]);

  // A new picture starts with its default strokes (none unless a mask is kept).
  const initial = useRef(defaultStrokes);
  initial.current = defaultStrokes;
  useEffect(() => {
    strokes.current = [...(initial.current ?? [])];
    repaint();
  }, [src, width, height, repaint]);

  // The shimmer and the reveal are clipped to the painted region (CSS mask from the paint layer).
  useEffect(() => {
    if (!generating && !resultSrc) return;
    setMaskUrl(layerRef.current?.toDataURL("image/png") ?? null);
  }, [generating, resultSrc]);

  const toPicture = (event: PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [((event.clientX - rect.left) * width) / rect.width, ((event.clientY - rect.top) * height) / rect.height];
  };
  const moveCursor = (event: PointerEvent<HTMLCanvasElement>) => {
    const cursor = cursorRef.current;
    const frame = frameRef.current?.getBoundingClientRect();
    if (!cursor || !frame) return;
    cursor.style.transform = `translate(${event.clientX - frame.left}px, ${event.clientY - frame.top}px)`;
  };
  const painting = !disabled && !compareSrc && !generating;

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const layer = context();
    if (!painting || event.button !== 0 || !layer) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    const stroke: MaskStroke = { tool, size: (brushSize * width) / rect.width, points: [toPicture(event)] };
    active.current = { pointer: event.pointerId, stroke, paint: paintColour(frameRef.current) };
    drawSegment(layer, stroke, 0, active.current.paint);
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    moveCursor(event);
    const current = active.current;
    const layer = context();
    if (!current || current.pointer !== event.pointerId || !layer) return;
    current.stroke.points.push(toPicture(event));
    drawSegment(layer, current.stroke, current.stroke.points.length - 1, current.paint);
  };
  const onPointerEnd = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = active.current;
    if (!current || current.pointer !== event.pointerId) return;
    active.current = null;
    strokes.current = [...strokes.current, current.stroke];
    const layer = layerRef.current;
    report(current.stroke.tool === "eraser" && layer ? isBlank(layer) : false);
  };

  const frameStyle = {
    "--mask-ratio": `${width} / ${height}`,
    "--mask-brush": `${brushSize}px`,
    "--mask-url": maskUrl ? `url("${maskUrl}")` : undefined,
  } as CSSProperties;

  return (
    <div className={styles.root}>
      <div ref={frameRef} className={styles.frame} role="img" aria-label={alt} style={frameStyle}
        data-tool={tool} data-painting={painting ? "" : undefined} data-generating={generating ? "" : undefined}>
        <img className={styles.picture} src={compareSrc ?? src} alt="" draggable={false} />
        <canvas ref={layerRef} className={styles.layer} width={width} height={height} aria-hidden="true"
          data-hidden={compareSrc ? "" : undefined}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
          onPointerLeave={() => cursorRef.current?.removeAttribute("data-visible")}
          onPointerEnter={() => { if (painting) cursorRef.current?.setAttribute("data-visible", ""); }} />
        {generating && maskUrl ? <div className={styles.shimmer} aria-hidden="true" /> : null}
        {resultSrc && maskUrl ? (
          <img key={resultSrc} className={styles.result} src={resultSrc} alt="" draggable={false} onAnimationEnd={onResultShown} />
        ) : null}
        <div ref={cursorRef} className={styles.cursor} aria-hidden="true" />
      </div>
    </div>
  );
}
