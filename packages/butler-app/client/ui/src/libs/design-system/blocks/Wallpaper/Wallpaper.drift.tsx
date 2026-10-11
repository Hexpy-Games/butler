import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import type { ShowcaseRenderContext } from "../../showcase";
import type { WallpaperEvent, WallpaperEventKind } from "./drift";
import type { WallpaperContentRect, WallpaperSource } from "./types";
import { Wallpaper } from "./Wallpaper";
import { showcaseImageLoader } from "./Wallpaper.demo";
import styles from "./Wallpaper.showcase.module.css";

const copy = {
  "en-US": {
    focus: "Focus", newChat: "New chat", thinking: "Thinking", done: "Done", screen: "Screen", chat: "Conversation", start: "New chat",
    column: "Message column", rest: "At rest the print drifts by a keyframe every 8 s; events move it more.",
    overlay: "Paper overlay 70%", bloom: "Bloom", image: "Image",
  },
  "ko-KR": {
    focus: "포커스", newChat: "새 채팅", thinking: "생각 중", done: "완료", screen: "화면", chat: "대화", start: "새 채팅",
    column: "메시지 열", rest: "멈춰 있을 때는 8초마다 한 장씩 천천히 번지고, 이벤트가 오면 더 움직입니다.",
    overlay: "종이 덮기 70%", bloom: "Bloom", image: "이미지",
  },
} as const;

const RISO: WallpaperSource = { kind: "live", module: "butler.riso-print" };
const EVENTS: WallpaperEventKind[] = ["focus", "newChat", "thinking", "done"];

/** An element's client rect, kept current on resize (the app measures its column the same way). */
function useClientRect(ref: RefObject<HTMLElement | null>, active: boolean): WallpaperContentRect | undefined {
  const [rect, setRect] = useState<WallpaperContentRect>();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !active) { setRect(undefined); return undefined; }
    const measure = () => {
      const box = element.getBoundingClientRect();
      setRect({ x: box.left, y: box.top, width: box.width, height: box.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, active]);
  return rect;
}

/** The riso print at rest, each event, and the conversation's column keep-out against the new-chat keep-out. */
export function RisoDriftDemo({ locale }: ShowcaseRenderContext) {
  const text = copy[locale];
  const [event, setEvent] = useState<WallpaperEvent>();
  const [screen, setScreen] = useState<"chat" | "start">("chat");
  const columnRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const chat = screen === "chat";
  const column = useClientRect(columnRef, chat);
  const content = useClientRect(contentRef, !chat);
  const composer = useClientRect(composerRef, true);
  return (
    <Stack gap="md">
      <div className={styles.driftStage}>
        <Wallpaper columnRect={column} contentRect={content} contentRect2={composer} event={event} scope="container" source={RISO} />
        {chat ? <div aria-label={text.column} className={styles.driftColumn} ref={columnRef} /> : <div className={styles.driftContent} ref={contentRef} />}
        <div className={styles.driftComposer} ref={composerRef} />
      </div>
      <Stack align="row" cross="center" gap="md" wrap>
        <ButtonContainer size="sm">
          {EVENTS.map((kind) => (
            <Button key={kind} size="sm" text={text[kind]} variant="outline" onClick={() => setEvent((last) => ({ id: Number(last?.id ?? 0) + 1, kind }))} />
          ))}
        </ButtonContainer>
        <SegmentedControl ariaLabel={text.screen} size="sm" value={screen} onValueChange={(value) => setScreen(value as "chat" | "start")}
          options={[{ value: "chat", label: text.chat }, { value: "start", label: text.start }]} />
      </Stack>
      <Typo.Caption tone="secondary">{text.rest}</Typo.Caption>
    </Stack>
  );
}

/** One uniform layer of the theme's paper over a live module and over an image. */
export function PaperOverlayDemo({ locale }: ShowcaseRenderContext) {
  const text = copy[locale];
  const sources: Array<[string, WallpaperSource]> = [
    [text.bloom, { kind: "live", module: "butler.bloom" }],
    [text.image, { kind: "image", asset: "showcase", fit: "cover", dim: 0, blur: 0 }],
  ];
  return (
    <div className={styles.overlayGrid}>
      {sources.map(([label, source]) => (
        <Stack gap="xs" key={label}>
          <div className={styles.overlayStage}>
            <Wallpaper imageLoader={showcaseImageLoader} paperOverlay={0.7} scope="container" source={source} />
          </div>
          <Typo.Caption tone="secondary">{`${label} · ${text.overlay}`}</Typo.Caption>
        </Stack>
      ))}
    </div>
  );
}
