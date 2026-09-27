import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Typo } from "../../components/Typo";
import { SetupWizardContent, SetupWizardList, SetupWizardShell } from "./SetupWizardShell";

export const meta: ShowcaseMeta = {
  title: "SetupWizardShell",
  category: "Shell",
  tags: ["shell", "setup", "first-run", "wizard", "page"],
  status: "stable",
};

const labels = {
  "en-US": {
    steps: ["Language", "Safety", "Install", "Model"], title: "Safety", body: "Butler works on your computer with the access you allow.",
    items: ["Review commands before granting full access.", "Keep secrets out of shared projects.", "You can stop a worker whenever you need to."],
    back: "Back", accept: "Accept",
  },
  "ko-KR": {
    steps: ["언어", "안전", "설치", "모델"], title: "안전", body: "Butler는 허용한 권한으로 컴퓨터에서 작업합니다.",
    items: ["전체 권한을 주기 전에 명령을 확인하세요.", "공유 프로젝트에 비밀 정보를 두지 마세요.", "언제든 워커를 멈출 수 있습니다."],
    back: "뒤로", accept: "동의",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function Wizard({ context, tone }: { context: ShowcaseRenderContext; tone: "light" | "dark" }) {
  const copy = text(context);
  return (
    <SetupWizardShell embedded activeIndex={1} title="Butler" tone={tone} steps={copy.steps.map((label) => ({ id: label, label }))}>
      <SetupWizardContent>
        <Typo.H3 as="h1">{copy.title}</Typo.H3>
        <Typo.Body>{copy.body}</Typo.Body>
        <SetupWizardList>{copy.items.map((item) => <li key={item}><Typo.Body as="span">{item}</Typo.Body></li>)}</SetupWizardList>
        <ButtonContainer size="default">
          <Button variant="outline">{copy.back}</Button>
          <Button>{copy.accept}</Button>
        </ButtonContainer>
      </SetupWizardContent>
    </SetupWizardShell>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Step (light backdrop)", widths: ["375", "app", "wide"], render: (context) => <Wizard context={context} tone="light" /> },
  { name: "Step (dark backdrop)", widths: ["375", "app", "wide"], render: (context) => <Wizard context={context} tone="dark" /> },
];
