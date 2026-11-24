import { useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../Button";
import { ButtonContainer } from "../ButtonContainer";
import { Field, FieldLabel } from "../Field";
import { Input } from "../Input";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./Dialog";

const COPY = {
  "en-US": {
    title: "Add computer", fields: ["Name", "SSH address", "Port", "Key file", "Folder", "Model"],
    cancel: "Cancel", add: "Add", close: "Close",
  },
  "ko-KR": {
    title: "컴퓨터 추가", fields: ["이름", "SSH 주소", "포트", "키 파일", "작업 폴더", "모델"],
    cancel: "취소", add: "추가", close: "닫기",
  },
} as const;

export function ScrollingDialogDemo({ locale }: ShowcaseRenderContext) {
  const copy = COPY[locale];
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setCard} style={{ position: "relative", height: 320, overflow: "hidden", borderRadius: "var(--radius-popover)",
      border: "var(--border-hairline) solid var(--line)" }}>
      {card ? (
        <Dialog open modal={false}>
          <DialogContent container={card} closeLabel={copy.close}>
            <DialogHeader><DialogTitle>{copy.title}</DialogTitle></DialogHeader>
            {copy.fields.map((field, index) => {
              const id = `ds-dialog-scroll-${index + 1}`;
              return <Field key={id}><FieldLabel htmlFor={id}>{field}</FieldLabel><Input id={id} /></Field>;
            })}
            <DialogFooter>
              <ButtonContainer size="default" justify="end">
                <DialogClose asChild><Button type="button" variant="outline" text={copy.cancel} /></DialogClose>
                <Button type="button" text={copy.add} />
              </ButtonContainer>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
