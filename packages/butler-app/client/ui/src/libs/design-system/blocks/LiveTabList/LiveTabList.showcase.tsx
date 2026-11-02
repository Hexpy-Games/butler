import { useState } from "react";
import type { AppLocale } from "../../../../../../../../butler-i18n/src/copy-contract.ts";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { demoTabs, LIVE_PAGES } from "../LiveTabCard/fixtures";
import { LiveTabList } from "./LiveTabList";

export const meta: ShowcaseMeta = { title: "LiveTabList", category: "Browser", status: "beta", tags: ["browser", "tabs", "preview", "overflow"] };

const PAGES = Object.values(LIVE_PAGES);
const COLORS = ["#2f7d4a", "#1f6fb2", "#b4632b", "#6b5bd2", "#3a3d42", "#a23b5c", "#0f7a80"];
const MORE: Record<AppLocale, Array<[string, string]>> = {
  "ko-KR": [["주말 날씨 예보", "날"], ["기차 시간표", "기"], ["주변 산책로 지도", "산"], ["장비 대여 안내", "장"], ["예약 확인 메일", "M"], ["여행 경로", "경"], ["장보기 목록", "장"]],
  "en-US": [["Weekend forecast", "W"], ["Train timetable", "T"], ["Nearby trails", "N"], ["Gear rental", "G"], ["Booking confirmation", "M"], ["Travel route", "R"], ["Grocery list", "L"]],
};
const icon = (fill: string, letter: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' rx='7' fill='${fill}'/><text x='16' y='22' font-size='17' font-weight='700' text-anchor='middle' fill='#ffffff'>${letter}</text></svg>`)}`;

/** Twelve realistic tabs: the LiveTabCard demo set, then more trip-planning pages with their own favicons. */
function tabs(locale: AppLocale, count: number) {
  const base = demoTabs(locale).map(({ id, title, favicon }) => ({ id, title, favicon }));
  const more = MORE[locale].map(([title, letter], index) => ({ id: `more-${index}`, title, favicon: icon(COLORS[index]!, letter) }));
  return [...base, ...more].slice(0, count).map((tab, index) => ({
    ...tab, frame: PAGES[index % PAGES.length]!, onOpen: () => undefined, onClose: () => undefined,
    closeLabel: locale === "ko-KR" ? "탭 닫기" : "Close tab",
  }));
}

function Example({ locale, count = 5, initialExpanded = false }: ShowcaseRenderContext & { count?: number; initialExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const ko = locale === "ko-KR";
  return <LiveTabList tabs={tabs(locale, count)} expanded={expanded} onExpandedChange={setExpanded}
    labels={{ more: n => ko ? `탭 ${n}개 더 보기` : `Show ${n} more tabs`, overflow: n => `+${n}`, less: ko ? "접기" : "Show less" }} />;
}

export const stories: ShowcaseStory[] = [2, 3, 5, 12].flatMap(count => [false, true].map(expanded => ({
  name: `${count} tabs · ${expanded ? "expanded" : "folded"}`, widths: ["320", "375", "app"],
  render: ({ locale }: ShowcaseRenderContext) => <Example locale={locale} count={count} initialExpanded={expanded} />,
})));

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "open"],
  variants: ["overflow"],
  render: ({ locale, state }) => <Example locale={locale} count={12} initialExpanded={state === "open"} />,
};
