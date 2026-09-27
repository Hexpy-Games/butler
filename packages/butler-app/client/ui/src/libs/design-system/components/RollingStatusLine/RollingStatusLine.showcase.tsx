import type { ShowcaseMeta, ShowcaseStory } from "../../showcase";
import { Spinner } from "../Spinner";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { RollingStatusLine } from "./RollingStatusLine";

export const meta: ShowcaseMeta = {
  title: "RollingStatusLine",
  category: "Feedback",
  tags: ["status", "turn", "one-line", "ellipsis"],
  status: "stable",
};

const copy = {
  "en-US": {
    short: "Generating a response",
    long: "Reading the settings screen, the design-system tokens and the three failing layout tests before proposing a fix",
  },
  "ko-KR": {
    short: "응답을 만드는 중",
    long: "설정 화면과 디자인 시스템 토큰, 실패한 레이아웃 테스트 세 개를 먼저 읽고 나서 수정 방법을 제안하는 중",
  },
} as const;

function Line({ text }: { text: string }) {
  return (
    <RollingStatusLine aria-live="polite" title={text}>
      <Stack align="row" gap="sm" cross="center">
        <Spinner size={14} />
        <Typo.Body as="p">{text}</Typo.Body>
      </Stack>
    </RollingStatusLine>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Short status", render: ({ locale }) => <Line text={copy[locale].short} /> },
  {
    name: "Long status truncates",
    states: ["overflow"],
    render: ({ locale }) => (
      <div style={{ maxWidth: 360 }}>
        <Line text={copy[locale].long} />
      </div>
    ),
  },
];
