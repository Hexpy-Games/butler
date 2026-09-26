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
  },
  "ko-KR": {
    title: "새 프로젝트", description: "프로젝트 이름을 정하고 폴더를 고르세요.", name: "프로젝트 이름", folder: "폴더",
    value: "butler-site", path: "~/code/butler-site", cancel: "취소", create: "만들기", open: "새 프로젝트", close: "닫기",
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
];
