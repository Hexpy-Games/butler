import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  listPersonaPresets,
  setPersona,
} from "../../packages/butler-agent/src/integrations/telegram/commands/butler.ts";

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

let tempRoot = "";
let tempData = "";
let originalHome: string | undefined;
let originalData: string | undefined;

beforeEach(() => {
  originalHome = process.env.BUTLER_HOME;
  originalData = process.env.BUTLER_DATA;
  tempRoot = join(tmpdir(), `butler-persona-home-${Date.now()}-${Math.random()}`);
  tempData = join(tmpdir(), `butler-persona-data-${Date.now()}-${Math.random()}`);
  process.env.BUTLER_HOME = tempRoot;
  process.env.BUTLER_DATA = tempData;
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(tempData, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.BUTLER_HOME;
  else process.env.BUTLER_HOME = originalHome;
  if (originalData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalData;
});

test("setPersona copies the template for the configured user language", () => {
  mkdirSync(join(tempRoot, "resources", "personas", "templates", "en"), { recursive: true });
  mkdirSync(join(tempRoot, "resources", "personas", "templates", "ko"), { recursive: true });
  mkdirSync(tempData, { recursive: true });
  writeFileSync(
    join(tempRoot, "resources", "personas", "templates", "en", "butler.md"),
    "---\nname: butler\npreview: \"English\"\n---\n\n# English Butler\n",
    "utf8",
  );
  writeFileSync(
    join(tempRoot, "resources", "personas", "templates", "ko", "butler.md"),
    "---\nname: butler\npreview: \"한국어\"\n---\n\n# 한국어 Butler\n",
    "utf8",
  );
  writeFileSync(join(tempData, "butler.config.json"), JSON.stringify({ user: { language: "ko" } }, null, 2), "utf8");

  expect(listPersonaPresets()).toEqual(["butler"]);

  setPersona("butler");

  const active = readFileSync(join(tempData, "personas", "active.md"), "utf8");
  expect(active).toContain("base: butler");
  expect(active).toContain("base_locale: ko");
  expect(active).toContain("# 한국어 Butler");

  const config = JSON.parse(readFileSync(join(tempData, "butler.config.json"), "utf8"));
  expect(config.system.activePersona).toBe("butler");
  expect(config.system.activePersonaLocale).toBe("ko");
});
