import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../../components/Dialog";
import { Input } from "../../components/Input";
import { SettingsField } from "../SettingsField";
import { DialogForm } from "./DialogForm";

export const meta: ShowcaseMeta = {
  title: "DialogForm",
  category: "Settings & Forms",
  tags: ["dialog", "form", "project", "modal"],
  status: "stable",
};

const labels = {
  "en-US": {
    title: "New project", description: "Name the project and pick its folder.", name: "Project name", folder: "Folder",
    value: "butler-site", path: "~/code/butler-site", cancel: "Cancel", create: "Create", open: "New project", close: "Close",
    deleteTitle: "Delete task \u2018Delete check · Long task titles wrap across several lines without overlapping the task menu\u2019",
    deleteDetail: "Deletes it on this device. Linked conversations stay.", deleteAction: "Delete task", openDelete: "Delete task",
  },
  "ko-KR": {
    title: "새 프로젝트", description: "프로젝트 이름을 정하고 폴더를 고르세요.", name: "프로젝트 이름", folder: "폴더",
    value: "butler-site", path: "~/code/butler-site", cancel: "취소", create: "만들기", open: "새 프로젝트", close: "닫기",
    deleteTitle: "\u2018삭제 확인 · 긴 과제 제목이 여러 줄로 이어져도 작업 메뉴와 겹치지 않고 올바르게 표시됩니다\u2019 과제 삭제",
    deleteDetail: "이 기기에서 삭제합니다. 연결된 대화는 남습니다.", deleteAction: "과제 삭제", openDelete: "과제 삭제",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function ProjectForm({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  const [name, setName] = useState<string>(copy.value);
  return (
    <DialogForm title={copy.title} description={copy.description} onSubmit={() => undefined}
      footer={(
        <ButtonContainer size="default" justify="end">
          <Button type="button" variant="outline" text={copy.cancel} />
          <Button type="submit" disabled={!name.trim()} text={copy.create} />
        </ButtonContainer>
      )}>
      <SettingsField id="ds-project-name" label={copy.name} control={<Input id="ds-project-name" value={name} onChange={(event) => setName(event.target.value)} />} />
      <SettingsField id="ds-project-folder" label={copy.folder} control={<Input id="ds-project-folder" defaultValue={copy.path} readOnly />} />
    </DialogForm>
  );
}

/** useEpicDelete: a confirm whose title quotes a long name wraps before the close button. */
function LongTitleConfirm({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  return (
    <Dialog>
      <DialogTrigger asChild><Button variant="outline" text={copy.openDelete} /></DialogTrigger>
      <DialogContent aria-describedby={undefined} closeLabel={copy.close}>
        <DialogForm dialog title={copy.deleteTitle} description={copy.deleteDetail} onSubmit={() => undefined}
          footer={(
            <ButtonContainer size="sm" justify="end">
              <Button size="sm" type="button" variant="ghost" text={copy.cancel} />
              <Button size="sm" type="submit" variant="destructive" text={copy.deleteAction} />
            </ButtonContainer>
          )}>{null}</DialogForm>
      </DialogContent>
    </Dialog>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Form body", widths: ["375", "app"], render: (context) => <ProjectForm context={context} /> },
  {
    // ProjectCreateDialog: DialogForm inside DialogContent (title visually hidden, DialogForm shows it).
    name: "Inside a dialog",
    states: ["open"],
    render: (context) => (
      <Dialog>
        <DialogTrigger asChild><Button variant="outline" text={text(context).open} /></DialogTrigger>
        <DialogContent aria-describedby={undefined} closeLabel={text(context).close} glassRadius="composer">
          <DialogTitle visuallyHidden>{text(context).title}</DialogTitle>
          <ProjectForm context={context} />
        </DialogContent>
      </Dialog>
    ),
  },
  { name: "Long title beside the close button", states: ["open"], render: (context) => <LongTitleConfirm context={context} /> },
];
