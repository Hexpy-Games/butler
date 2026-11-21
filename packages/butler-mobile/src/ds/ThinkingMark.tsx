import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Animated } from "react-native";
import Svg, { Circle, ClipPath, Defs, G, Path, Polygon } from "react-native-svg";
import { CENTER, DESIGN_SIZE, FRAME_INTERVAL_MS, HALFTONE_PRESETS, MAX_STEP_S, RHO, RING_R, RING_W, TAU, type SizeClass } from "../../../butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/constants";
import { MorphSim, progressOf } from "../../../butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/motion";
import { createFrameParams, dotRadius, latticeFor, setFrameParams, type FrameParams } from "../../../butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/halftone-model";
import { clipMargin, OUTLINE_RAYS, traceOutline } from "../../../butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/morph-outline";
import { sizeClass, traceRibbon, type PathSink } from "../../../butler-app/client/ui/src/libs/design-system/components/ButlerThinkingMark/thinking-mark/ribbon-geometry";
import { useTokens } from "../design/useTokens";
import { run, toEasing, useReducedMotion } from "./internal/motion";

function ribbonPath(): string {
  let d = "";
  const sink: PathSink = {
    beginPath: () => { d = ""; },
    moveTo: (x, y) => { d += `M ${x} ${y} `; },
    lineTo: (x, y) => { d += `L ${x} ${y} `; },
    closePath: () => { d += "Z "; },
    arc: (cx, cy, r, a0, a1, ccw) => {
      const angle = ((ccw ? a0 - a1 : a1 - a0) % TAU + TAU) % TAU;
      d += `L ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} `;
      d += `A ${r} ${r} 0 ${angle > Math.PI ? 1 : 0} ${ccw ? 0 : 1} ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)} `;
    },
  };
  traceRibbon(sink);
  return d;
}

type Frame = { M: number; paths: string[]; outline: string | undefined };

function renderHalftone(M: number, T: number, cls: SizeClass, params: FrameParams, outline: Float32Array): Frame {
  const layers = latticeFor(cls);
  const preset = HALFTONE_PRESETS[cls];
  setFrameParams(params, M, T, cls);
  const mis = (7 + 4 * Math.sin(1.2 * T)) * preset.mis * M;
  const mis2 = (-5 + 3 * Math.cos(0.95 * T)) * preset.mis * M;
  const offsets = [[0, 0], [mis, mis2], [-mis2, 0.6 * mis]];
  const paths = layers.map((L, ink) => {
    let d = "";
    const [offx, offy] = offsets[ink];
    for (let i = 0; i < L.N; i += 1) {
      const r = dotRadius(L, i, ink, params);
      if (r > 0) {
        const x = L.X[i] + offx;
        const y = L.Y[i] + offy;
        d += `M ${x - r} ${y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 `;
      }
    }
    return d;
  });
  const margin = clipMargin(M, preset.pitch);
  let points: string | undefined;
  if (Number.isFinite(margin)) {
    traceOutline(M, params.br, outline);
    points = Array.from(outline, (r, a) => {
      const angle = a / OUTLINE_RAYS * TAU;
      return `${CENTER + Math.cos(angle) * (r + margin)},${CENTER + Math.sin(angle) * (r + margin)}`;
    }).join(" ");
  }
  return { M, paths, outline: points };
}

export function ThinkingMark({ working, size }: { working: boolean; size: number }) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const clipId = useId();
  const sim = useRef(new MorphSim());
  const params = useRef(createFrameParams());
  const outline = useRef(new Float32Array(OUTLINE_RAYS));
  const workingRef = useRef(working);
  workingRef.current = working;
  const raf = useRef<number | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const opacity = useRef(new Animated.Value(1)).current;
  const ribbonD = useMemo(ribbonPath, []);
  const cls = useRef(sizeClass(size));
  cls.current = sizeClass(size);
  useEffect(() => {
    if (reduced) {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
      sim.current.park(); setFrame(null); return;
    }
    if (raf.current !== null || (!workingRef.current && sim.current.idle)) return;
    let last = 0;
    const tick = (now: number) => {
      if (now - last < FRAME_INTERVAL_MS) { raf.current = requestAnimationFrame(tick); return; }
      const dt = last ? Math.min((now - last) / 1000, MAX_STEP_S) : 1 / 60;
      last = now;
      sim.current.update(dt, workingRef.current);
      if (sim.current.idle && !workingRef.current) { setFrame(null); raf.current = null; return; }
      setFrame(renderHalftone(progressOf(sim.current.M.x), sim.current.T, cls.current, params.current, outline.current));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [working, reduced]);
  useEffect(() => () => { if (raf.current !== null) cancelAnimationFrame(raf.current); raf.current = null; }, []);
  useEffect(() => {
    if (!reduced) { opacity.setValue(1); return; }
    const leg = (toValue: number) => Animated.timing(opacity, { toValue, duration: t.duration("--pulse-duration") * 2,
      easing: toEasing(t.easing("--spinner-easing")), useNativeDriver: true });
    const animation = working ? Animated.loop(Animated.sequence([leg(0.45), leg(1)]))
      : run(t, opacity, 1, "--motion-slow", "--motion-ease-standard");
    animation.start();
    return () => animation.stop();
  }, [working, reduced, opacity, t]);
  const ink = t.color("--butler-mark-ink");
  const blend = frame ? Math.min(1, frame.M / 0.05) : 0;
  // Desktop butlerMarkTheme.ts RISO_INKS alphas, by scheme.
  const [blueAlpha, pinkAlpha] = t.scheme === "dark" ? [0.85, 0.8] : [0.8, 0.75];
  return <Animated.View accessibilityElementsHidden importantForAccessibility="no" style={{ opacity }}>
    <Svg width={size} height={size} viewBox={`0 0 ${DESIGN_SIZE} ${DESIGN_SIZE}`}>
      <G opacity={1 - blend}><Path d={ribbonD} fill={ink} stroke={ink} strokeWidth={2 * RHO} strokeLinejoin="round" /></G>
      {frame ? <>
        {frame.outline ? <Defs><ClipPath id={clipId}><Polygon points={frame.outline} /></ClipPath></Defs> : null}
        <G opacity={blend} clipPath={frame.outline ? `url(#${clipId})` : undefined}>
          {frame.M > 0.001 ? <>
            <Path d={frame.paths[1]} fill={t.color("--butler-ink-blue")} fillOpacity={blueAlpha} />
            <Path d={frame.paths[2]} fill={t.color("--butler-ink-pink")} fillOpacity={pinkAlpha} />
          </> : null}
          <Path d={frame.paths[0]} fill={ink} />
        </G>
      </> : null}
      <Circle cx={CENTER} cy={CENTER} r={RING_R} stroke={ink} strokeWidth={RING_W} fill="none" />
    </Svg>
  </Animated.View>;
}
