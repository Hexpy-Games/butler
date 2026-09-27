import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { ButtonContainer } from "../ButtonContainer";
import { Field, FieldLabel } from "../Field";
import { Input } from "../Input";
import { Textarea } from "../Textarea";
import { Typo } from "../Typo";
import { ScrollArea } from "../../blocks/ScrollArea";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./Dialog";

export const meta: ShowcaseMeta = {
  title: "Dialog",
  category: "Overlay",
  tags: ["overlay", "focused-task", "glass", "motion", "modal"],
  status: "stable",
};

const labels = {
  "en-US": {
    rename: "Rename", renameTitle: "Rename conversation", field: "Name", value: "Token page review",
    cancel: "Cancel", save: "Save", close: "Close", description: "Project description",
    descriptionValue: "Butler desktop app: Electron shell, React UI and the Rust agent gateway.",
    edit: "Edit description", confirm: "Archive conversation?", confirmBody: "You can restore it from Archived conversations.",
    archive: "Archive",
  },
  "ko-KR": {
    rename: "이름 바꾸기", renameTitle: "대화 이름 바꾸기", field: "이름", value: "토큰 페이지 검토",
    cancel: "취소", save: "저장", close: "닫기", description: "프로젝트 설명",
    descriptionValue: "Butler 데스크톱 앱: Electron 셸, React UI, Rust 에이전트 게이트웨이.",
    edit: "설명 편집", confirm: "대화를 보관할까요?", confirmBody: "보관된 대화에서 다시 복원할 수 있습니다.",
    archive: "보관",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** SessionRenameDialog: header, one field, footer with cancel + submit. */
function RenameDialog({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  const [value, setValue] = useState<string>(copy.value);
  return (
    <Dialog>
      <DialogTrigger asChild><Button variant="outline" text={copy.rename} /></DialogTrigger>
      <DialogContent closeLabel={copy.close}>
        <DialogHeader>
          <DialogTitle>{copy.renameTitle}</DialogTitle>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="ds-dialog-rename">{copy.field}</FieldLabel>
          <Input id="ds-dialog-rename" value={value} onChange={(event) => setValue(event.target.value)} />
        </Field>
        <DialogFooter>
          <ButtonContainer size="default" justify="end">
            <DialogClose asChild><Button type="button" variant="outline" text={copy.cancel} /></DialogClose>
            <DialogClose asChild><Button disabled={!value.trim()} text={copy.save} /></DialogClose>
          </ButtonContainer>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** ProjectDocumentDialog / SessionObserverDialog: a wide reader with one scrolling body. */
function ReaderDialog({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  return (
    <Dialog>
      <DialogTrigger asChild><Button variant="outline" text={copy.description} /></DialogTrigger>
      <DialogContent closeLabel={copy.close} size="xl" layout="scroll-body" maxHeight="3/5">
        <DialogHeader>
          <DialogTitle>{copy.description}</DialogTitle>
          <DialogDescription>{copy.descriptionValue}</DialogDescription>
        </DialogHeader>
        <ScrollArea fill>
          {Array.from({ length: 12 }, (_, index) => <Typo.Body key={index}>{copy.descriptionValue}</Typo.Body>)}
        </ScrollArea>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline" text={copy.cancel} /></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Rename conversation", states: ["open"], render: (context) => <RenameDialog context={context} /> },
  {
    name: "Edit project description",
    render: (context) => (
      <Dialog>
        <DialogTrigger asChild><Button variant="borderless" size="sm" text={text(context).edit} /></DialogTrigger>
        <DialogContent closeLabel={text(context).close}>
          <DialogHeader><DialogTitle>{text(context).description}</DialogTitle></DialogHeader>
          <Textarea aria-label={text(context).description} defaultValue={text(context).descriptionValue} maxLength={2000} />
          <ButtonContainer size="sm">
            <DialogClose asChild><Button size="sm" variant="borderless" text={text(context).cancel} /></DialogClose>
            <DialogClose asChild><Button size="sm" text={text(context).save} /></DialogClose>
          </ButtonContainer>
        </DialogContent>
      </Dialog>
    ),
  },
  {
    name: "Confirmation with footer close",
    render: (context) => (
      <Dialog>
        <DialogTrigger asChild><Button variant="destructive" size="sm" text={text(context).archive} /></DialogTrigger>
        <DialogContent closeLabel={text(context).close} showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{text(context).confirm}</DialogTitle>
            <DialogDescription>{text(context).confirmBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter closeLabel={text(context).cancel} showCloseButton>
            <DialogClose asChild><Button variant="destructive" text={text(context).archive} /></DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ),
  },
  {
    name: "Palette motion",
    render: (context) => (
      <Dialog>
        <DialogTrigger asChild><Button variant="outline" size="sm" text="⌘K" /></DialogTrigger>
        <DialogContent closeLabel={text(context).close} motion="palette">
          <DialogTitle>{text(context).rename}</DialogTitle>
          <Typo.Caption tone="secondary">--motion-palette · --motion-scale-palette</Typo.Caption>
        </DialogContent>
      </Dialog>
    ),
  },
  { name: "Wide reader (size xl, scroll-body, maxHeight 3/5)", render: (context) => <ReaderDialog context={context} /> },
];
