import { motionEasing, type MotionEasingName } from "../../lib/motion";

/**
 * A small declarative timeline for long hero sequences: tracks of poses at
 * beat marks, compiled into one CSS @keyframes rule per track on a shared
 * cycle. The result is plain CSS animation (compositor transform and opacity,
 * plus two paint-only fields for type specimens: an outline's dash offset and
 * a variable font's weight), so pausing, reduced motion and the motion trace
 * treat it like any other hero. Easing is per segment and read from the --motion-ease-* tokens, which
 * CSS cannot do itself (var() is not honored inside @keyframes).
 */

/** A pose in canvas px and degrees; unset fields carry over from the previous key. */
export interface Pose {
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  s?: number;
  /** Extra scale along x and y (times s), for sweeps such as a line box drawing in. */
  sx?: number;
  sy?: number;
  o?: number;
  /** stroke-dashoffset in px: an outline drawing along its contour (paint only). */
  dash?: number;
  /** font-weight on a variable font, interpolated along its axis (text layout of that element). */
  wght?: number;
  /** Translate along x in % of the element's own width (a reveal window needs no measuring). */
  xp?: number;
}

export interface Key extends Pose {
  /** Beat mark of the key (0 … the cycle's beats). */
  at: number;
  /** The curve that arrives at this key; default "standard". */
  ease?: MotionEasingName;
}

export interface Track {
  /** CSS selector inside the hero's scope. */
  select: string;
  keys: Key[];
}

const TRANSFORM_FIELDS = ["x", "y", "z", "rx", "ry", "rz", "s", "sx", "sy"] as const;
const REST: Required<Pose> = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1, sx: 1, sy: 1, o: 1, dash: 0, wght: 400, xp: 0 };

function num(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function transform(p: Required<Pose>, percent: boolean): string {
  return `${percent ? `translateX(${num(p.xp)}%) ` : ""}translate3d(${num(p.x)}px, ${num(p.y)}px, ${num(p.z)}px) rotateX(${num(p.rx)}deg) rotateY(${num(p.ry)}deg) rotateZ(${num(p.rz)}deg) scale3d(${num(p.s * p.sx)}, ${num(p.s * p.sy)}, 1)`;
}

/** Keys resolved to full poses, with holds added at 0 and at the end of the cycle. */
function resolve(keys: Key[], beats: number): Array<Required<Pose> & { at: number; ease: MotionEasingName }> {
  const sorted = [...keys].sort((a, b) => a.at - b.at);
  let pose: Required<Pose> = { ...REST, ...sorted[0] };
  const out = sorted.map((key) => {
    pose = { ...pose, ...Object.fromEntries(Object.entries(key).filter(([, v]) => v !== undefined)) } as Required<Pose>;
    return { ...pose, at: Math.min(beats, Math.max(0, key.at)), ease: key.ease ?? "standard" };
  });
  if (out[0]!.at > 0) out.unshift({ ...out[0]!, at: 0 });
  if (out[out.length - 1]!.at < beats) out.push({ ...out[out.length - 1]!, at: beats });
  return out;
}

/**
 * CSS for every track: one @keyframes each and a rule that runs it on the
 * cycle (`calc(var(--hero-beat) * beats)`). Rules only apply while the hero
 * plays or holds (never in the still poster), and set longhands so the
 * stage's pause rule still wins.
 */
export function compileTimeline(scope: string, beats: number, tracks: Track[]): string {
  const easings = new Map<MotionEasingName, string>();
  const ease = (name: MotionEasingName) => easings.get(name) ?? easings.set(name, motionEasing(name)).get(name)!;
  return tracks.map((track, index) => {
    const name = `${scope}-${index}`;
    const keys = resolve(track.keys, beats);
    const percent = track.keys.some((key) => key.xp !== undefined);
    const moves = percent || track.keys.some((key) => TRANSFORM_FIELDS.some((field) => key[field] !== undefined));
    const fades = track.keys.some((key) => key.o !== undefined);
    const draws = track.keys.some((key) => key.dash !== undefined);
    const weighs = track.keys.some((key) => key.wght !== undefined);
    const frames = keys.map((key, k) => {
      const next = keys[k + 1];
      const body = [
        moves ? `transform:${transform(key, percent)}` : "",
        fades ? `opacity:${num(key.o)}` : "",
        draws ? `stroke-dashoffset:${num(key.dash)}px` : "",
        weighs ? `font-weight:${num(key.wght)}` : "",
        next ? `animation-timing-function:${ease(next.ease)}` : "",
      ].filter(Boolean).join(";");
      return `${num((key.at / beats) * 100)}%{${body}}`;
    }).join("");
    const rule = `[data-hero-state]:not([data-hero-state="still"]) [data-hero-scope="${scope}"] ${track.select}`;
    return `@keyframes ${name}{${frames}}${rule}{animation-name:${name};animation-duration:calc(var(--hero-beat) * ${beats});`
      + "animation-iteration-count:infinite;animation-fill-mode:both}";
  }).join("\n");
}

/**
 * Stepped keys: an element shown only in [from, to) (cuts, no cross-fade),
 * as used for weight stops and readouts that change in place.
 */
export function cut(from: number, to: number, beats: number): Key[] {
  const edge = 0.01;
  const keys: Key[] = [];
  if (from > 0) keys.push({ at: 0, o: 0 }, { at: from - edge, o: 0 });
  keys.push({ at: from, o: 1 }, { at: to - edge, o: 1 });
  if (to < beats) keys.push({ at: to, o: 0 });
  return keys;
}

/** Scene geometry a choreography is authored against: canvas size and element boxes in canvas px. */
export interface Box { x: number; y: number; w: number; h: number }

/**
 * Camera pose that centres `box` on the canvas at `zoom` with the given
 * rotations (applied as rotateX, rotateY, rotateZ, then scale, about the
 * canvas centre), so a tilted camera still lands its subject in the middle.
 */
export function focus(canvas: { w: number; h: number }, box: Box, zoom: number, turn: Pick<Pose, "rx" | "ry" | "rz"> = {}): Pose {
  const rad = (deg = 0) => (deg * Math.PI) / 180;
  let v = [zoom * (box.x + box.w / 2 - canvas.w / 2), zoom * (box.y + box.h / 2 - canvas.h / 2), 0] as [number, number, number];
  const [cz, sz] = [Math.cos(rad(turn.rz)), Math.sin(rad(turn.rz))];
  v = [v[0] * cz - v[1] * sz, v[0] * sz + v[1] * cz, v[2]];
  const [cy, sy] = [Math.cos(rad(turn.ry)), Math.sin(rad(turn.ry))];
  v = [v[0] * cy + v[2] * sy, v[1], -v[0] * sy + v[2] * cy];
  const [cx, sx] = [Math.cos(rad(turn.rx)), Math.sin(rad(turn.rx))];
  v = [v[0], v[1] * cx - v[2] * sx, v[1] * sx + v[2] * cx];
  return { x: -v[0], y: -v[1], z: -v[2], s: zoom, rx: turn.rx ?? 0, ry: turn.ry ?? 0, rz: turn.rz ?? 0 };
}

/** Zoom that fits `box` into the canvas with a margin, capped. */
export function fit(canvas: { w: number; h: number }, box: Box, fill = 0.82, cap = 2): number {
  return Math.min(cap, (canvas.w * fill) / box.w, (canvas.h * fill) / box.h);
}
