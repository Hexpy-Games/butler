import type {
  BenchmarkPromptCase,
  MaterializedBenchmarkPrompt,
} from "./contracts.ts";

export const BTCC_REVISION_BENCHMARK_CORPUS: readonly BenchmarkPromptCase[] = Object.freeze([
  {
    id: "direct_greeting",
    tier: "direct",
    promptTemplate: "안녕하세요. 오늘도 잘 부탁해요.",
    requiredOutcomes: ["natural_greeting"],
    expectedLedgerRoute: "none",
    timeoutMs: 60_000,
  },
  {
    id: "direct_translation",
    tier: "direct",
    promptTemplate: "‘배송이 예정보다 하루 늦어졌습니다’를 자연스러운 영어로 번역해 주세요.",
    requiredOutcomes: ["faithful_translation", "natural_english"],
    expectedLedgerRoute: "none",
    timeoutMs: 60_000,
  },
  {
    id: "simple_weather",
    tier: "simple_tool",
    promptTemplate: "{{WEATHER_DATE}} 서울의 날씨를 확인하고 우산이 필요한지 간단히 알려 주세요.",
    requiredOutcomes: ["weather_checked", "umbrella_advice"],
    expectedLedgerRoute: "none",
    timeoutMs: 180_000,
  },
  {
    id: "simple_folder_exists",
    tier: "simple_tool",
    promptTemplate: "제 컴퓨터의 {{EXISTING_FOLDER_PATH}} 폴더가 실제로 있는지 확인해서 결과만 알려 주세요.",
    requiredOutcomes: ["folder_checked", "existence_reported"],
    expectedLedgerRoute: "none",
    timeoutMs: 180_000,
  },
  {
    id: "work_market_research",
    tier: "work_ledger",
    promptTemplate: "{{MARKET_DATE}} 기준 최근 주식시장 동향을 조사해 주세요. KOSPI, S&P 500, Nasdaq의 흐름과 핵심 원인, 주요 위험을 출처와 함께 표와 요약으로 정리하고 {{WORK_REPORT_PATH}}에 Markdown 보고서를 저장해 주세요.",
    requiredOutcomes: ["three_indexes", "drivers", "risks", "citations", "report_created"],
    expectedLedgerRoute: "work",
    timeoutMs: 900_000,
  },
  {
    id: "work_sausage_research",
    tier: "work_ledger",
    promptTemplate: "한국에서 판매 중인 소시지 6개를 조사해 제품별 돈육 함량, 제조사, 근거 출처를 표로 비교하고 확인할 수 없는 값은 명시해 {{SAUSAGE_REPORT_PATH}}에 저장해 주세요.",
    requiredOutcomes: ["six_products", "pork_content", "citations", "unknowns_truthful", "report_created"],
    expectedLedgerRoute: "work",
    timeoutMs: 900_000,
  },
  {
    id: "project_butler_landing",
    tier: "project_ledger",
    promptTemplate: "이 프로젝트에 Butler를 소개하는 세련되고 힙한 반응형 랜딩페이지를 만들어 주세요. 기존 기술 스택을 따르고 핵심 기능, 사용 장면, 명확한 CTA를 담은 뒤 빌드와 화면을 검증해 주세요.",
    requiredOutcomes: ["responsive_page", "butler_brand", "features", "cta", "build_verified", "render_verified"],
    expectedLedgerRoute: "project",
    timeoutMs: 1_800_000,
  },
  {
    id: "project_sandy_landing",
    tier: "project_ledger",
    promptTemplate: "이 프로젝트에 Sandy를 주제로 한 세련되고 힙한 반응형 랜딩페이지를 만들어 주세요. 제품의 성격, 주요 기능, 사용 예, CTA를 담고 빌드와 화면을 검증해 주세요.",
    requiredOutcomes: ["responsive_page", "sandy_brand", "features", "cta", "build_verified", "render_verified"],
    expectedLedgerRoute: "project",
    timeoutMs: 1_800_000,
  },
]);

export function materializeBenchmarkCorpus(
  fixtures: Record<string, string>,
): MaterializedBenchmarkPrompt[] {
  return BTCC_REVISION_BENCHMARK_CORPUS.map((item, index) => ({
    id: item.id,
    tier: item.tier,
    prompt: item.promptTemplate.replace(/\{\{([A-Z0-9_]+)\}\}/gu, (_match, key: string) => {
      const value = fixtures[key];
      if (!value?.trim()) throw new Error(`Missing benchmark fixture: ${key}`);
      return value;
    }),
    requiredOutcomes: [...item.requiredOutcomes],
    expectedLedgerRoute: item.expectedLedgerRoute,
    timeoutMs: item.timeoutMs,
    order: index % 2 === 0 ? ["r2", "r3"] : ["r3", "r2"],
  }));
}
