import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/DropdownMenu";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { animateMotion } from "../../lib/motion";
import { EmptyLine } from "../EmptyLine";
import type { ShowcaseRenderContext } from "../../showcase";
import type { NativeViewBounds, NativeViewViewport } from "./nativeViewGeometry";
import { NativeViewSlot } from "./NativeViewSlot";

type Locale = ShowcaseRenderContext["locale"];

const PAGE_STYLE = { display: "block", width: "100%", height: "100%", objectFit: "cover", objectPosition: "top left" } as const;

/** A 1280×800 shop page drawn as SVG: the stand-in for the live native view. */
function page(hatched: boolean) {
  const card = (x: number) => `<rect x='${x}' y='220' width='280' height='360' rx='16' fill='%23fdfdfd'/><rect x='${x}' y='220' width='280' height='200' rx='16' fill='%23cfe8dc'/><rect x='${x + 20}' y='444' width='200' height='18' rx='9' fill='%23c9ced4'/><rect x='${x + 20}' y='476' width='120' height='18' rx='9' fill='%231f8f5f'/>`;
  const hatch = hatched
    ? "<defs><pattern id='h' width='28' height='28' patternUnits='userSpaceOnUse' patternTransform='rotate(45)'><rect width='14' height='28' fill='%23202327' opacity='.06'/></pattern></defs><rect width='1280' height='800' fill='url(%23h)'/>"
    : "";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1280 800'><rect width='1280' height='800' fill='%23f3f4f6'/><rect width='1280' height='64' fill='%23fdfdfd'/><rect x='40' y='20' width='120' height='24' rx='6' fill='%231f8f5f'/><rect x='420' y='18' width='440' height='28' rx='14' fill='%23e3e6ea'/><rect x='40' y='104' width='560' height='40' rx='8' fill='%23c9ced4'/><rect x='40' y='160' width='420' height='16' rx='8' fill='%23dde1e5'/>${[40, 340, 640, 940].map(card).join("")}${hatch}</svg>`;
  return `data:image/svg+xml,${svg.replace(/</gu, "%3C").replace(/>/gu, "%3E")}`;
}

export const PAGE_SRC = page(false);
/** The still the App captures before covering: here the same page, hatched so the swap is visible. */
export const STILL_SRC = page(true);

export const SLOT_COPY = {
  "en-US": {
    menu: "Menu", items: ["Copy link", "Open in new tab"], toast: "Toast", toastText: "Link copied", slide: "Slide panel",
    hide: "Hide view", show: "Show view", visible: "visible", hidden: "hidden", covered: "covered", clear: "clear", empty: "No open tabs",
    newTab: "New tab", crashed: "This page stopped", reload: "Reload", waiting: "waiting for the first frame",
  },
  "ko-KR": {
    menu: "메뉴", items: ["링크 복사", "새 탭에서 열기"], toast: "토스트", toastText: "링크를 복사했어요", slide: "패널 밀기",
    hide: "뷰 숨기기", show: "뷰 보이기", visible: "표시", hidden: "숨김", covered: "가려짐", clear: "보임", empty: "열린 탭이 없어요",
    newTab: "새 탭", crashed: "페이지가 종료됐어요", reload: "새로고침", waiting: "첫 프레임 대기 중",
  },
} as const;

/** What the App receives, as one tabular line. */
export function BoundsReadout({ bounds, occluded, locale }: { bounds: NativeViewBounds | null; occluded: boolean; locale: Locale }) {
  const copy = SLOT_COPY[locale];
  const text = bounds
    ? `x ${bounds.x} · y ${bounds.y} · ${bounds.width} × ${bounds.height} · scale ${bounds.scale} · ${bounds.visible ? copy.visible : copy.hidden} · ${occluded ? copy.covered : copy.clear}`
    : copy.waiting;
  return <Typo.Caption numeric="tabular" tone="secondary" data-test-class="native-view-readout">{text}</Typo.Caption>;
}

interface SlotDemoProps {
  locale: Locale;
  viewport?: NativeViewViewport;
  covered?: boolean;
  /** Starts hidden and shows this content instead of the page. */
  fallback?: ReactNode;
  controls?: boolean;
  /** Makes the slot the tab panel of a TabStrip with this panelId. */
  panelId?: string;
  height?: string;
}

/** A slot whose children stand in for the native view, with the callbacks printed below it. */
export function SlotDemo({ locale, viewport, covered, fallback, controls = false, panelId, height = "16rem" }: SlotDemoProps) {
  const copy = SLOT_COPY[locale];
  const stage = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<NativeViewBounds | null>(null);
  const [occluded, setOccluded] = useState(false);
  const [hidden, setHidden] = useState(Boolean(fallback));
  const slide = () => {
    if (stage.current) animateMotion(stage.current, [{ transform: "translateX(30%)" }, { transform: "none" }], { duration: "deliberate", easing: "emphasized" });
  };
  return (
    <Stack gap="sm">
      {controls ? (
        <ButtonContainer size="sm">
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="outline" text={copy.menu} /></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {copy.items.map((item) => <DropdownMenuItem key={item}>{item}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="outline" text={copy.toast} onClick={() => toast(copy.toastText)} />
          <Button size="sm" variant="outline" text={copy.slide} onClick={slide} />
          <Button size="sm" variant="outline" text={hidden ? copy.show : copy.hide} onClick={() => setHidden(!hidden)} />
        </ButtonContainer>
      ) : null}
      <div ref={stage} style={{ height }}>
        <NativeViewSlot id={panelId} role={panelId ? "tabpanel" : undefined} hidden={hidden} covered={covered} viewport={viewport} stillSrc={STILL_SRC}
          onBoundsChange={setBounds} onOcclusion={setOccluded}>
          {hidden ? (fallback ?? <EmptyLine message={copy.empty} />) : <img src={PAGE_SRC} alt="" draggable={false} style={PAGE_STYLE} />}
        </NativeViewSlot>
      </div>
      <BoundsReadout bounds={bounds} occluded={occluded} locale={locale} />
    </Stack>
  );
}
