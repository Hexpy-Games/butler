import type { ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { TintedGlass } from "./TintedGlass";
import styles from "./TintedGlass.showcase.module.css";

export const meta: ShowcaseMeta = {
  title: "TintedGlass",
  category: "Layout",
  tags: ["surface", "glass", "overlay", "blur"],
  status: "stable",
};

const copy = {
  "en-US": {
    background: [
      "Messages keep scrolling behind the composer while you type.",
      "The glass keeps this text readable at the edges and quiet in the middle.",
      "Edge fades reveal the 4px blur; the center stays opaque.",
      "Popovers and menus use the same tinted surface at a smaller size.",
      "Colored marks show how the tint mixes with content behind it.",
      "Messages keep scrolling behind the composer while you type.",
    ],
    composerTitle: "Composer surface",
    composerBody: "Edge fades reveal the 4px blur while the center stays opaque like the composer surface.",
    popover: "Popover sized surface",
  },
  "ko-KR": {
    background: [
      "입력하는 동안에도 메시지는 입력창 뒤에서 계속 스크롤됩니다.",
      "유리 표면은 가장자리에서는 뒤 글자를 비추고 가운데에서는 조용히 가립니다.",
      "가장자리 페이드가 4px 블러를 드러내고 가운데는 불투명하게 유지됩니다.",
      "팝오버와 메뉴도 같은 색조 표면을 더 작은 크기로 씁니다.",
      "색 표시는 뒤 콘텐츠와 색조가 어떻게 섞이는지 보여 줍니다.",
      "입력하는 동안에도 메시지는 입력창 뒤에서 계속 스크롤됩니다.",
    ],
    composerTitle: "입력창 표면",
    composerBody: "가장자리 페이드가 4px 블러를 드러내고, 가운데는 입력창처럼 불투명하게 유지됩니다.",
    popover: "팝오버 크기 표면",
  },
} as const;

function Stage({ locale, children }: ShowcaseRenderContext & { children: ReactNode }) {
  return (
    <div className={styles.stage}>
      <div className={styles.backgroundText} aria-hidden="true">
        {copy[locale].background.map((line, index) => <span key={index}>{line}</span>)}
      </div>
      <div className={styles.pictureMarks} aria-hidden="true">
        <span className={`${styles.mark} ${styles.markOne}`} />
        <span className={`${styles.mark} ${styles.markTwo}`} />
        <span className={`${styles.mark} ${styles.markThree}`} />
      </div>
      {children}
    </div>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Composer surface",
    render: ({ locale }) => (
      <Stage locale={locale}>
        <TintedGlass className={styles.demo} padding="lg" radius="composer">
          <Typo.PanelSectionTitle>{copy[locale].composerTitle}</Typo.PanelSectionTitle>
          <Typo.Body>{copy[locale].composerBody}</Typo.Body>
        </TintedGlass>
      </Stage>
    ),
  },
  {
    name: "Popover surface",
    render: ({ locale }) => (
      <Stage locale={locale}>
        <Stack className={styles.stack} gap="sm">
          <TintedGlass className={styles.compact} padding="sm" radius="popover">
            <Typo.Caption>{copy[locale].popover}</Typo.Caption>
          </TintedGlass>
        </Stack>
      </Stage>
    ),
  },
];
