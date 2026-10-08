// Viewer-only page stand-ins for the native view (SVG data URIs, no network). Not product assets.
type Locale = "en-US" | "ko-KR";

const enc = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const FONT = "font-family='Pretendard Variable, Apple SD Gothic Neo, sans-serif'";

const SHOP = {
  "en-US": { brand: "Daily Goods", nav: ["Furniture", "Office", "Kitchen", "Deals"], search: "office chair", cart: "Cart",
    title: "Office chairs", sub: "128 items · lowest price", filters: ["Price", "Under ₩100k", "₩100–200k", "Over ₩200k", "Features", "Mesh back", "Lumbar support", "Headrest", "Delivery", "Tomorrow"],
    items: [["Mesh Office Chair M2", "₩129,000"], ["Air Mesh Chair", "₩139,000"], ["Lumbar Chair L", "₩149,000"], ["Comfort Mesh S", "₩158,000"],
      ["Work Chair Pro", "₩169,000"], ["Slim Mesh Chair", "₩172,000"], ["Basic Office", "₩185,000"], ["Ergo Mesh X", "₩198,000"]], tomorrow: "Tomorrow" },
  "ko-KR": { brand: "데일리굿즈", nav: ["가구", "사무용품", "주방", "특가"], search: "사무용 의자", cart: "장바구니",
    title: "사무용 의자", sub: "128개 상품 · 낮은 가격순", filters: ["가격", "10만원 이하", "10-20만원", "20만원 이상", "기능", "메쉬 등받이", "요추 지지대", "헤드레스트", "배송", "내일 도착"],
    items: [["메쉬 사무용 의자 M2", "129,000원"], ["에어 메쉬 체어", "139,000원"], ["요추 지지 의자 L", "149,000원"], ["컴포트 메쉬 S", "158,000원"],
      ["워크 체어 프로", "169,000원"], ["슬림 메쉬 체어", "172,000원"], ["베이직 오피스", "185,000원"], ["에르고 메쉬 X", "198,000원"]], tomorrow: "내일 도착" },
} as const;

/** Product card `index` (0–7) of the shop page, in page pixels (1280×800). */
export function shopCardRect(index: number) {
  return { x: 312 + (index % 4) * 232, y: 168 + Math.floor(index / 4) * 300, width: 216, height: 284 };
}

function chair(x: number, y: number) {
  return `<rect x='${x}' y='${y}' width='216' height='180' rx='10' fill='#ece8e1'/><rect x='${x + 78}' y='${y + 38}' width='60' height='86' rx='12' fill='#353a42'/><rect x='${x + 104}' y='${y + 124}' width='8' height='40' fill='#6b7078'/>`;
}

/** The shop search page the design uses for Butler's tabs (light, busy enough to test overlays). */
export function shopPage(locale: Locale): string {
  const c = SHOP[locale];
  const cards = c.items.map(([name, price], index) => {
    const { x, y } = shopCardRect(index);
    return `<rect x='${x}' y='${y}' width='216' height='284' rx='10' fill='#ffffff' stroke='#eceef1'/>${chair(x, y)}<text x='${x + 14}' y='${y + 210}' font-size='14' fill='#3a3d42'>${name}</text><text x='${x + 14}' y='${y + 236}' font-size='17' font-weight='700' fill='#17191c'>${price}</text>${index < 4 ? `<text x='${x + 14}' y='${y + 260}' font-size='12' font-weight='600' fill='#e5562c'>${c.tomorrow}</text>` : ""}`;
  }).join("");
  const filters = c.filters.map((label, index) => {
    const head = index % 4 === 0 || index === 8;
    const checked = [2, 5, 6, 9].includes(index);
    return head ? `<text x='40' y='${190 + index * 30}' font-size='14' font-weight='700' fill='#17191c'>${label}</text>`
      : `<rect x='40' y='${178 + index * 30}' width='14' height='14' rx='3' fill='${checked ? "#ff6b35" : "#ffffff"}' stroke='#c9ced4'/><text x='64' y='${190 + index * 30}' font-size='14' fill='#3a3d42'>${label}</text>`;
  }).join("");
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1280 800' ${FONT}><rect width='1280' height='800' fill='#ffffff'/><rect width='1280' height='72' fill='#ffffff'/><line x1='0' y1='72' x2='1280' y2='72' stroke='#eceef1'/><text x='40' y='44' font-size='20' font-weight='800' fill='#17191c'>${c.brand}</text>${c.nav.map((label, index) => `<text x='${190 + index * 78}' y='42' font-size='14' fill='#3a3d42'>${label}</text>`).join("")}<rect x='820' y='20' width='300' height='32' rx='16' fill='#f1f3f5'/><text x='840' y='41' font-size='13' fill='#8a9097'>${c.search}</text><text x='1170' y='42' font-size='14' fill='#3a3d42'>${c.cart}</text><text x='312' y='136' font-size='24' font-weight='800' fill='#17191c'>${c.title}</text><text x='${locale === "ko-KR" ? 440 : 470}' y='136' font-size='14' fill='#6b7078'>${c.sub}</text>${filters}${cards}</svg>`);
}

/** Readability test pages for Butler's pointer: plain white, plain black, and a busy photo. */
export function testPage(kind: "white" | "black" | "photo"): string {
  if (kind !== "photo") return enc(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 400'><rect width='640' height='400' fill='${kind === "white" ? "#ffffff" : "#000000"}'/></svg>`);
  const blobs = [["#2d6a4f", 120, 120, 180], ["#f4a261", 420, 90, 150], ["#264653", 520, 320, 200], ["#e9c46a", 220, 330, 160], ["#8ecae6", 330, 200, 120], ["#b5179e", 80, 360, 110]]
    .map(([fill, cx, cy, r]) => `<circle cx='${cx}' cy='${cy}' r='${r}' fill='${fill}' opacity='0.9'/>`).join("");
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 400'><defs><linearGradient id='s' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#87a8c4'/><stop offset='1' stop-color='#3b4d3a'/></linearGradient><filter id='b'><feGaussianBlur stdDeviation='28'/></filter></defs><rect width='640' height='400' fill='url(#s)'/><g filter='url(#b)'>${blobs}</g></svg>`);
}

/** A picked element's crop (a chair card), `variant` 0 or 1. */
export function cropImage(variant: 0 | 1): string {
  const back = variant === 0 ? "#dfe4ea" : "#ece8e1";
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'><rect width='120' height='120' fill='${back}'/><rect x='42' y='22' width='36' height='52' rx='8' fill='#353a42'/><rect x='57' y='74' width='6' height='26' fill='#6b7078'/><rect x='0' y='92' width='120' height='28' fill='#ffffff'/><rect x='8' y='100' width='60' height='6' rx='3' fill='#3a3d42'/><rect x='8' y='110' width='36' height='6' rx='3' fill='#17191c'/></svg>`);
}

/** A page view still for library cards (an article, a console, docs). */
export function viewImage(kind: "article" | "docs" | "console"): string {
  const accent = kind === "article" ? "#e76f51" : kind === "docs" ? "#3b6fd8" : "#1f8f5f";
  return enc(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 200'><rect width='320' height='200' fill='#ffffff'/><rect width='320' height='24' fill='#f5f6f8'/><rect x='12' y='8' width='48' height='8' rx='4' fill='${accent}'/><rect x='24' y='44' width='180' height='14' rx='4' fill='#2b2f35'/><rect x='24' y='70' width='272' height='8' rx='4' fill='#d7dbe0'/><rect x='24' y='86' width='252' height='8' rx='4' fill='#d7dbe0'/><rect x='24' y='102' width='262' height='8' rx='4' fill='#d7dbe0'/><rect x='24' y='124' width='120' height='60' rx='6' fill='${accent}' opacity='0.18'/><rect x='156' y='124' width='140' height='60' rx='6' fill='#eef0f3'/></svg>`);
}
