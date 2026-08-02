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
    latencyTargetMs: 60_000,
    hardStopMs: 300_000,
  },
  {
    id: "direct_translation",
    tier: "direct",
    promptTemplate: "‘배송이 예정보다 하루 늦어졌습니다’를 자연스러운 영어로 번역해 주세요.",
    requiredOutcomes: ["faithful_translation", "natural_english"],
    expectedLedgerRoute: "none",
    latencyTargetMs: 60_000,
    hardStopMs: 300_000,
  },
  {
    id: "direct_basic_knowledge",
    tier: "direct",
    promptTemplate: "물은 표준 대기압에서 섭씨 몇 도에 끓는지 한 문장으로 알려 주세요.",
    requiredOutcomes: ["correct_temperature", "one_sentence"],
    expectedLedgerRoute: "none",
    latencyTargetMs: 60_000,
    hardStopMs: 300_000,
  },
  {
    id: "simple_weather",
    tier: "simple_tool",
    promptTemplate: "{{WEATHER_DATE}} 서울의 날씨를 확인하고 우산이 필요한지 간단히 알려 주세요.",
    requiredOutcomes: ["weather_checked", "umbrella_advice"],
    expectedLedgerRoute: "none",
    latencyTargetMs: 120_000,
    hardStopMs: 300_000,
  },
  {
    id: "simple_folder_exists",
    tier: "simple_tool",
    promptTemplate: "제 컴퓨터의 {{EXISTING_FOLDER_PATH}} 폴더가 실제로 있는지 확인해서 결과만 알려 주세요.",
    requiredOutcomes: ["folder_checked", "existence_reported"],
    expectedLedgerRoute: "none",
    latencyTargetMs: 120_000,
    hardStopMs: 300_000,
  },
  {
    id: "simple_recent_news",
    tier: "simple_tool",
    promptTemplate: "{{NEWS_DATE}} 기준 서울의 최근 주요 뉴스 한 건을 확인하고 제목, 핵심 내용, 출처를 간단히 알려 주세요.",
    requiredOutcomes: ["news_checked", "source_reported", "concise_summary"],
    expectedLedgerRoute: "none",
    latencyTargetMs: 120_000,
    hardStopMs: 300_000,
  },
  {
    id: "work_market_research",
    tier: "work_ledger",
    promptTemplate: "{{MARKET_DATE}} 기준 최근 주식시장 동향을 조사해 주세요. KOSPI, S&P 500, Nasdaq의 흐름과 핵심 원인, 주요 위험을 출처와 함께 표와 요약으로 정리하고 {{WORK_REPORT_PATH}}에 Markdown 보고서를 저장해 주세요.",
    requiredOutcomes: ["three_indexes", "drivers", "risks", "citations", "report_created"],
    expectedLedgerRoute: "work",
    latencyTargetMs: 300_000,
    hardStopMs: 360_000,
  },
  {
    id: "work_sausage_research",
    tier: "work_ledger",
    promptTemplate: "한국에서 판매 중인 소시지 6개를 조사해 제품별 돈육 함량, 제조사, 근거 출처를 표로 비교하고 확인할 수 없는 값은 명시해 {{SAUSAGE_REPORT_PATH}}에 저장해 주세요.",
    requiredOutcomes: ["six_products", "pork_content", "citations", "unknowns_truthful", "report_created"],
    expectedLedgerRoute: "work",
    latencyTargetMs: 300_000,
    hardStopMs: 360_000,
  },
  {
    id: "work_fixture_analysis",
    tier: "work_ledger",
    promptTemplate: "{{WORK_INPUT_FOLDER}}의 세 CSV를 함께 분석해 월별 합계, 가장 큰 증감 원인, 데이터 한계를 표와 요약으로 정리하고 {{WORK_ANALYSIS_REPORT_PATH}}에 Markdown 보고서를 저장해 주세요.",
    requiredOutcomes: ["three_files_used", "monthly_totals", "change_driver", "limitations", "report_created"],
    expectedLedgerRoute: "work",
    latencyTargetMs: 300_000,
    hardStopMs: 360_000,
  },
  {
    id: "project_butler_landing",
    tier: "project_ledger",
    promptTemplate: "이 프로젝트에 Butler를 소개하는 세련되고 힙한 반응형 랜딩페이지를 만들어 주세요. 기존 기술 스택을 따르고 핵심 기능, 사용 장면, 명확한 CTA를 담은 뒤 빌드와 화면을 검증해 주세요.",
    requiredOutcomes: ["responsive_page", "butler_brand", "features", "cta", "build_verified", "render_verified"],
    expectedLedgerRoute: "project",
    latencyTargetMs: 300_000,
    hardStopMs: 360_000,
  },
  {
    id: "project_sandy_landing",
    tier: "project_ledger",
    promptTemplate: "이 프로젝트에 Sandy를 주제로 한 세련되고 힙한 반응형 랜딩페이지를 만들어 주세요. 제품의 성격, 주요 기능, 사용 예, CTA를 담고 빌드와 화면을 검증해 주세요.",
    requiredOutcomes: ["responsive_page", "sandy_brand", "features", "cta", "build_verified", "render_verified"],
    expectedLedgerRoute: "project",
    latencyTargetMs: 300_000,
    hardStopMs: 360_000,
  },
  {
    id: "project_product_dashboard",
    tier: "project_ledger",
    promptTemplate: "이 프로젝트에 제품 상태를 한눈에 보여 주는 세련된 반응형 대시보드 페이지를 만들어 주세요. 기존 기술 스택과 디자인 언어를 따르고 핵심 지표, 최근 활동, 명확한 다음 행동을 담은 뒤 빌드와 화면을 검증해 주세요.",
    requiredOutcomes: ["responsive_page", "project_style", "key_metrics", "recent_activity", "next_action", "build_verified", "render_verified"],
    expectedLedgerRoute: "project",
    latencyTargetMs: 300_000,
    hardStopMs: 360_000,
  },
]);

export const FORMAL_BENCHMARK_REPETITIONS = 3;

export function materializeBenchmarkCorpus(
  fixtures: Record<string, string>,
): MaterializedBenchmarkPrompt[] {
  const prompts: MaterializedBenchmarkPrompt[] = [];
  for (let repetition = 1; repetition <= FORMAL_BENCHMARK_REPETITIONS; repetition += 1) {
    for (
      let caseIndex = 0;
      caseIndex < BTCC_REVISION_BENCHMARK_CORPUS.length;
      caseIndex += 1
    ) {
      const item = BTCC_REVISION_BENCHMARK_CORPUS[caseIndex]!;
      prompts.push({
        id: `${item.id}__run_${repetition}`,
        tier: item.tier,
        prompt: item.promptTemplate.replace(
          /\{\{([A-Z0-9_]+)\}\}/gu,
          (_match, key: string) => {
            const value = fixtures[key];
            if (!value?.trim()) throw new Error(`Missing benchmark fixture: ${key}`);
            return value;
          },
        ),
        requiredOutcomes: [...item.requiredOutcomes],
        expectedLedgerRoute: item.expectedLedgerRoute,
        latencyTargetMs: item.latencyTargetMs,
        hardStopMs: item.hardStopMs,
        order: (caseIndex + repetition - 1) % 2 === 0
          ? ["r2", "r3"]
          : ["r3", "r2"],
      });
    }
  }
  return prompts;
}
