import { CONFIG, CENTER, DESIGN_SIZE, WAVE_LAYERS, type Point, type Side, type WaveLayer } from "./constants";
import { collectPoints, graphPoint, transitionParts } from "./wave-animation";

export function traceSmoothEdge(ctx: CanvasRenderingContext2D, points: Point[]) {
  const first = points[0];
  if (!first) return;
  ctx.lineTo(first[0], first[1]);

  for (let i = 1; i < points.length - 1; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    if (!current || !next) continue;
    const midX = (current[0] + next[0]) * 0.5;
    const midY = (current[1] + next[1]) * 0.5;
    ctx.quadraticCurveTo(current[0], current[1], midX, midY);
  }

  const last = points[points.length - 1];
  if (last) ctx.lineTo(last[0], last[1]);
}

export function drawGraph(ctx: CanvasRenderingContext2D, side: Side, t: number, morph: number) {
  const points = collectPoints(side, t, morph);
  const first = points[0];
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    if (point) ctx.lineTo(point[0], point[1]);
  }
  ctx.stroke();
}

export function drawFilledWaveLayer(ctx: CanvasRenderingContext2D, t: number, morph: number, layer: WaveLayer) {
  const top = collectPoints("top", t, morph, layer);
  const bottom = collectPoints("bottom", t, morph, layer).reverse();
  const first = top[0];
  if (!first) return;

  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  traceSmoothEdge(ctx, top.slice(1));
  traceSmoothEdge(ctx, bottom);
  ctx.closePath();
  ctx.fill();
}

function drawCircleCap(ctx: CanvasRenderingContext2D, top: Point, bottom: Point, direction: -1 | 1) {
  const radius = Math.hypot(top[0] - CENTER, top[1] - CENTER);
  if (radius < 1) return;
  const topAngle = Math.atan2(top[1] - CENTER, top[0] - CENTER);
  const bottomAngle = Math.atan2(bottom[1] - CENTER, bottom[0] - CENTER);

  if (direction < 0) ctx.arc(CENTER, CENTER, radius, topAngle, bottomAngle, true);
  else ctx.arc(CENTER, CENTER, radius, topAngle, bottomAngle, false);
}

export function drawCaps(ctx: CanvasRenderingContext2D, t: number, morph: number, ink: string) {
  const parts = transitionParts(morph);
  if (1 - parts.toWave <= 0.001 || morph >= 0.47) return;

  ctx.save();
  ctx.lineWidth = CONFIG.ribbonWidth;
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  drawCircleCap(ctx, graphPoint(0, "top", t, morph), graphPoint(0, "bottom", t, morph), -1);
  drawCircleCap(ctx, graphPoint(1, "top", t, morph), graphPoint(1, "bottom", t, morph), 1);
  ctx.stroke();
  ctx.restore();
}

export function drawRibbon(ctx: CanvasRenderingContext2D, t: number, morph: number, ink: string) {
  const parts = transitionParts(morph);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = ink;

  if (parts.toWave < 0.04) {
    ctx.lineWidth = CONFIG.ribbonWidth;
    drawGraph(ctx, "top", t, morph);
    drawGraph(ctx, "bottom", t, morph);
  } else {
    ctx.fillStyle = ink;
    for (const layer of WAVE_LAYERS) {
      ctx.globalAlpha = layer.alpha;
      drawFilledWaveLayer(ctx, t, morph, layer);
    }
  }

  ctx.restore();
  drawCaps(ctx, t, morph, ink);
}

export function drawMark(ctx: CanvasRenderingContext2D, t: number, morph: number, ink: string) {
  ctx.clearRect(0, 0, DESIGN_SIZE, DESIGN_SIZE);

  ctx.save();
  ctx.beginPath();
  ctx.arc(CENTER, CENTER, CONFIG.radius - CONFIG.circleWidth * 0.5 + 8, 0, Math.PI * 2);
  ctx.clip();
  drawRibbon(ctx, t, morph, ink);
  ctx.restore();

  ctx.save();
  ctx.translate(CENTER, CENTER);
  ctx.lineWidth = CONFIG.circleWidth;
  ctx.strokeStyle = ink;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.arc(0, 0, CONFIG.radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}