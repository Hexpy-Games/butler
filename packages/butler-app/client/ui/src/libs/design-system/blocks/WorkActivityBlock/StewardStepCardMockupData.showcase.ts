import type { ShowcaseRenderContext } from "../../showcase";

export type MockupLocale = ShowcaseRenderContext["locale"];
export type MockupOption = "a" | "b" | "c";
const ko = {
  title: "120mm 팬 6종 비교 조사", details: "작업 세부 내역", result: "결과", done: "완료", running: "진행 중",
  status: "완료 2/4 · 지금: 비교 페이지 제작, be quiet 구매 모델 확정", finished: "완료됨 · 4/4단계",
  revision: "계획 수정 04:00 · 단계 1개 추가", progress: "완료 단계",
  labels: ["접힘 (진행 중)", "펼침 (진행 중)", "끝난 작업 (펼침)"],
  segments: ["1 스펙", "2 가격", "3 페이지", "4 be quiet"],
  search: "웹 검색", page: "페이지 열기", write: "파일 작성", deliver: "파일 전달", check: "페이지 확인",
  names: ["공식 스펙 확인", "국내 최저가 확인", "비교 페이지 제작", "be quiet 구매 모델 확정"],
  purposes: [
    "아틱 P12와 비교할 5종을 고르고 제조사 공식 페이지에서 스펙을 확인합니다.",
    "확정된 6종의 국내 판매가와 판매처를 확인합니다. 스펙은 다시 조사하지 않습니다.",
    "스펙과 가격을 비교표와 제품 카드 한 페이지로 정리해 게시합니다.",
    "국내에서 살 수 있는 be quiet 120mm 모델로 바꿔 스펙과 가격을 확정합니다.",
  ],
  results: [
    "6종 공식 스펙 비교표를 만들었습니다 · 120mm-fan-official-specs.md",
    "6종 중 4종은 판매처 페이지에서 표시가를 확인했고, 2종은 가격비교 기준입니다.",
    "비교 페이지를 게시했습니다 · fan-compare-120mm.html",
    "Pure Wings 3 PWM (BL094) 39,500원 · 컴퓨존",
  ],
  queries: ["Arctic P12 PWM PST 공식 스펙", "아틱 P12 PWM PST 최저가", "녹투아 NF-P12 redux 가격", "be quiet Pure Wings 3 120mm PWM 국내"],
  shops: ["다나와", "컴퓨존", "11번가", "쿠팡"], phone: "390px 화면",
};
const en: typeof ko = {
  title: "Compare six 120mm fans", details: "Work details", result: "Result", done: "Done", running: "Running",
  status: "Done 2/4 · Now: Build comparison page, Confirm be quiet model", finished: "Delivered · 4/4 steps",
  revision: "Plan revised 04:00 · 1 step added", progress: "Completed steps",
  labels: ["Collapsed (running)", "Expanded (running)", "Finished (expanded)"],
  segments: ["1 Specs", "2 Prices", "3 Page", "4 be quiet"],
  search: "Web search", page: "Open page", write: "Write file", deliver: "Deliver file", check: "Check page",
  names: ["Check official specs", "Check Korean prices", "Build comparison page", "Confirm be quiet model"],
  purposes: [
    "Choose five alternatives to the Arctic P12 and verify specs on official manufacturer pages.",
    "Check Korean prices and retailers for the six selected fans. Do not research specs again.",
    "Publish a single page with the spec and price table and product cards.",
    "Switch to an available be quiet 120mm model in Korea and confirm its specs and price.",
  ],
  results: [
    "Created an official spec comparison for six fans · 120mm-fan-official-specs.md",
    "Verified displayed retailer prices for four fans; two use price comparison listings.",
    "Published the comparison page · fan-compare-120mm.html",
    "Pure Wings 3 PWM (BL094) KRW 39,500 · Compuzone",
  ],
  queries: ["Arctic P12 PWM PST official specs", "Arctic P12 PWM PST lowest Korean price", "Noctua NF-P12 redux price", "be quiet Pure Wings 3 120mm PWM Korea"],
  shops: ["Danawa", "Compuzone", "11st", "Coupang"], phone: "390px viewport",
};
export const mockupCopy = { "ko-KR": ko, "en-US": en };
export const fanModels = "Arctic P12 PWM PST, Noctua NF-P12 redux-1700, be quiet! Pure Wings 3, Thermalright TL-C12C, DeepCool FK120, Lian Li UNI FAN P28";

export function mockupSteps(locale: MockupLocale, finished: boolean) {
  const t = mockupCopy[locale];
  const activity = (kind: string, text: string) => ({ title: `${kind} · ${text}`, summaryLabel: kind });
  const pages = (names: string[]) => names.map(name => activity(t.page, name));
  const activities = [
    [activity(t.search, t.queries[0]!), ...pages(["arctic.de", "noctua.at", "bequiet.com", "thermalright.com", "deepcool.com", "lian-li.com"]),
      activity(t.write, "120mm-fan-official-specs.md"), activity(t.deliver, "120mm-fan-official-specs.md")],
    [activity(t.search, t.queries[1]!), ...pages(t.shops), activity(t.search, t.queries[2]!)],
    [activity(t.write, "page.html"), activity(t.check, t.phone)],
    [activity(t.search, t.queries[3]!), ...pages([t.shops[0]!])],
  ];
  return t.names.map((name, index) => ({
    name, purpose: t.purposes[index]!, result: finished || index < 2 ? t.results[index] : undefined,
    running: !finished && index > 1,
    time: index === 0 ? "03:49–03:51" : index === 1 ? "03:51–03:57" : index === 2 ? `03:57${finished ? ` · ${t.done}` : "–"}` : `04:00${finished ? ` · ${t.done}` : "–"}`,
    tools: activities[index]!.map((item, i) => ({ ...item, id: `${index}-${i}`, details: index === 0 && i === 0 ? fanModels : item.title })),
  }));
}
export type MockupStep = ReturnType<typeof mockupSteps>[number];
