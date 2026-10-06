import { renderWallpaperStill } from "@/butler-ds";
import { SHORELINE_REGISTRY, SHORELINE_SOURCE } from "./decorationScenes";
import type { ContrastRow } from "./measuredContrast";
import type { ShoreParams } from "./shoreTuning";

type Role = keyof ContrastRow;

function channel(value: number) {
  const x = value / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}
function luminance(r: number, g: number, b: number) { return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); }
function ratio(a: number, b: number) { return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }
function rgb(color: string): number[] { return (color.match(/[\d.]+/gu) ?? ["0", "0", "0"]).slice(0, 3).map(Number); }

/** Every glyph and icon box in the composer card, card-relative, with its role and colour. */
function targets(card: HTMLElement): Array<{ role: Role; color: number[]; rect: number[] }> {
  const origin = card.getBoundingClientRect();
  const out: Array<{ role: Role; color: number[]; rect: number[] }> = [];
  const rel = (r: DOMRect) => [r.left - origin.left, r.top - origin.top, r.width, r.height];
  const lines = (el: Element) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return [...range.getClientRects()].filter((r) => r.width > 1);
  };
  const color = (el: Element) => rgb(getComputedStyle(el).color);
  const expanded = card.getAttribute("data-expanded") !== "false";
  const editable = card.querySelector('[role="textbox"]');
  const placeholder = card.querySelector('[data-slot="composer-expanded-body"] [aria-hidden="true"]');
  if (expanded && editable?.textContent) for (const r of lines(editable)) out.push({ role: "primary", color: color(editable), rect: rel(r) });
  if (expanded && !editable?.textContent && placeholder) for (const r of lines(placeholder)) out.push({ role: "placeholder", color: color(placeholder), rect: rel(r) });
  const preview = card.querySelector('[data-slot="composer-compact-preview"]');
  if (!expanded && preview) {
    const role: Role = preview.getAttribute("data-empty") === "true" ? "placeholder" : "primary";
    for (const r of lines(preview)) out.push({ role, color: color(preview), rect: rel(r) });
  }
  for (const button of card.querySelectorAll('[data-test-class="composer-toolbar"] button:not([data-slot="composer-compact-preview"]):not([data-test-class="composer-send-button"])')) {
    if (button.getBoundingClientRect().width < 1) continue;
    for (const span of button.querySelectorAll("span")) {
      if (span.children.length || !span.textContent?.trim()) continue;
      const hidden = (el: Element | null) => Boolean(el) && (getComputedStyle(el!).clipPath !== "none" || el!.getBoundingClientRect().width <= 1);
      if (hidden(span.closest('[data-slot="button-text"]')) || hidden(span.closest('[class*="detail"]'))) continue;
      const role: Role = span.closest('[class*="detail"]') ? "secondary" : "primary";
      for (const r of lines(span)) out.push({ role, color: color(span), rect: rel(r) });
    }
    const svg = button.querySelector("svg");
    if (svg) out.push({ role: "icons", color: color(svg), rect: rel(svg.getBoundingClientRect()) });
  }
  return out;
}

/**
 * Live contrast for the shoreline under `params`: the scene's still frame (the DS still
 * renderer, same module and tone), composed exactly like the CSS (waterline position, exposure,
 * sand highlight multiply, tone gradient), sampled behind every glyph and icon of `card`.
 * One frame (stillTime), so it can read a little better or worse than the moving scene.
 */
export async function measureShoreline(card: HTMLElement, tone: "light" | "dark", params: ShoreParams): Promise<ContrastRow> {
  const box = card.getBoundingClientRect();
  const width = Math.max(1, Math.round(box.width));
  const height = Math.max(1, Math.round(box.height));
  const artHeight = Math.max(height, 360);
  const blob = await renderWallpaperStill(SHORELINE_SOURCE as Parameters<typeof renderWallpaperStill>[0], { width, height: artHeight }, tone, SHORELINE_REGISTRY);
  const still = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const top = params.wl === null ? height / 2 : height - params.wl;
  if (tone === "light") ctx.filter = `brightness(${params.exp})`;
  ctx.drawImage(still, 0, top - artHeight / 2, width, artHeight);
  ctx.filter = "none";
  if (tone === "light" && params.hl > 0) {
    const grey = Math.round(255 * (1 - params.hl));
    const ramp = ctx.createLinearGradient(0, 0, 0, height);
    ramp.addColorStop(0, `rgb(${grey},${grey},${grey})`);
    ramp.addColorStop(Math.max(0, Math.min(1, (top - 16) / height)), `rgb(${grey},${grey},${grey})`);
    ramp.addColorStop(Math.max(0, Math.min(1, top / height)), "rgb(255,255,255)");
    ramp.addColorStop(1, "rgb(255,255,255)");
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = ramp;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "source-over";
  }
  if (params.gs > 0) {
    const [r, g, b] = rgb(getComputedStyle(card).getPropertyValue("--tinted-glass-tint") || (tone === "light" ? "rgb(255,255,255)" : "rgb(23,24,26)"));
    const ramp = ctx.createLinearGradient(0, 0, 0, height);
    const g0 = Math.max(0, Math.min(1, params.g0 / 100));
    const g1 = Math.max(g0, Math.min(1, params.g1 / 100));
    ramp.addColorStop(0, `rgba(${r},${g},${b},0)`);
    ramp.addColorStop(g0, `rgba(${r},${g},${b},0)`);
    ramp.addColorStop(g1, `rgba(${r},${g},${b},${params.gs})`);
    ramp.addColorStop(1, `rgba(${r},${g},${b},${g1 < 1 ? params.gs : params.gs})`);
    ctx.fillStyle = ramp;
    ctx.fillRect(0, 0, width, height);
  }
  const worst: ContrastRow = { primary: 99, placeholder: 99, secondary: 99, icons: 99 };
  for (const target of targets(card)) {
    const [x, y, w, h] = target.rect.map((value) => Math.round(value));
    if (w < 1 || h < 1) continue;
    const data = ctx.getImageData(Math.max(0, x), Math.max(0, y), Math.min(w, width), Math.min(h, height)).data;
    const values: number[] = [];
    for (let i = 0; i < data.length; i += 4) values.push(luminance(data[i]!, data[i + 1]!, data[i + 2]!));
    values.sort((a, b) => a - b);
    const lo = values[Math.floor(values.length * 0.02)] ?? 0;
    const hi = values[Math.floor(values.length * 0.98)] ?? 1;
    const text = luminance(target.color[0]!, target.color[1]!, target.color[2]!);
    worst[target.role] = Math.min(worst[target.role], ratio(text, lo), ratio(text, hi));
  }
  return worst;
}
