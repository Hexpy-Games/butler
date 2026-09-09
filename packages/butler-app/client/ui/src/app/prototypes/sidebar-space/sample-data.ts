/** In-memory sample records; never connected to the production App store. */
export type SpaceItem = {
  id: string;
  title: string;
  kind: "session" | "group" | "project";
  parent: string | null;
  status?: string;
  activity?: "working" | "attention";
  updatedAt?: number;
  pinned?: boolean;
  smart?: boolean;
  preview?: string;
  source?: string;
};

const sampleNow = Date.now();
export const initialItems: SpaceItem[] = [
  {
    id: "insurance",
    updatedAt: sampleNow - 2 * 86400000,
    title: "보험 보장 비교",
    kind: "session",
    parent: "health",
    pinned: true,
    preview:
      "기존 실손보험을 유지하면서 암 진단비를 보완하려고 합니다. 월 보험료는 10만 원 이내로 비교합니다.",
  },
  {
    id: "oauth",
    updatedAt: sampleNow - 3 * 60000,
    title: "OAuth 연결 마무리",
    kind: "session",
    parent: "sandy",
    pinned: true,
    status: "작업 중 · 2/3",
    activity: "working",
    preview:
      "Sandy의 OAuth 연결을 구현하고 있습니다. 사용자별 인증 정보를 분리하고 대시보드에서 연결 상태를 확인할 수 있게 합니다.",
  },
  {
    id: "kyoto",
    updatedAt: sampleNow - 2 * 3600000,
    title: "교토 숙소 비교",
    kind: "session",
    parent: null,
    preview:
      "교토역 가까운 숙소를 비교했습니다. 3박 일정으로 이동 시간을 줄이는 것이 우선입니다.",
  },
  { id: "health", title: "건강", kind: "group", parent: null },
  { id: "checkup", title: "건강검진 준비", kind: "session", parent: "health", updatedAt: sampleNow - 4 * 3600000 },
  { id: "products", title: "제품", kind: "group", parent: null },
  { id: "butler", title: "Butler", kind: "project", parent: "products" },
  {
    id: "sidebar",
    updatedAt: sampleNow - 12 * 60000,
    title: "사이드바와 대화 정리",
    kind: "session",
    parent: "butler",
    status: "확인 필요",
    activity: "attention",
    preview:
      "#일반에서 일상 대화를 이어가고, 필요할 때 주제대화로 분리합니다. 그룹은 탐색용이며 프로젝트 실행 환경을 바꾸지 않습니다.",
  },
  {
    id: "research",
    updatedAt: sampleNow - 60000,
    title: "에이전트 UI 리서치",
    kind: "session",
    parent: "products",
  },
  { id: "sandy", title: "Sandy", kind: "project", parent: null },
];

export const branchContext =
  "사용자 요청: 기존 보장을 유지하면서 보험을 정리하고 싶습니다.\n조건: 월 보험료 10만 원 이내\n정리한 내용: 현재 가입한 보험에서 겹치는 보장을 먼저 확인합니다.\n다음 단계: 사용자가 보내는 보험증권을 바탕으로 보장 내용과 월 보험료를 정리합니다.";

export function locationOf(item: SpaceItem, items: SpaceItem[]): string {
  const parts: string[] = [];
  let parent = items.find((candidate) => candidate.id === item.parent);
  while (parent) {
    parts.unshift(parent.title);
    parent = items.find((candidate) => candidate.id === parent?.parent);
  }
  return parts.join(" › ") || "스페이스";
}

export function isProjectConversation(
  item: SpaceItem,
  items: SpaceItem[],
): boolean {
  let parent = items.find((candidate) => candidate.id === item.parent);
  while (parent) {
    if (parent.kind === "project") return true;
    parent = items.find((candidate) => candidate.id === parent?.parent);
  }
  return false;
}
