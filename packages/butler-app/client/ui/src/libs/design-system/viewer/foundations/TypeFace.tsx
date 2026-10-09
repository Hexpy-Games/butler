import type { CSSProperties } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { tokenCatalog } from "./catalog";
import { BUNDLED_FACES, fontFamilies, fontWeights, typefaceTitle, WEIGHT_AXIS } from "./typeScale";
import type { SampleLocale } from "./typeRoles";
import f from "./Foundations.module.css";

const byName = new Map(tokenCatalog.map((token) => [token.name, token]));

const DISPLAY_LINES: Record<SampleLocale, string> = {
  en: "Ask Butler anything. It plans, asks, then acts.",
  ko: "무엇이든 버틀러에게. 계획하고, 묻고, 실행합니다.",
};

const GLYPHS: Array<[string, string, string?]> = [
  ["Latin", "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz"],
  ["Hangul", "가나다라마바사아자차카타파하 갉괜뷁쀍흙읊됐읽앉", "ko"],
  ["Punctuation", ". , : ; ! ? … · — – - ' \" ‘ ’ “ ” ( ) [ ] { } / \\ @ # % & * + = < > ~ _ |"],
  ["Symbols", "₩ $ € £ ¥ © ° ± × ÷ → ← ↑ ↓ ⌘ ⌥ ⇧ ⌃ ↵ ⎋"],
];

function weightName(token: string): string {
  const name = token.replace("--font-weight-", "");
  return name[0]!.toUpperCase() + name.slice(1);
}

/** The Butler typeface at display size: families, weights and the character set. */
export function TypeFace({ locale }: { locale: SampleLocale }) {
  const body = byName.get("--font-body")?.light ?? "";
  const code = byName.get("--font-family-code")?.light ?? "";
  const families = fontFamilies(body);
  const other: SampleLocale = locale === "en" ? "ko" : "en";
  return (
    <Stack gap="2xl">
      <div className={f.voice} data-ds-specimen="typeface">
        <div className={f.voiceGlyph} aria-hidden="true">Aa<span lang="ko">가</span></div>
        <Stack gap="lg" minWidth="0">
          <Stack gap="xs">
            <Typo.SectionTitle tone="tertiary">Typeface · --font-body</Typo.SectionTitle>
            <Typo.H2>{typefaceTitle(families)}</Typo.H2>
            {BUNDLED_FACES[families[0] ?? ""] ? <Typo.Caption tone="secondary">{BUNDLED_FACES[families[0]!]}</Typo.Caption> : null}
            <Typo.Caption tone="tertiary" wrap="anywhere">{`Fallback: ${families.slice(1).join(" · ")}`}</Typo.Caption>
          </Stack>
          <div className={f.weights}>
            {fontWeights(tokenCatalog).map((token) => (
              <div className={f.weight} key={token.name}>
                <span className={f.weightSample} style={{ "--sample-weight": `var(${token.name})` } as CSSProperties}>Aa가</span>
                <Typo.Caption tone="secondary">{`${weightName(token.name)} ${token.light}`}</Typo.Caption>
              </div>
            ))}
          </div>
        </Stack>
      </div>
      <div className={f.voiceLines}>
        <p className={f.voiceLine} lang={locale}>{DISPLAY_LINES[locale]}</p>
        <p className={f.voiceLine} data-secondary lang={other}>{DISPLAY_LINES[other]}</p>
      </div>
      <div className={f.glyphTable} data-ds-specimen="glyphs">
        {GLYPHS.map(([label, glyphs, lang]) => (
          <div className={f.glyphRow} key={label}>
            <Typo.SectionTitle tone="tertiary">{label}</Typo.SectionTitle>
            <span className={f.glyphs} lang={lang}>{glyphs}</span>
          </div>
        ))}
        <div className={f.glyphRow}>
          <Typo.SectionTitle tone="tertiary">Weight axis</Typo.SectionTitle>
          <Stack gap="xs" minWidth="0">
            <span className={f.axis}>
              {WEIGHT_AXIS.map((weight) => (
                <span className={f.weightSample} key={weight} style={{ "--sample-weight": weight } as CSSProperties}>Aa가</span>
              ))}
            </span>
            <Typo.Caption tone="tertiary">{WEIGHT_AXIS.join(" · ")}</Typo.Caption>
          </Stack>
        </div>
        <div className={f.glyphRow}>
          <Typo.SectionTitle tone="tertiary">Numerals</Typo.SectionTitle>
          <Stack gap="xs" minWidth="0">
            <span className={`${f.glyphs} ${f.proportional}`}>0123456789 <Typo.Caption tone="tertiary">proportional</Typo.Caption></span>
            <span className={f.glyphs}><Typo.Text numeric="tabular">0123456789</Typo.Text> <Typo.Caption tone="tertiary">tabular</Typo.Caption></span>
          </Stack>
        </div>
        <div className={f.glyphRow}>
          <Typo.SectionTitle tone="tertiary">Code · --font-family-code</Typo.SectionTitle>
          <Stack gap="xs" minWidth="0">
            <span className={f.glyphsCode}>{"const reply = await butler.ask(\"요약해 줘\"); // 0O 1lI"}</span>
            <Typo.Caption tone="tertiary" wrap="anywhere">{[fontFamilies(code)[0], BUNDLED_FACES[fontFamilies(code)[0] ?? ""]].filter(Boolean).join(" · ")}</Typo.Caption>
          </Stack>
        </div>
      </div>
    </Stack>
  );
}
