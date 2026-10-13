// Showcase pages: flat 1280×800 web pages (always light, like real pages) for the live tab stories. No brands, no photos.
import type { AppLocale } from "../../../../../../../../butler-i18n/src/copy-contract.ts";

const enc = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const page = (accent: string, body: string) => enc("<svg xmlns='http://www.w3.org/2000/svg' width='1280' height='800' viewBox='0 0 1280 800'>"
  + "<rect width='1280' height='800' fill='#ffffff'/><rect width='1280' height='72' fill='#ffffff'/><rect y='71' width='1280' height='1' fill='#ececec'/>"
  + `<rect x='48' y='18' width='36' height='36' rx='8' fill='${accent}'/><rect x='98' y='28' width='160' height='16' rx='8' fill='#1d1f22'/>`
  + [0, 1, 2, 3].map((index) => `<rect x='${760 + index * 112}' y='29' width='72' height='14' rx='7' fill='#e3e4e6'/>`).join("")
  + body + "</svg>");

const title = (y: number, width: number) => `<rect x='48' y='${y}' width='${width}' height='36' rx='8' fill='#1d1f22'/>`;
const line = (x: number, y: number, width: number) => `<rect x='${x}' y='${y}' width='${width}' height='16' rx='8' fill='#c9cdd2'/>`;

/** A booking page: hero picture, price, a CTA and the month's calendar (`approval` rings the CTA in amber). */
function booking(cta: boolean) {
  const cells = Array.from({ length: 14 }, (_, index) => {
    const fill = [3, 5].includes(index) ? "#6a8db0" : [1, 2, 4, 6, 9, 10, 12].includes(index) ? "#d4e6d8" : "#e4e6e1";
    return `<rect x='${48 + (index % 7) * 170}' y='${600 + Math.floor(index / 7) * 86}' width='158' height='74' rx='10' fill='${fill}'/>`;
  }).join("");
  return page("#2f7d4a", "<rect x='48' y='112' width='640' height='380' rx='16' fill='#4f7356'/><path d='M248 420 L368 250 L488 420Z' fill='#e8d8b4'/>"
    + "<rect x='48' y='432' width='640' height='60' fill='#3f5d3f'/>" + title(120, 420) + line(728, 176, 360) + title(232, 300).replace("#1d1f22", "#2b2d31")
    + line(728, 290, 280) + "<rect x='728' y='330' width='240' height='64' rx='10' fill='#2f7d4a'/>"
    + (cta ? "<rect x='718' y='320' width='260' height='84' rx='14' fill='none' stroke='#e6b000' stroke-width='6'/>" : "")
    + "<rect x='48' y='540' width='260' height='26' rx='8' fill='#1d1f22'/>" + cells);
}

/** A site map: a river band and decks A–H; `signin` lays a code dialog over it. */
function sites(signin: boolean) {
  const decks = Array.from({ length: 8 }, (_, index) =>
    `<rect x='${48 + (index % 4) * 300}' y='${340 + Math.floor(index / 4) * 150}' width='280' height='120' rx='12' fill='${[0, 3, 6].includes(index) ? "#6a8db0" : "#e4e6e1"}'/>`).join("");
  const dialog = signin ? "<rect width='1280' height='800' fill='#000000' fill-opacity='0.42'/><rect x='390' y='150' width='500' height='420' rx='18' fill='#ffffff'/>"
    + "<rect x='430' y='190' width='160' height='32' rx='8' fill='#1d1f22'/>" + line(430, 246, 400)
    + Array.from({ length: 6 }, (_, index) => `<rect x='${430 + index * 72}' y='300' width='60' height='72' rx='10' fill='none' stroke='${index ? "#d5d7da" : "#1f6fb2"}' stroke-width='3'/>`).join("")
    + "<rect x='430' y='410' width='420' height='64' rx='10' fill='#1f6fb2'/>" : "";
  return page("#1f6fb2", title(112, 640) + line(48, 170, 520) + "<rect x='48' y='220' width='1184' height='90' rx='14' fill='#bcdcf2'/>" + decks + dialog);
}

/** A facilities page: a two-column table. */
function facilities() {
  const rows = Array.from({ length: 5 }, (_, index) => line(56, 260 + index * 76, 160) + line(320, 260 + index * 76, 360 + (index % 2) * 120)
    + `<rect x='48' y='${300 + index * 76}' width='1184' height='1' fill='#ececec'/>`).join("");
  return page("#b4632b", title(112, 460) + line(48, 170, 200) + rows);
}

/** A reviews list. */
function reviews() {
  const cards = Array.from({ length: 3 }, (_, index) => `<rect x='48' y='${200 + index * 180}' width='1184' height='150' rx='14' fill='#f4f4f6'/>`
    + line(80, 230 + index * 180, 280) + line(80, 270 + index * 180, 760) + line(80, 300 + index * 180, 620)).join("");
  return page("#6b5bd2", title(112, 360) + cards);
}

export const LIVE_PAGES = {
  booking: booking(false), bookingApproval: booking(true), sites: sites(false), sitesSignIn: sites(true),
  facilities: facilities(), reviews: reviews(), search: page("#3a3d42", title(112, 520) + line(48, 180, 900) + line(48, 220, 840)),
} as const;

/** Favicons: a coloured square with a letter, as small sites have. */
const favicon = (fill: string, letter: string) => enc(`<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' rx='7' fill='${fill}'/>`
  + `<text x='16' y='22' font-size='17' font-weight='700' text-anchor='middle' fill='#ffffff'>${letter}</text></svg>`);

export interface DemoTab { id: string; title: string; site: string; favicon: string }

const TITLES: Record<AppLocale, Array<[string, string, string]>> = {
  "ko-KR": [["가평 솔숲 캠핑장 · 예약", "솔숲 캠핑장", "솔"], ["양평 강변 캠핑장 · 사이트 안내", "강변 캠핑장", "강"], ["포천 산정 캠핑장 · 시설", "산정 캠핑장", "산"],
    ["캠핑장 후기 모음", "후기 모음", "후"], ["서울 근교 오토캠핑장 추천", "캠핑 추천", "C"]],
  "en-US": [["Pine Grove Campground · Booking", "Pine Grove", "P"], ["Riverside Campground · Site map", "Riverside", "R"], ["Summit Campground · Facilities", "Summit", "S"],
    ["Campground reviews", "Reviews", "V"], ["Car camping near the city", "Car camping", "C"]],
};
const COLORS = ["#2f7d4a", "#1f6fb2", "#b4632b", "#6b5bd2", "#3a3d42"];

export function demoTabs(locale: AppLocale): DemoTab[] {
  return TITLES[locale].map(([title, site, letter], index) => ({ id: `tab-${index + 1}`, title, site, favicon: favicon(COLORS[index]!, letter) }));
}
