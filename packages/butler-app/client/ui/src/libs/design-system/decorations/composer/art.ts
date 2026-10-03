import type { DecorationOptions } from "./types";

type Context = CanvasRenderingContext2D;
export interface ArtPalette {
  petal: string;
  blush: string;
  leaf: string;
  stem: string;
  pollen: string;
  paper: string;
  ink: string;
  blue: string;
}

/** Resolve DS colors only when the decoration mounts or its theme changes. */
export function readArtPalette(canvas: HTMLCanvasElement): ArtPalette {
  const style = getComputedStyle(canvas);
  const read = (token: string) => style.getPropertyValue(token).trim();
  return {
    petal: read("--red-04"), blush: read("--red-02"), leaf: read("--green-04"),
    stem: read("--green-07"), pollen: read("--amber-04"), paper: read("--tinted-glass-tint"),
    ink: read("--text-secondary"), blue: read("--blue-02"),
  };
}

function ellipse(ctx: Context, x: number, y: number, rx: number, ry: number, color: string, rotation = 0) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
  ctx.fill();
}

function petals(ctx: Context, width: number, height: number, time: number, pulse: number, palette: ArtPalette) {
  // Fixed pool: typing reveals eight extra petals; no per-input allocation or accumulation.
  for (let i = 0; i < 24; i += 1) {
    ctx.globalAlpha = i < 16 ? 0.8 : pulse;
    if (!ctx.globalAlpha) continue;
    const phase = i * 2.399;
    const x = ((i * 0.618 % 1) * width + Math.sin(time * 0.35 + phase) * 14 + width) % width;
    const y = ((i * 0.381 % 1) * height + time * (5 + i % 4)) % (height + 16) - 8;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(phase + time * 0.2);
    ctx.fillStyle = i % 3 ? palette.petal : palette.blush;
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.bezierCurveTo(9, -3, 5, 6, 0, 7);
    ctx.bezierCurveTo(-6, 3, -5, -5, 0, -6);
    ctx.fill();
    ctx.restore();
  }
}

function flowers(ctx: Context, width: number, height: number, pulse: number, phase: number, palette: ArtPalette) {
  for (let i = 0; i < 20; i += 1) {
    const x = (i + 0.5) * width / 20;
    const tall = 16 + (i * 7 % 25);
    const sway = Math.sin(phase * 12 + i * 0.7) * pulse * 5;
    const y = height - tall;
    ctx.strokeStyle = palette.stem;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, height);
    ctx.quadraticCurveTo(x + sway, y + tall * 0.5, x + sway, y);
    ctx.stroke();
    ellipse(ctx, x + 3, y + tall * 0.6, 5, 2, palette.leaf, -0.5);
    for (let p = 0; p < 6; p += 1) {
      const a = p * Math.PI / 3;
      ellipse(ctx, x + sway + Math.cos(a) * 4, y + Math.sin(a) * 4, 4, 2, i % 3 ? palette.blush : palette.blue, a);
    }
    ellipse(ctx, x + sway, y, 2, 2, palette.pollen);
  }
}

function cat(ctx: Context, x: number, seat: number, color: string, pulse: number, phase: number, palette: ArtPalette) {
  ctx.save();
  ctx.translate(x, seat);
  ctx.rotate(Math.sin(phase * 10) * pulse * 0.04);
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(8, -3);
  ctx.bezierCurveTo(24, 0, 23, -13 + pulse * 3, 18, -11);
  ctx.stroke();
  ellipse(ctx, 0, -8, 10, 12, color);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-10, -17);
  ctx.lineTo(-9, -30);
  ctx.lineTo(-2, -25);
  ctx.lineTo(4, -25);
  ctx.lineTo(10, -30);
  ctx.lineTo(11, -17);
  ctx.fill();
  ellipse(ctx, 0, -20, 11, 8, color);
  ellipse(ctx, -4, 3, 3, 6, color);
  ellipse(ctx, 5, 3, 3, 6, color);
  ellipse(ctx, -4, -21, 1, 1.2, palette.ink);
  ellipse(ctx, 4, -21, 1, 1.2, palette.ink);
  ellipse(ctx, 0, -17, 1.4, 1, palette.petal);
  ctx.restore();
}

export function drawArt(ctx: Context, options: DecorationOptions, palette: ArtPalette,
  width: number, height: number, time: number, pulse: number, phase: number) {
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  if (options.theme === "cherry-blossom") petals(ctx, width, height, time, pulse, palette);
  if (options.theme === "flower-field") flowers(ctx, width, height, pulse, phase, palette);
  if (options.theme === "characters") {
    const seat = options.inside ? 29 : height - 10;
    [palette.blue, palette.blush, palette.pollen].forEach((color, i) => {
      cat(ctx, width * (0.28 + i * 0.22), seat, color, pulse, phase + i * 0.1, palette);
    });
  }
  ctx.restore();
}
