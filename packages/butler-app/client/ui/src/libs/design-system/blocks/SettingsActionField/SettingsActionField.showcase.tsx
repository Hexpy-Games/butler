import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Typo } from "../../components/Typo";
import { FormSection } from "../FormSection";
import { MetaList } from "../../components/MetaList";
import { SettingsFieldScopeProvider } from "../SettingsField";
import { SurfacePanel } from "../SurfacePanel";
import { SettingsActionField } from "./SettingsActionField";

export const meta: ShowcaseMeta = {
  title: "SettingsActionField",
  category: "Settings & Forms",
  tags: ["settings", "action", "reset"],
  status: "stable",
};

const labels = {
  "en-US": {
    section: "Chat memory",
    storage: "Storage",
    storageDescription: "Deletes old memory files Butler no longer uses. What it remembers stays.",
    free: "Free up space",
    reset: "Reset chat memory",
    resetDescription: "Erases everything remembered from chats. This can't be undone.",
    resetAction: "Reset",
    chats: "Chats",
    size: "Size",
    canFree: "Can free",
    freeing: "Freeing up space · 312.0 MB freed",
    cancel: "Cancel",
    history: "Visited pages",
    historyDescription: "View or clear the pages opened in Butler's browser.",
    view: "View",
    clear: "Clear",
  },
  "ko-KR": {
    section: "대화 기억",
    storage: "저장 공간",
    storageDescription: "쓰지 않는 이전 기억 파일을 지웁니다. 기억한 내용은 그대로입니다.",
    free: "공간 정리",
    reset: "대화 기억 초기화",
    resetDescription: "대화에서 기억한 내용을 모두 지웁니다. 되돌릴 수 없습니다.",
    resetAction: "초기화",
    chats: "대화",
    size: "크기",
    canFree: "확보 가능",
    freeing: "공간 정리 중 · 312.0 MB 확보",
    cancel: "취소",
    history: "방문한 페이지",
    historyDescription: "버틀러 브라우저에서 연 페이지 기록을 보거나 지웁니다.",
    view: "보기",
    clear: "지우기",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Action with facts in meta",
    render: (context) => (
      <SettingsFieldScopeProvider>
        <SettingsActionField id="action-free" label={text(context).storage} description={text(context).storageDescription}
          action={<Button id="action-free" variant="outline" size="sm">{text(context).free}</Button>}
          meta={<MetaList items={[{ label: text(context).chats, value: "128" }, { label: text(context).size, value: "1.2 GB" }]} />} />
      </SettingsFieldScopeProvider>
    ),
  },
  {
    name: "Facts card in details, above the action",
    render: (context) => (
      <SettingsFieldScopeProvider>
        <SettingsActionField id="action-details" label={text(context).storage} description={text(context).storageDescription}
          details={<SurfacePanel elevation="subtle">
            <MetaList items={[{ label: text(context).chats, value: "128" }, { label: text(context).size, value: "1.2 GB" },
              { label: text(context).canFree, value: "312.0 MB" }]} />
          </SurfacePanel>}
          action={<Button id="action-details" variant="outline" size="sm">{text(context).free}</Button>} />
      </SettingsFieldScopeProvider>
    ),
  },
  {
    name: "Progress under the button",
    states: ["busy"],
    render: (context) => (
      <SettingsFieldScopeProvider>
        <SettingsActionField id="action-busy" label={text(context).storage} description={text(context).storageDescription}
          action={<Button id="action-busy" variant="outline" size="sm" disabled aria-busy>{text(context).free}</Button>}
          afterControl={<ButtonContainer size="sm">
            <Typo.Caption role="status" tone="secondary">{text(context).freeing}</Typo.Caption>
            <Button variant="outline" size="sm">{text(context).cancel}</Button>
          </ButtonContainer>} />
      </SettingsFieldScopeProvider>
    ),
  },
  {
    name: "Two actions on one subject",
    render: (context) => (
      <SettingsFieldScopeProvider>
        <SettingsActionField label={text(context).history} description={text(context).historyDescription}
          action={<ButtonContainer size="sm">
            <Button variant="outline" size="sm">{text(context).view}</Button>
            <Button variant="outline" size="sm">{text(context).clear}</Button>
          </ButtonContainer>} />
      </SettingsFieldScopeProvider>
    ),
  },
  {
    name: "Action rows in a section card",
    widths: ["375", "app", "wide"],
    render: (context) => (
      <FormSection title={text(context).section}>
        <SettingsActionField id="card-free" label={text(context).storage} description={text(context).storageDescription}
          action={<Button id="card-free" variant="outline" size="sm">{text(context).free}</Button>}
          meta={<MetaList items={[{ label: text(context).chats, value: "128" }, { label: text(context).size, value: "1.2 GB" }]} />} />
        <SettingsActionField id="card-reset" label={text(context).reset} description={text(context).resetDescription}
          action={<Button id="card-reset" variant="outline" size="sm">{text(context).resetAction}</Button>} />
      </FormSection>
    ),
  },
];
