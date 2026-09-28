/**
 * SVG path of a CSS easing value in a 100x100 box (time right, progress up,
 * y = 100 - progress * 100). The Motion hero draws each --motion-ease-* token
 * from its live value, so the plotted curve is the curve the dot runs on.
 */
export function easingPath(value: string): string | null {
  const easing = value.trim().replace(/\s+/gu, " ");
  if (easing === "linear") return "M0 100 L100 0";
  const bezier = /^cubic-bezier\(([^)]*)\)$/u.exec(easing);
  if (bezier) {
    const numbers = bezier[1]!.split(",").map((part) => Number(part.trim()));
    if (numbers.length !== 4 || numbers.some((number) => !Number.isFinite(number))) return null;
    const [x1, y1, x2, y2] = numbers as [number, number, number, number];
    return `M0 100 C${fmt(x1 * 100)} ${fmt(100 - y1 * 100)} ${fmt(x2 * 100)} ${fmt(100 - y2 * 100)} 100 0`;
  }
  const linear = /^linear\((.*)\)$/u.exec(easing);
  if (!linear) return null;
  const points = linearStops(linear[1]!);
  if (!points) return null;
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${fmt(x * 100)} ${fmt(100 - y * 100)}`).join(" ");
}

/**
 * linear() stops as [input, output] pairs, following the CSS rules: a stop may
 * carry zero, one or two input percentages; missing inputs are spread evenly
 * between their neighbours, and inputs never decrease.
 */
export function linearStops(body: string): Array<[number, number]> | null {
  const stops: Array<{ output: number; input: number | null }> = [];
  for (const part of body.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [output, ...inputs] = part.split(" ");
    const value = Number(output);
    if (!Number.isFinite(value) || inputs.length > 2) return null;
    const percents = inputs.map((input) => (input.endsWith("%") ? Number(input.slice(0, -1)) / 100 : Number.NaN));
    if (percents.some((percent) => !Number.isFinite(percent))) return null;
    if (percents.length === 0) stops.push({ output: value, input: null });
    for (const percent of percents) stops.push({ output: value, input: percent });
  }
  if (stops.length < 2) return null;
  stops[0]!.input ??= 0;
  stops.at(-1)!.input ??= 1;
  let floor = 0;
  for (const stop of stops) {
    if (stop.input === null) continue;
    stop.input = Math.max(stop.input, floor);
    floor = stop.input;
  }
  for (let index = 0; index < stops.length; index += 1) {
    if (stops[index]!.input !== null) continue;
    const from = index - 1;
    let to = index;
    while (stops[to]!.input === null) to += 1;
    const start = stops[from]!.input!;
    const end = stops[to]!.input!;
    for (let fill = index; fill < to; fill += 1) stops[fill]!.input = start + ((end - start) * (fill - from)) / (to - from);
    index = to;
  }
  return stops.map((stop) => [stop.input!, stop.output]);
}

function fmt(value: number): string {
  return String(Math.round(value * 100) / 100);
}
