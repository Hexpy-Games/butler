import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const expectedPresets = [
  "archivist",
  "butler",
  "demon-butler",
  "dry-wit",
  "guardian",
  "neko-servant",
  "operator",
  "think-tank",
  "wolf-butler",
];

const personaWeakeningForbiddenPatterns = [
  /casual reply/,
  /캐주얼한 답변/,
  /never in serious/,
  /Switch to plain Butler/,
  /Do not use "nya" in/,
  /상황에서는 크게 줄입니다/,
  /장난 표현을 최소화/,
  /Become concise when the subject is serious/,
  /주제가 심각하면 간결/,
  /Do not become childish in high-stakes contexts/,
  /고위험 맥락에서 유치해지지/,
  /Do not use sarcasm when the user needs care/,
  /돌봄, 정확성, 긴급함을 필요로 할 때는 빈정거리지/,
  /quip later, if at all/,
];

test("bundled persona presets are localized for English and Korean", () => {
  const root = join(process.cwd(), "packages", "butler-agent", "resources", "personas", "templates");
  const en = readdirSync(join(root, "en")).filter((file) => file.endsWith(".md")).map((file) => file.replace(/\.md$/, "")).sort();
  const ko = readdirSync(join(root, "ko")).filter((file) => file.endsWith(".md")).map((file) => file.replace(/\.md$/, "")).sort();

  expect(en).toEqual(expectedPresets);
  expect(ko).toEqual(expectedPresets);

  for (const locale of ["en", "ko"] as const) {
    for (const preset of expectedPresets) {
      const text = readFileSync(join(root, locale, `${preset}.md`), "utf8");
      expect(text).toContain(`name: ${preset}`);
      expect(text).toContain("preview:");
      expect(text).toContain("## Selection Preview");
      expect(text).not.toContain("Persona controls Butler");
      expect(text).not.toContain("Persona는 Butler");
      expect(text).not.toContain("## Motif Study");
      for (const pattern of personaWeakeningForbiddenPatterns) {
        expect(text).not.toMatch(pattern);
      }
      if (preset === "neko-servant") {
        expect(text).toMatch(locale === "ko" ? /민감한 주제에서도 말버릇과 캐릭터를 유지/ : /including work reports, apologies, warnings, sensitive topics/);
      }
      if (preset === "think-tank") {
        expect(text).toMatch(locale === "ko" ? /주제가 심각해도 순수한 호기심/ : /Keep the curious small-AI voice/);
      }
      if (preset === "dry-wit") {
        expect(text).toMatch(locale === "ko" ? /건조한 말맛은 유지/ : /keep the dry wit restrained/);
      }
      if (preset !== "butler") {
        expect(text).toContain("## Signature Lines");
      }
    }
  }
});

test("Korean persona presets use localized runtime voice signals instead of translated English honorifics", () => {
  const root = join(process.cwd(), "packages", "butler-agent", "resources", "personas", "templates", "ko");
  const expectedSignals: Record<string, string[]> = {
    archivist: ["알겠습니다", "기록"],
    "demon-butler": ["예스, 마이 로드", "주군", "크후후"],
    "dry-wit": ["알겠습니다", "건조"],
    guardian: ["도련님", "다시 일어서는 법"],
    "neko-servant": ["냐", "다냐", "냥냥 펀치", "네코냥"],
    operator: ["사장님", "안전 안내"],
    "think-tank": ["지원군 도착", "고스트"],
    "wolf-butler": ["귀하", "주인님"],
  };

  for (const [preset, signals] of Object.entries(expectedSignals)) {
    const text = readFileSync(join(root, `${preset}.md`), "utf8");
    const preview = text.match(/^preview:\s*"([^"]+)"/m)?.[1] ?? "";
    const selectionPreview = text.match(/## Selection Preview\n\n"([^"]+)"/)?.[1] ?? "";

    for (const signal of signals) {
      expect(text).toContain(signal);
    }
    for (const line of [preview, selectionPreview]) {
      expect(line).not.toMatch(/\b(sir|Sir|Master|client|attendant|young master|my lord|nya)\b/);
    }
  }
});
