import type { CSSProperties } from "react";
import { CopyButton } from "../../components/CopyButton";
import { Stack } from "../../components/Stack";
import { Tag } from "../../components/Tag";
import { Typo } from "../../components/Typo";
import { tokenCatalog } from "./catalog";
import { ThemePanes } from "./Chapter";
import { contrastGrade, contrastRatio, flatten, formatRatio, inkOn, parseColor } from "./contrast";
import { useComputed } from "./measure";
import { paletteFamilies } from "./paletteFamilies";
import type { TokenEntry } from "./tokenCatalog";
import f from "./Foundations.module.css";

const swatch = (name: string) => ({ "--swatch": `var(${name})` }) as CSSProperties;

function BandCell({ token }: { token: TokenEntry }) {
  const [ref, ink] = useComputed<HTMLDivElement, string>((_, style) => {
    const color = parseColor(style.backgroundColor);
    return color ? inkOn(color) : "dark";
  });
  return (
    <div className={f.bandCell} data-ink={ink ?? "dark"} ref={ref} style={swatch(token.name)} title={`${token.name} ${token.light}`}>
      <span className={f.bandStep}>{token.name.slice(-2)}</span>
      <span className={f.bandHex}>{token.light}</span>
    </div>
  );
}

export function PaletteBands() {
  const singles = tokenCatalog.filter((token) => token.group === "Palette" && !/^--[a-z]+-\d{2}$/u.test(token.name));
  return (
    <Stack gap="lg">
      {paletteFamilies(tokenCatalog).map(({ family, steps }) => (
        <div className={f.band} key={family} data-ds-palette={family}>
          <Stack align="row" cross="center" justify="between" gap="sm">
            <Typo.Label as="span">{family[0]!.toUpperCase() + family.slice(1)}</Typo.Label>
            <Typo.Caption tone="tertiary">{`--${family}-01…${steps.at(-1)!.name.slice(-2)}`}</Typo.Caption>
          </Stack>
          <div className={f.bandCells}>{steps.map((token) => <BandCell key={token.name} token={token} />)}</div>
        </div>
      ))}
      <div className={f.chips}>
        {singles.map((token) => (
          <div className={f.chip} key={token.name}>
            <span className={f.chipDot} style={swatch(token.name)} />
            <Stack gap="none" minWidth="0">
              <Typo.Code wrap="anywhere">{token.name}</Typo.Code>
              <Typo.Caption tone="tertiary">{token.light}</Typo.Caption>
            </Stack>
          </div>
        ))}
      </div>
    </Stack>
  );
}

/** Text roles and fills on the surfaces they are used on, graded live. */
const ROLE_PAIRS: Array<{ fg: string; bg: string; title: string; exempt?: boolean }> = [
  { fg: "--text-primary", bg: "--color-surface-base", title: "Primary text" },
  { fg: "--text-secondary", bg: "--color-surface-base", title: "Secondary text" },
  { fg: "--text-tertiary", bg: "--surface-raised", title: "Tertiary text on a card" },
  { fg: "--placeholder", bg: "--control-bg", title: "Placeholder in a field" },
  { fg: "--accent", bg: "--color-surface-base", title: "Accent text and links" },
  { fg: "--send-fg", bg: "--send-bg", title: "Primary action" },
  { fg: "--color-success-text", bg: "--color-success-bg", title: "Success" },
  { fg: "--color-warning-text", bg: "--color-warning-bg", title: "Warning" },
  { fg: "--color-danger-text", bg: "--color-danger-bg", title: "Danger" },
  { fg: "--color-info-text", bg: "--color-info-bg", title: "Info" },
  { fg: "--color-text-disabled", bg: "--color-surface-base", title: "Disabled (exempt)", exempt: true },
];

function RolePane({ fg, bg, exempt }: { fg: string; bg: string; exempt?: boolean }) {
  const [ref, ratio] = useComputed<HTMLDivElement, number | null>((element) => {
    const base = parseColor(getComputedStyle(element.parentElement!).backgroundColor);
    const surface = parseColor(getComputedStyle(element).backgroundColor);
    const ink = parseColor(getComputedStyle(element.firstElementChild!).color);
    if (!base || !surface || !ink) return null;
    return contrastRatio(ink, flatten(surface, flatten(base, { r: 255, g: 255, b: 255, a: 1 })));
  });
  const grade = ratio === null ? null : contrastGrade(ratio);
  const tone = exempt ? "neutral" : grade === "Fail" ? "danger" : grade === "AA large" ? "warning" : "success";
  return (
    <div className={f.rolePane} ref={ref} style={{ "--role-bg": `var(${bg})`, "--role-fg": `var(${fg})` } as CSSProperties}>
      <span className={f.roleInk}>Aa 가 버틀러</span>
      <Stack align="row" cross="center" gap="xs">
        <Typo.Caption numeric="tabular">{ratio === null ? "—" : formatRatio(ratio)}</Typo.Caption>
        {grade ? <Tag tone={tone}>{exempt ? "exempt" : grade}</Tag> : null}
      </Stack>
    </div>
  );
}

export function RolesOnSurfaces() {
  return (
    <div className={f.roleGrid}>
      {ROLE_PAIRS.map((pair) => (
        <div className={f.roleCard} key={`${pair.fg}-${pair.bg}`} data-ds-specimen={`role-${pair.fg}`}>
          <Stack gap="none" minWidth="0">
            <Typo.Label as="span">{pair.title}</Typo.Label>
            <Typo.Caption tone="secondary" wrap="anywhere">{`${pair.fg} on ${pair.bg}`}</Typo.Caption>
          </Stack>
          <ThemePanes label={pair.title}>{() => <RolePane bg={pair.bg} exempt={pair.exempt} fg={pair.fg} />}</ThemePanes>
        </div>
      ))}
    </div>
  );
}

/** Semantic and status tokens with the palette step each theme resolves to. */
export function SemanticMap() {
  const rows = tokenCatalog.filter((token) => (token.group === "Semantic" || token.group === "Status") && /^var\(--/u.test(token.light));
  const step = (value: string | null) => value?.replace(/^var\((--[\w-]+)\)$/u, "$1") ?? "same";
  return (
    <div className={f.semanticMap}>
      {rows.map((token) => (
        <div className={f.semanticRow} key={token.name}>
          <span className={f.pairDots} aria-hidden="true">
            <span className={`${f.chipDot} theme-light`} style={swatch(token.name)} />
            <span className={`${f.chipDot} theme-dark`} style={swatch(token.name)} />
          </span>
          <Stack gap="none" minWidth="0">
            <Typo.Code truncate>{token.name}</Typo.Code>
            <Typo.Caption tone="tertiary" truncate>{`${step(token.light)} · dark ${token.dark ? step(token.dark) : "same"}`}</Typo.Caption>
          </Stack>
          <CopyButton text={`var(${token.name})`} label={`Copy var(${token.name})`} copiedLabel="Copied" />
        </div>
      ))}
    </div>
  );
}
