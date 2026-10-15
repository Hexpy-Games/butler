// Showcase items from unrelated subjects. The container formats every value (currency, units, times);
// the block only lays them out.
import type { FixturePicture } from "../../components/MediaFrame/fixtures";

export interface FixtureItem {
  picture: FixturePicture;
  eyebrow: string;
  subtitle: string;
  title: string;
  value: { amount: string; was?: string; note?: string };
  facts: string[];
  text: string;
  site: string;
}

type Locale = "en-US" | "ko-KR";

const ITEMS: Record<Locale, FixtureItem[]> = {
  "en-US": [
    { picture: "paper", eyebrow: "1 · Closest match", subtitle: "Kim, Ortega, Liu · ACL 2026", title: "Sparse retrieval for long multilingual documents",
      value: { amount: "1,284 citations", note: "Open-access PDF" }, facts: ["32 pages", "Code released", "Peer-reviewed"],
      text: "Covers the exact setup you asked about: documents over 10k tokens in eight languages, with an ablation on chunk size.", site: "papers.example.org" },
    { picture: "place", eyebrow: "2 · Easy half day", subtitle: "Trail · Lake district", title: "Lakeside loop trail",
      value: { amount: "4.6 km", note: "Loop · about 1 h 40 min" }, facts: ["Flat", "Dogs allowed", "Parking"],
      text: "Shaded most of the way and flat enough for a stroller; the east shore has benches every few hundred meters.", site: "trails.example.org" },
    { picture: "recipe", eyebrow: "3 · Fastest weeknight", subtitle: "Rice dish · Serves 2", title: "Kimchi fried rice with a soft egg",
      value: { amount: "25 min", note: "10 min prep" }, facts: ["Pantry staples", "One pan"],
      text: "Day-old rice crisps best. Fry the kimchi first until the edges caramelize, then add the rice and a spoon of its juice.", site: "recipes.example.com" },
    { picture: "product", eyebrow: "4 · Best value", subtitle: "Kitchen · 1.0 L", title: "Gooseneck pour-over kettle",
      value: { amount: "$39.00", was: "$59.00", note: "Member price" }, facts: ["Ships in 2 days", "Matte black", "1-year warranty"],
      text: "Holds temperature within a degree and pours slowly enough for pour-over; the lid is the only plastic part.", site: "shop.example.com" },
    { picture: "library", eyebrow: "5 · Most used", subtitle: "TypeScript · MIT", title: "tiny-schema: runtime validation with static types",
      value: { amount: "38.2k stars", note: "4.1M weekly downloads" }, facts: ["v4.1.12", "Zero dependencies", "ESM + CJS"],
      text: "Infers types from the schema, so there is one source of truth; errors carry a path to the failing field.", site: "code.example.dev" },
  ],
  "ko-KR": [
    { picture: "paper", eyebrow: "1 · 질문에 가장 가까움", subtitle: "김, 오르테가, 류 · ACL 2026", title: "긴 다국어 문서를 위한 희소 검색",
      value: { amount: "인용 1,284회", note: "무료 PDF 공개" }, facts: ["32쪽", "코드 공개", "동료 심사"],
      text: "물어보신 조건과 같은 설정을 다룹니다. 8개 언어, 1만 토큰이 넘는 문서에서 청크 크기별 비교까지 있어요.", site: "papers.example.org" },
    { picture: "place", eyebrow: "2 · 반나절 가볍게", subtitle: "산책로 · 호수 지구", title: "호숫가 순환 산책로",
      value: { amount: "4.6km", note: "순환 · 약 1시간 40분" }, facts: ["평지", "반려견 동반", "주차 가능"],
      text: "대부분 그늘이고 유모차도 다닐 만큼 평평해요. 동쪽 호숫가에는 몇백 미터마다 벤치가 있어요.", site: "trails.example.org" },
    { picture: "recipe", eyebrow: "3 · 평일 저녁 최단", subtitle: "밥 요리 · 2인분", title: "반숙 달걀 김치볶음밥",
      value: { amount: "25분", note: "손질 10분" }, facts: ["집에 있는 재료", "팬 하나"],
      text: "하루 지난 밥이 가장 바삭해요. 김치를 먼저 가장자리가 눌을 때까지 볶고, 밥과 김치 국물 한 숟가락을 넣으세요.", site: "recipes.example.com" },
    { picture: "product", eyebrow: "4 · 가성비", subtitle: "주방 · 1.0L", title: "드립용 구스넥 전기 주전자",
      value: { amount: "49,000원", was: "69,000원", note: "회원가" }, facts: ["2일 내 출고", "무광 블랙", "1년 보증"],
      text: "온도를 1도 안으로 유지하고 드립에 맞게 천천히 따라져요. 플라스틱은 뚜껑뿐이에요.", site: "shop.example.com" },
    { picture: "library", eyebrow: "5 · 가장 많이 씀", subtitle: "TypeScript · MIT", title: "tiny-schema: 정적 타입과 런타임 검증",
      value: { amount: "별 3.8만", note: "주간 다운로드 410만" }, facts: ["v4.1.12", "의존성 없음", "ESM + CJS"],
      text: "스키마에서 타입을 추론해서 기준이 하나뿐이에요. 오류에는 실패한 필드까지의 경로가 들어 있어요.", site: "code.example.dev" },
  ],
};

export const LABELS = {
  "en-US": { checked: "Checked 5:41 PM", open: "checked at 5:41 PM, open the page", save: "Save to library", saved: "Saved to library", copy: "Copy", copied: "Copied",
    before: "Before", more: "Show more", less: "Show less" },
  "ko-KR": { checked: "오후 5:41 확인", open: "오후 5:41에 확인한 페이지 열기", save: "서랍에 저장", saved: "서랍에 저장했어요", copy: "복사", copied: "복사했어요",
    before: "이전", more: "더 보기", less: "접기" },
} as const;

/** A stand-in for the container's save: it settles after a short round trip, then the button confirms. */
export const fixtureSave = () => new Promise<void>((resolve) => setTimeout(resolve, 300));

export function fixtureItems(locale: Locale): FixtureItem[] {
  return ITEMS[locale];
}
