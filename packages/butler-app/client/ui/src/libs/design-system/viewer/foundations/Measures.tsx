import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import type { TokenEntry } from "./tokenCatalog";
import f from "./Foundations.module.css";

/** Resolves length tokens to px by measuring hidden probes (clamp(), rem and var() included). */
export function useTokenPx(names: string[]): [Record<string, number>, ReactNode] {
  const ref = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<Record<string, number>>({});
  const key = names.join(",");
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const read = () => {
      const next: Record<string, number> = {};
      for (const probe of root.querySelectorAll<HTMLElement>("[data-probe]")) next[probe.dataset.probe!] = probe.getBoundingClientRect().width;
      setValues((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, [key]);
  const probes = (
    <div aria-hidden="true" className={f.probes} ref={ref}>
      {names.map((name) => <span data-probe={name} key={name} style={{ "--probe": `var(${name})` } as CSSProperties} />)}
    </div>
  );
  return [values, probes];
}

const round = (value: number | undefined) => (value === undefined ? "" : `${Math.round(value * 10) / 10}px`);

/** Horizontal bars scaled to the widest token, so relative widths read at a glance. */
export function WidthBars({ tokens }: { tokens: TokenEntry[] }) {
  const [values, probes] = useTokenPx(tokens.map((token) => token.name));
  const max = Math.max(1, ...Object.values(values));
  return (
    <Stack gap="sm">
      {probes}
      {tokens.map((token) => (
        <div className={f.widthRow} key={token.name}>
          <div className={f.widthTrack}><span className={f.widthBar} style={{ "--fraction": `${((values[token.name] ?? 0) / max) * 100}%` } as CSSProperties} /></div>
          <Stack align="row" cross="baseline" justify="between" gap="sm" wrap>
            <Typo.Code>{token.name}</Typo.Code>
            <Typo.Caption tone="tertiary" numeric="tabular">{round(values[token.name]) === token.light ? token.light : `${round(values[token.name])} · ${token.light}`}</Typo.Caption>
          </Stack>
        </div>
      ))}
    </Stack>
  );
}

/** Squares at each step: the ramp as a staircase. */
export function Staircase({ tokens }: { tokens: TokenEntry[] }) {
  const [values, probes] = useTokenPx(tokens.map((token) => token.name));
  return (
    <div className={f.stair} data-ds-specimen="staircase">
      {probes}
      {tokens.map((token) => (
        <div className={f.stairStep} key={token.name}>
          <span className={f.stairBlock} style={{ "--step": `var(${token.name})` } as CSSProperties} />
          <Typo.Label as="span" numeric="tabular">{round(values[token.name])}</Typo.Label>
          <Typo.Caption tone="tertiary">{token.name.replace(/^--[a-z]+-/u, "")}</Typo.Caption>
        </div>
      ))}
    </div>
  );
}
