import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../Button";
import { ButtonContainer } from "../ButtonContainer";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./Dialog";

const COPY = {
  "en-US": { title: "Save your changes?", keep: "Keep editing", discard: "Don't save", save: "Save" },
  "ko-KR": { title: "변경 내용을 저장할까요?", keep: "계속 편집", discard: "저장 안 함", save: "저장" },
} as const;

/**
 * The inline-edit unsaved-change confirm: a header with only a title and the actions. It keeps the
 * height of a confirmation with a one-line description, with the title centred, instead of a strip.
 */
export function TitleOnlyConfirmDemo({ locale }: ShowcaseRenderContext) {
  const copy = COPY[locale];
  return (
    <Dialog>
      <DialogTrigger asChild><Button variant="outline" size="sm" text={copy.title} /></DialogTrigger>
      <DialogContent role="alertdialog" showCloseButton={false} aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{copy.title}</DialogTitle></DialogHeader>
        <DialogFooter>
          <ButtonContainer size="sm" justify="end">
            <DialogClose asChild><Button size="sm" variant="ghost" text={copy.keep} /></DialogClose>
            <DialogClose asChild><Button size="sm" variant="ghost" text={copy.discard} /></DialogClose>
            <DialogClose asChild><Button size="sm" text={copy.save} /></DialogClose>
          </ButtonContainer>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
