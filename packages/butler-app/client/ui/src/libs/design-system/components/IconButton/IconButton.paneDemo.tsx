import type { ReactElement } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { ButtonContainer } from "../ButtonContainer";
import { AppleReminder, FileText, Globe2 } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { IconButton, type IconButtonPane } from "./IconButton";

const labels = {
  "en-US": {
    aside: "Session info", viewer: "File viewer", browser: "Hide browser",
    note: "Closed, then open: each toggle fills with the surface of the pane it opened, opaque.",
  },
  "ko-KR": {
    aside: "세션 정보", viewer: "파일 보기", browser: "브라우저 닫기",
    note: "닫힘, 그다음 열림: 토글은 자신이 연 창의 바탕색을 불투명하게 채웁니다.",
  },
} as const;

const icons: Record<IconButtonPane, ReactElement> = {
  aside: <AppleReminder size="md" />,
  viewer: <FileText size="md" />,
  browser: <Globe2 size="md" />,
};

/** Pane toggles (세션 정보, the file viewer, the browser) closed and open; the 세션 정보 toggle keeps its dot. */
export function PaneToggles({ locale }: ShowcaseRenderContext) {
  const copy = labels[locale];
  const panes: IconButtonPane[] = ["aside", "viewer", "browser"];
  return (
    <Stack gap="sm">
      {[false, true].map((open) => (
        <ButtonContainer size="icon-sm" key={String(open)}>
          {panes.map((pane) => (
            <IconButton key={pane} label={copy[pane]} pane={pane} pressed={open} tone={open ? "butler" : "default"}
              indicator={pane === "aside"}>{icons[pane]}</IconButton>
          ))}
        </ButtonContainer>
      ))}
      <Typo.Caption tone="secondary">{copy.note}</Typo.Caption>
    </Stack>
  );
}
